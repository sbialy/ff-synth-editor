// Copied from opentracker-synths (https://github.com/opentracker-fw/opentracker-synths, modules/btype/src/btype.cpp, commit eb150a5f741b),
// Copyright (c) 2026 Marcin Spoczynski, MIT licence, see licenses/LICENSE-OpenTracker-synths-MIT.txt. Not modified, except this notice.
// B-Type engine (see btype.h).
//
// A channel's divider gives an event rate of clock / (N + 1) = 2 x the tone's
// pitch. Pure is a band-limited square at that pitch (va::vcoFrame, 50 %);
// a distortion takes, at each event, the next bit of its counters (the 4-, 5-
// and 9-bit ones from chip_dsp's tables, indexed by the clocks counted: N + 1
// a step, so a divider whose step shares no factor with a counter's period
// runs through all of it; the 17-bit one stepped once an event), ANDed for
// the pairs; the bit is held until the next event (naive: the gating is the
// sound). Hi-Pass is the output less itself 1 / HP Freq earlier: for the
// pure square a second band-limited square on the phase moved back; for the
// distortions the bit that many events back (a history of the last 32
// output bits; the delay counted in events and their fraction, up to 31): a
// comb with its notches at HP Freq's multiples. Each channel is a unipolar signal u (0..1); the two mix by Level
// (u1 + l2 u2) / (1 + l2), times the 4-bit envelope (stepped at its 1/60 s
// frames, or smooth with Bits Off), on a DAC of DAC Bits (8: clean) less the
// mean on the same steps (Hi-Pass: the difference on the steps). Pitch, the CHIP tricks (the block split at their
// ticks), glide and the envelope run at block rate.
#include "btype.h"

#include <cstring>

#include "audio/chip_dsp.h"
#include "audio/va_dsp.h"

#if defined(__GNUC__) && !defined(__clang__)
#define BTYPE_PER_BLOCK __attribute__((optimize("Os")))
#else
#define BTYPE_PER_BLOCK
#endif

namespace ot {
namespace audio {
namespace btype {

namespace {

using namespace ot::audio::va;
namespace ch = ot::audio::chip;

constexpr float kTrim = 0.92f;          // DAC output (+-1) -> slot bus (the ACD Init level)
constexpr float kFrame = kSampleRate / 60.0f;   // frames of a 1/60 s envelope step
constexpr int kMaxEvents = 4;           // divider events a frame at most
const float kClockHz[3] = {15600.0f, 64000.0f, 1789790.0f};

// The counters a distortion reads (bit 0: 4-bit, 1: 5-bit, 2: 9-bit, 3: 17-bit).
constexpr uint8_t kUses[kDistCount] = {0, 1, 2, 4, 8, 3, 10, 6};
// The share of events with the output high (the AND of the counters' ones).
const float kMean[kDistCount] = {0.5f, 8.0f / 15.0f, 16.0f / 31.0f, 256.0f / 511.0f, 0.5f,
                                 (8.0f / 15.0f) * (16.0f / 31.0f), 0.5f * (16.0f / 31.0f), (16.0f / 31.0f) * (256.0f / 511.0f)};

struct Chan {
    float ph, z;         // the pure square's phase and held frame; the counters' event phase
    float zd;            // the delayed square's held frame (Hi-Pass)
    uint32_t hist;       // the output bits of the last 32 events (bit 0: now): the Hi-Pass delay
    uint16_t i9;         // counter positions
    uint8_t i5, i4;
    uint32_t l17;
    uint8_t bit, hi, hid, pad;
};
constexpr int kMaxBack = 31;   // the Hi-Pass delay reaches 31 events back at most

struct SlotState {
    uint32_t serial;
    uint32_t seed;               // Poly Reset Off: where the next note's counters start
    uint8_t valid, hasLast, glideMode, clock;
    uint8_t dist[2], tuning, reset;
    uint8_t hp, envBits, bits, lvSet;
    float hpT;                   // the high-pass delay (s)
    float l20, l21;              // channel 2 level at the block start / end
    float detune;                // divider steps
    float att, dec, rel;         // frames a level (0: at once)
    float sustain;               // 0..15
    float glideC, lastPitch;
    ch::TricksCfg tc;
};
static_assert(sizeof(SlotState) <= kSynthSlotScratchBytes, "B-Type slot state");

struct VoiceState {
    Chan c[2];
    float env;                   // 0..15
    float pitch, target;
    ch::Tricks tr;
    uint8_t stage, started, glide, rising;
};
static_assert(sizeof(VoiceState) <= kSynthVoiceStateBytes, "B-Type voice state");

enum Stage : uint8_t { kIdle = 0, kAttack_, kDecay_, kRelease_ };

// The counters' output bit for a distortion (positions as they are).
inline uint32_t distBit(int dist, const Chan& c) {
    const uint8_t u = kUses[dist];
    uint32_t b = 1;
    if (u & 1) b &= ch::kPoly4.bit(c.i4);
    if (u & 2) b &= ch::kPoly5.bit(c.i5);
    if (u & 4) b &= ch::kPoly9.bit(c.i9);
    if (u & 8) b &= c.l17 & 1u;
    return b;
}
// The clocks of an event modulo each counter's period.
struct Steps {
    uint32_t s4, s5, s9;
};
inline Steps stepsOf(uint32_t step) { return Steps{step % 15u, step % 31u, step % 511u}; }
// The events of one frame (k of them) on a channel, each output bit into the
// history. kD: the distortion (its counters known at compile time).
template <int kD>
__attribute__((noinline)) void eventsT(Chan& c, int k, const Steps& st) {
    constexpr uint8_t u = kUses[kD];
    if (k > kMaxEvents) k = kMaxEvents;
    while (k-- > 0) {
        if (u & 1) {
            const uint32_t i = c.i4 + st.s4;
            c.i4 = uint8_t(i >= 15u ? i - 15u : i);
        }
        if (u & 2) {
            const uint32_t i = c.i5 + st.s5;
            c.i5 = uint8_t(i >= 31u ? i - 31u : i);
        }
        if (u & 4) {
            const uint32_t i = c.i9 + st.s9;
            c.i9 = uint16_t(i >= 511u ? i - 511u : i);
        }
        if (u & 8) {
            const uint32_t fb = (c.l17 ^ (c.l17 >> 3)) & 1u;   // Lfsr17 (x^17 + x^14 + 1)
            c.l17 = (c.l17 >> 1) | (fb << 16);
        }
        uint32_t b = 1;
        if (u & 1) b &= ch::kPoly4.bit(c.i4);
        if (u & 2) b &= ch::kPoly5.bit(c.i5);
        if (u & 4) b &= ch::kPoly9.bit(c.i9);
        if (u & 8) b &= c.l17 & 1u;
        c.bit = uint8_t(b);
        c.hist = (c.hist << 1) | b;
    }
}
using Events = void (*)(Chan&, int, const Steps&);
const Events kEvents[kDistCount] = {eventsT<0>, eventsT<1>, eventsT<2>, eventsT<3>, eventsT<4>, eventsT<5>, eventsT<6>, eventsT<7>};

// The Hi-Pass delay of D frames in events: K = D x the event rate; at event
// phase ph the output D frames ago is the bit floor(K) events back, one more
// while ph < frac(K) (the last event is nearer than the delay's fraction).
struct Back {
    uint32_t k0;
    float fk;
};
inline Back backOf(float frames, float rate) {
    float K = frames * rate;
    if (K > float(kMaxBack - 1)) K = float(kMaxBack - 1);
    const uint32_t k0 = uint32_t(K);
    return Back{k0, K - float(k0)};
}
inline float bitBack(const Chan& c, float ph, const Back& b) { return float((c.hist >> (b.k0 + (ph < b.fk ? 1u : 0u))) & 1u); }
// One chunk of a channel into u (added: x w), its delayed copy into ud when Hi-Pass.
// rate: events a frame (ramped); step: clocks an event; back: the Hi-Pass delay.
template <bool kHp>
__attribute__((noinline)) void polyPass(float* u, float* ud, uint32_t n, Chan& c, int dist, Lin rate, uint32_t step, Back back,
                                        Lin w) {
    float ph = c.ph, r = rate.v, wv = w.v;
    const float dr = rate.d, dw = w.d;
    const Steps st = stepsOf(step);
    const Events ev = kEvents[dist];
    float bit = float(c.bit);
    for (uint32_t i = 0; i < n; ++i) {
        ph += r;
        if (ph >= 1.0f) {
            const int k = int(ph);
            ph -= float(k);
            ev(c, k, st);
            bit = float(c.bit);
        }
        u[i] += wv * bit;
        if (kHp) ud[i] += wv * bitBack(c, ph, back);
        r += dr;
        wv += dw;
    }
    c.ph = ph;
}
// The pure square (0..1) at dt cycles a frame; with Hi-Pass its copy delay cycles back.
template <bool kHp>
__attribute__((noinline)) void purePass(float* u, float* ud, uint32_t n, Chan& c, Lin dt, float delay, Lin w) {
    float p = c.ph, z = c.z, zd = c.zd, d = dt.v, wv = w.v;
    const float dd = dt.d, dw = w.d;
    bool hi = c.hi, hid = c.hid;
    for (uint32_t i = 0; i < n; ++i) {
        const float pb = p;
        const float y = 0.5f * ch::pulseFrame(p, z, hi, d, 0.5f) + 0.5f;
        u[i] += wv * y;
        if (kHp) {
            // The same square `delay` cycles back, band-limited on its own held frame.
            float q = pb - delay;
            q -= float(int(q + 8.0f) - 8);
            ud[i] += wv * (0.5f * ch::pulseFrame(q, zd, hid, d, 0.5f) + 0.5f);
        }
        d += dd;
        wv += dw;
    }
    c.ph = p;
    c.z = z;
    c.zd = zd;
    c.hi = hi;
    c.hid = hid;
}
// The DAC: u e on M steps less the mean on the same steps (Hi-Pass: the
// difference u - ud, signed, on the steps: the comb is ahead of the DAC), x the gain.
template <bool kHp>
__attribute__((noinline)) void dacPass(float* L, float* R, const float* u, const float* ud, float em, float dq, Lin g) {
    float gv = g.v;
    for (uint32_t i = 0; i < kBlock; ++i) {
        float q;
        if (kHp) {
            const float x = (u[i] - ud[i]) * em;
            q = float(int(x + (x >= 0.0f ? 0.5f : -0.5f)));
        } else {
            q = float(int(u[i] * em + 0.5f)) - dq;
        }
        const float y = q * gv;
        L[i] += y;
        R[i] += y;
        gv += g.d;
    }
}
// The common case in one pass: the channels all distortions (no buffers),
// mixed, the comb and the DAC (on M steps), x the gain, into L / R. The
// output only changes at an event (a few a frame at most).
struct PolyCh {
    Chan* c;
    Events ev;
    float r, dr, w, dw;
    Steps st;
    Back back;
};
template <bool kTwo, bool kHp>
__attribute__((noinline)) void fusedPass(float* L, float* R, uint32_t n, PolyCh a, PolyCh b, float em, float dq, float& gv, float dg) {
    Chan& ca = *a.c;
    Chan& cb = *b.c;
    float pa = ca.ph, pb = kTwo ? cb.ph : 0.0f;
    // Each channel's output (bit, less the delayed bit with Hi-Pass) changes
    // only at its events and where its phase crosses the delay's fraction:
    // the two candidate delayed bits are taken at the events.
    float ba = float(ca.bit), bb = kTwo ? float(cb.bit) : 0.0f;
    float a0 = 0.0f, a1 = 0.0f, b0 = 0.0f, b1 = 0.0f;
    auto backs = [](const Chan& c, const Back& k, float& d0, float& d1) {
        d0 = float((c.hist >> k.k0) & 1u);
        d1 = float((c.hist >> (k.k0 + 1u)) & 1u);
    };
    if (kHp) {
        backs(ca, a.back, a0, a1);
        if (kTwo) backs(cb, b.back, b0, b1);
    }
    bool sa = kHp && pa < a.back.fk, sb = kHp && kTwo && pb < b.back.fk;
    const bool ramp = a.dw != 0.0f || (kTwo && b.dw != 0.0f);
    float g = gv, ra = a.r, wa = a.w, rb = b.r, wb = b.w;
    constexpr float kRound = 12582912.0f;   // 1.5 x 2^23: (v + kRound) - kRound rounds to an integer
    float q = 0.0f;
    bool dirty = true;
    for (uint32_t i = 0; i < n; ++i) {
        pa += ra;
        if (pa >= 1.0f) {
            const int k = int(pa);
            pa -= float(k);
            a.ev(ca, k, a.st);
            ba = float(ca.bit);
            if (kHp) backs(ca, a.back, a0, a1);
            dirty = true;
        }
        if (kHp) {
            const bool t = pa < a.back.fk;
            dirty = dirty || t != sa;
            sa = t;
        }
        if (kTwo) {
            pb += rb;
            if (pb >= 1.0f) {
                const int k = int(pb);
                pb -= float(k);
                b.ev(cb, k, b.st);
                bb = float(cb.bit);
                if (kHp) backs(cb, b.back, b0, b1);
                dirty = true;
            }
            if (kHp) {
                const bool t = pb < b.back.fk;
                dirty = dirty || t != sb;
                sb = t;
            }
            rb += b.dr;
        }
        if (dirty || ramp) {
            float x = wa * (kHp ? ba - (sa ? a1 : a0) : ba);
            if (kTwo) x += wb * (kHp ? bb - (sb ? b1 : b0) : bb);
            q = ((x * em + kRound) - kRound) - dq;
            dirty = false;
        }
        const float y = q * g;
        L[i] += y;
        R[i] += y;
        g += dg;
        ra += a.dr;
        if (ramp) {
            wa += a.dw;
            if (kTwo) wb += b.dw;
        }
    }
    ca.ph = pa;
    if (kTwo) cb.ph = pb;
    gv = g;
}

__attribute__((noinline)) void cleanPass(float* L, float* R, const float* u, const float* ud, float e, float mean, Lin g) {
    float gv = g.v;
    for (uint32_t i = 0; i < kBlock; ++i) {
        const float y = (u[i] - (ud ? ud[i] : mean)) * e * gv;
        L[i] += y;
        R[i] += y;
        gv += g.d;
    }
}

BTYPE_PER_BLOCK void refresh(SlotState& S, const SynthParams& p) {
    const float* E = p.end;
    S.clock = uint8_t(enumOf(E[kClock], k179M));
    S.dist[0] = uint8_t(enumOf(E[kDistortion], kPoly5x9));
    S.dist[1] = uint8_t(enumOf(E[kOsc2Distortion], kPoly5x9));
    S.tuning = uint8_t(enumOf(E[kTuning], kFine));
    S.reset = E[kPolyReset] >= 0.5f;
    S.hp = E[kHiPass] >= 0.5f;
    S.hpT = 1.0f / clampf(E[kHpFreq], 50.0f, 8000.0f);
    S.detune = float(int(clampf(E[kOsc2Detune], -8.0f, 8.0f) + 8.5f) - 8);
    S.att = float(enumOf(E[kAttack], 15)) * kFrame;
    S.dec = float(enumOf(E[kDecay], 15)) * kFrame;
    S.rel = float(enumOf(E[kRelease], 15)) * kFrame;
    S.sustain = float(enumOf(E[kSustain], 15));
    S.envBits = E[kEnvBits] >= 0.5f;
    S.bits = uint8_t(enumOf(E[kDacBits], 8));
    if (S.bits < 4) S.bits = 4;
    ch::setTricks(S.tc, enumOf(E[kArpMode], ch::kArpCustom), int(E[kArpNote2] + 0.5f), int(E[kArpNote3] + 0.5f),
                  enumOf(E[kArpRate], ch::kDiv128), E[kVibRate], E[kVibDepth], E[kVibDelay], E[kSlideStart], E[kSlideTime]);
    S.glideMode = uint8_t(enumOf(E[kGlideMode], kLegatoOverlap));
    const float gt = clampf(E[kGlideTime], 0.0f, 3.0f);
    S.glideC = gt < 0.0005f ? 0.0f : fastExp2(-4.3219281f * kBlockT / gt);
    S.serial = p.serial;
    S.valid = 1;
}

inline float noteHz(float n) { return 440.0f * fastExp2((n - 69.0f) * (1.0f / 12.0f)); }

inline void glideTo(float& x, float t, float c) {
    if (x == t) return;
    x = t + (x - t) * c;
    if (__builtin_fabsf(x - t) < 0.01f) x = t;
}

// A channel's event rate (a frame), its clocks an event and its tone (Hz):
// from the divider N of the note (tunedHz), channel 2 detune divider steps away.
struct Tone {
    float hz, rate;
    uint32_t step;
};
inline Tone toneOf(float N, float clk, float detune) {
    float m = N + detune;
    if (m < 0.0f) m = 0.0f;
    float f = clk / (2.0f * (m + 1.0f));
    if (f > 0.45f * kSampleRate) f = 0.45f * kSampleRate;
    Tone t;
    t.hz = f;
    t.rate = 2.0f * f * kInvFs;
    t.step = uint32_t(m + 1.5f);
    return t;
}

class BtypeEngine final : public ISynthEngine {
public:
    int32_t id() const override { return kEngineId; }
    const char* name() const override { return "BTYPE"; }

    void slotReset(SynthSlotScratch& sc) override { std::memset(sc.bytes, 0, sizeof(sc.bytes)); }
    void setTempo(float bpm) override { bpm_ = bpm; }

    BTYPE_PER_BLOCK void prepare(SynthSlotScratch& sc, const SynthParams& p) override {
        if (p.count < kParamCount) return;
        SlotState& S = sc.as<SlotState>();
        if (!S.valid || S.serial != p.serial || p.moving) refresh(S, p);
        const float l = clampf(p.end[kOsc2Level], 0.0f, 1.0f);
        S.l20 = S.lvSet ? S.l21 : l;
        S.l21 = l;
        S.lvSet = 1;
    }

    BTYPE_PER_BLOCK void noteOn(SynthVoice& v, const SynthParams& p, const SynthNote& n) override {
        if (p.count < kParamCount) return;
        SlotState& S = v.slotScratch->as<SlotState>();
        VoiceState& V = v.as<VoiceState>();
        if (!S.valid || S.serial != p.serial) refresh(S, p);
        const bool held = n.reused && V.started;
        const int mode = S.glideMode;
        const bool legato = held && (mode == kLegato || mode == kLegatoOverlap) && n.overlap && V.stage != kRelease_;
        const bool alwaysGlide = mode == kAlways || mode == kLegato;
        V.target = n.pitch;
        V.glide = S.glideC > 0.0f && (held || S.hasLast) && !n.fxGlide && (alwaysGlide || n.overlap);
        if (!V.glide) V.pitch = n.pitch;
        else if (!held) V.pitch = S.lastPitch;
        S.lastPitch = n.pitch;
        S.hasLast = 1;
        if (!legato) {
            V.stage = kAttack_;   // from the current level
            ch::tricksStart(V.tr, S.tc, bpm_);
            // The counters: from the start (Poly Reset) or wherever the slot's free clock is.
            S.seed = S.seed * 1664525u + 1013904223u;
            for (int k = 0; k < 2; ++k) {
                Chan& c = V.c[k];
                const uint32_t s = S.reset ? 0u : (S.seed >> (8 + 4 * k));
                c.i4 = uint8_t(s % 15u);
                c.i5 = uint8_t(s % 31u);
                c.i9 = uint16_t(s % 511u);
                c.l17 = S.reset ? 0x1FFFFu : ((s & 0x1FFFFu) | 1u);
                c.bit = uint8_t(distBit(S.dist[k], c));
                c.hist = c.bit ? 0xFFFFFFFFu : 0u;
                if (!n.reused || (S.reset && S.dist[k] != kPure)) c.ph = 0.0f;   // Poly Reset: the event clock too
                if (!n.reused) {   // a fresh voice: the squares from the start (a retrigger keeps them running)
                    c.z = c.zd = 0.0f;
                    c.hi = c.hid = 1;
                }
            }
        }
        V.started = 1;
        v.level = n.reused ? V.env * (1.0f / 15.0f) : 1.0f;
    }

    void noteOff(SynthVoice& v, const SynthParams&) override {
        VoiceState& V = v.as<VoiceState>();
        if (V.stage != kIdle) V.stage = kRelease_;
    }

    BTYPE_PER_BLOCK bool render(SynthVoice& v, const SynthParams& p, float g0, float gInc, float* L, float* R) override {
        VoiceState& V = v.as<VoiceState>();
        if (!V.started || p.count < kParamCount) {
            v.level = 0.0f;
            return false;
        }
        const SlotState& S = v.slotScratch->as<SlotState>();
        // The envelope (held for the block: its steps are the sound).
        bool done = false;
        switch (V.stage) {
            case kAttack_:
                V.rising = 1;
                if (ch::stepEnvTo(V.env, 15.0f, S.att, float(kBlock))) V.stage = kDecay_;
                break;
            case kDecay_:
                V.rising = V.env < S.sustain;
                ch::stepEnvTo(V.env, S.sustain, S.dec, float(kBlock));
                break;
            case kRelease_:
                V.rising = 0;
                if (ch::stepEnvTo(V.env, 0.0f, S.rel, float(kBlock))) done = true;
                break;
            default: done = true; break;
        }
        float eg = ch::env4(V.env, S.envBits, V.rising);
        if (V.stage == kDecay_ && S.sustain == 0.0f && V.env == 0.0f) done = true;
        if (done) eg = 0.0f;
        // Pitch at both block ends.
        const float pit0 = V.pitch;
        glideTo(V.pitch, V.target, V.glide ? S.glideC : 0.0f);
        const float base0 = pit0 + v.bendStart, base1 = V.pitch + v.bend;
        constexpr float kInvB = 1.0f / float(kBlock);
        const bool ticking = ch::tricksTick(S.tc);
        ch::tricksRate(V.tr, S.tc, bpm_);
        const bool two = S.l20 > 0.0f || S.l21 > 0.0f;
        const float clk = S.tuning == kFine ? kClockHz[k179M] : kClockHz[S.clock];
        const Lin w2 = lin(S.l20 / (1.0f + S.l20), S.l21 / (1.0f + S.l21)), w1 = lin(1.0f / (1.0f + S.l20), 1.0f / (1.0f + S.l21));
        // (the channels' means at the block's middle weights)
        const float mean = S.hp ? 0.0f
                                : kMean[S.dist[0]] * (w1.v + w1.d * 64.0f) + (two ? kMean[S.dist[1]] * (w2.v + w2.d * 64.0f) : 0.0f);
        const float gEnd = done ? 0.0f : (g0 + gInc * float(kBlock)) * kTrim;
        const float M = float((1 << S.bits) - 1), em = eg * M;
        // Distortions only, on a DAC: one pass, no buffers.
        const bool fused = S.bits < 8 && S.dist[0] != kPure && (!two || S.dist[1] != kPure);
        float gv = g0 * kTrim / M;
        const float dg = (gEnd / M - gv) * kInvB;
        float u[kBlock], ud[kBlock];
        if (!fused) {
            std::memset(u, 0, sizeof(u));
            if (S.hp) std::memset(ud, 0, sizeof(ud));
        }
        uint32_t at = 0;
        while (at < kBlock) {
            const uint32_t m = ticking ? V.tr.tick.chunk(kBlock - at) : kBlock - at;
            const float o0 = ch::tricksOffset(V.tr, S.tc, 0.0f), o1 = ch::tricksOffset(V.tr, S.tc, float(m) * kInvFs);
            const float n0 = base0 + (base1 - base0) * float(at) * kInvB + o0, n1 = base0 + (base1 - base0) * float(at + m) * kInvB + o1;
            const float inv = 1.0f / float(m), fa = float(at);
            float N0, N1;
            tunedHz(noteHz(n0), S.clock, S.tuning, &N0);
            tunedHz(noteHz(n1), S.clock, S.tuning, &N1);
            PolyCh pc[2];
            for (int k = 0; k < (two ? 2 : 1); ++k) {
                const Lin& wl = k ? w2 : w1;
                const Lin w{wl.v + wl.d * fa, wl.d};
                const float det = k ? S.detune : 0.0f;
                const Tone t0 = toneOf(N0, clk, det), t1 = toneOf(N1, clk, det);
                const Back back = backOf(S.hpT * kSampleRate, t1.rate);
                if (fused) {
                    PolyCh& q = pc[k];
                    q.c = &V.c[k];
                    q.ev = kEvents[S.dist[k]];
                    q.r = t0.rate;
                    q.dr = (t1.rate - t0.rate) * inv;
                    q.w = w.v;
                    q.dw = w.d;
                    q.st = stepsOf(t1.step);
                    q.back = back;
                    continue;
                }
                float* d = S.hp ? ud + at : nullptr;
                if (S.dist[k] == kPure) {
                    const float a = t0.hz * kInvFs, b = t1.hz * kInvFs;
                    (d ? purePass<true> : purePass<false>)(u + at, d, m, V.c[k], Lin{a, (b - a) * inv}, t1.hz * S.hpT, w);
                } else {
                    (d ? polyPass<true> : polyPass<false>)(u + at, d, m, V.c[k], S.dist[k], Lin{t0.rate, (t1.rate - t0.rate) * inv},
                                                          t1.step, back, w);
                }
            }
            if (fused) {
                const float dq = S.hp ? 0.0f : float(int(mean * em + 0.5f));   // (the codes round to nearest)
                if (two) (S.hp ? fusedPass<true, true> : fusedPass<true, false>)(L + at, R + at, m, pc[0], pc[1], em, dq, gv, dg);
                else (S.hp ? fusedPass<false, true> : fusedPass<false, false>)(L + at, R + at, m, pc[0], pc[0], em, dq, gv, dg);
            }
            const bool t = ticking && V.tr.tick.advance(m);
            ch::tricksAdvance(V.tr, S.tc, m, t);
            at += m;
        }
        // The DAC: u e on 2^Bits - 1 steps less the mean on the same steps (Hi-Pass: the difference).
        if (fused) {
            // (done in the pass)
        } else if (S.bits >= 8) {
            cleanPass(L, R, u, S.hp ? ud : nullptr, eg, mean, lin(g0 * kTrim, gEnd));
        } else {
            const Lin g = lin(g0 * kTrim / M, gEnd / M);
            if (S.hp) dacPass<true>(L, R, u, ud, em, 0.0f, g);
            else dacPass<false>(L, R, u, nullptr, em, float(int(mean * em + 0.5f)), g);
        }
        v.level = eg;
        if (done) {
            V.started = 0;
            V.stage = kIdle;
            V.env = 0.0f;
            v.level = 0.0f;
            return false;
        }
        return true;
    }

private:
    float bpm_ = 120.0f;
};

BtypeEngine gBtype;

}  // namespace

float clockHz(int clock) { return kClockHz[clock < 0 ? 0 : (clock > 2 ? 2 : clock)]; }

float tunedHz(float hz, int clock, int tuning, float* divider) {
    const float clk = tuning == kFine ? kClockHz[k179M] : clockHz(clock);
    float N = clk / (2.0f * hz) - 1.0f;
    if (tuning != kFree) {
        const float top = tuning == kFine ? 65535.0f : 255.0f;
        N = float(int(N + 0.5f));
        N = N < 0.0f ? 0.0f : (N > top ? top : N);
    } else if (N < 0.0f) {
        N = 0.0f;
    }
    if (divider) *divider = N;
    return clk / (2.0f * (N + 1.0f));
}

ISynthEngine* engine() { return &gBtype; }

}  // namespace btype
}  // namespace audio
}  // namespace ot
