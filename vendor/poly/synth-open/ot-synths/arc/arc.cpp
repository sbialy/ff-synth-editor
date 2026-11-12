// Copied from opentracker-synths (https://github.com/opentracker-fw/opentracker-synths, modules/arc/src/arc.cpp, commit eb150a5f741b),
// Copyright (c) 2026 Marcin Spoczynski, MIT licence, see licenses/LICENSE-OpenTracker-synths-MIT.txt. Not modified, except this notice.
// Arc-Type engine (see arc.h).
//
// The operators are fm_dsp.h's kernel (FM4's, lifted): phases 1..4, each
// modulated by the outputs routed into it this frame, operator 1 by its last
// two outputs (Feedback); the carriers' mean goes into a block buffer. The
// envelopes run in dB at block rate (the attack an exponential approach to
// 0 dB, the decays and the release linear in dB at their rates, Rate Scaling
// adding rate steps with the note; the loop modes act at -48 dB) and with the
// LFO's amplitude modulation become one gain per operator, ramped across the
// block. The LFO's pitch depth, glide and the CHIP arp / slide set the
// increments per chunk (the block split at the arp's ticks). Then the DAC
// (9-bit, or the ladder: the 9-bit codes with uneven top steps and a gap
// around zero), the Aux voice (a band-limited square or a 15-bit noise
// register, a 4-bit stepped decay), the framework's gain.
#include "arc.h"

#include <cstring>

#include "audio/chip_dsp.h"
#include "audio/fm_dsp.h"
#include "audio/va_dsp.h"

#if defined(__GNUC__) && !defined(__clang__)
#define ARC_PER_BLOCK __attribute__((optimize("Os")))
#else
#define ARC_PER_BLOCK
#endif

namespace ot {
namespace audio {
namespace arc {

namespace {

using namespace ot::audio::va;
namespace fm = ot::audio::fm;
namespace ch = ot::audio::chip;

constexpr float kTrim = 0.5f;           // voice -> slot bus (the ACD Init level)
constexpr float kSilentDb = 96.0f;      // an operator below this is idle
constexpr float kLoopDb = 48.0f;        // where the loop modes act
constexpr float kAttEndDb = 0.5f;       // the attack's end
constexpr float kAttLog2 = -7.58496f;   // log2(kAttEndDb / kSilentDb): 96 dB -> 0.5 dB over the attack
constexpr float kDbToLog2 = 1.0f / 6.0206f;
constexpr float kFrame = kSampleRate / 60.0f;   // the Aux decay's frames
constexpr float kGap = 2.0f / 256.0f;   // the ladder's crossover step (2 LSB of 9 bits)
const float kLfoTab[9] = {0.0f, 4.0f, 5.5f, 7.0f, 9.0f, 12.0f, 20.0f, 40.0f, 72.0f};
const float kPmsTab[8] = {0.0f, 4.0f, 8.0f, 12.0f, 20.0f, 30.0f, 50.0f, 80.0f};
const float kAmsTab[4] = {0.0f, 1.4f, 5.9f, 11.8f};
const float kDtTab[4] = {0.0f, 3.0f, 6.0f, 9.0f};

enum Stage : uint8_t { kIdle = 0, kAtt, kDec1, kDec2, kRel };

struct OpCfg {
    float ratio;          // Multiple x Detune (at the last note)
    float level, ams;     // 0..1, dB at a full LFO swing
    float ar, d1r, d2r, rr;   // rate indices (Rate Scaling added per note)
    float d1l;            // dB
    uint8_t loop, rs, dt, pad;
};
struct SlotState {
    uint32_t serial;
    uint8_t valid, hasLast, glideMode, alg;
    uint8_t dac, auxWave, lfoOn, pad;
    OpCfg o[fm::kOps];
    float fb;
    float pms;            // cents
    float lfoInc, lfoPh, lfo0, lfo1;
    float auxLevel, auxSemi, auxPer;   // Aux: level, octave (semitones), frames a level (0 holds)
    float glideC, lastPitch;
    ch::TricksCfg tc;
};
static_assert(sizeof(SlotState) <= kSynthSlotScratchBytes, "Arc-Type slot state");

struct VoiceState {
    fm::Ops ops;
    float att[fm::kOps];  // dB attenuation
    float amp[fm::kOps];  // operator gains at the last block's end
    float pitch, target;
    float auxP, auxZ, auxEnv, auxN;    // Aux: phase, held frame, level 0..15, noise clock
    uint32_t lfsr;
    ch::Tricks tr;
    uint8_t stage[fm::kOps];
    uint8_t flip;         // bit k: operator k's loop runs inverted / mirrored up
    uint8_t started, glide, auxHi, rel, ampSet, pad[2];
};
static_assert(sizeof(VoiceState) <= kSynthVoiceStateBytes, "Arc-Type voice state");

// The kernel's per-sample hook: the DAC (Off / 9-bit / ladder) on the
// carriers' mean, then the framework's gain x trim, into L / R.
struct Out {
    float *L, *R;
    float g, dg;
    int mode;
    void operator()(uint32_t i, float y) {
        if (mode == kDac9) {
            y = ch::quantQ(y, 256.0f, 1.0f / 256.0f);
        } else if (mode == kDacLadder) {
            y = ch::ladder(y, 9, 1.0f);
            y += y > 0.0f ? kGap : (y < 0.0f ? -kGap : 0.0f);
        }
        const float o = y * g;
        L[i] += o;
        R[i] += o;
        g += dg;
    }
};
// One chunk: the kernel with the hook as a local (its gain in a register).
template <int kA>
__attribute__((noinline)) void runKernel(fm::Ops& ops, fm::OpRamp& r, uint32_t n, Out& o) {
    Out h = o;
    fm::kernel<kA, Out>(ops, r, n, h);
    o.g = h.g;
}
using Kernel = void (*)(fm::Ops&, fm::OpRamp&, uint32_t, Out&);
const Kernel kKernels[8] = {runKernel<0>, runKernel<1>, runKernel<2>, runKernel<3>,
                            runKernel<4>, runKernel<5>, runKernel<6>, runKernel<7>};

// A rate index (fractional after Rate Scaling) on the tables.
inline float attackOf(float r) { return 10.0f * fastExp2(-13.2877f * (r - 1.0f) * (1.0f / 30.0f)); }   // 10 s .. 1 ms
inline float decayOf(float r) { return 20.0f * fastExp2(-13.2877f * (r - 1.0f) * (1.0f / 30.0f)); }    // 20 s .. 2 ms (48 dB)

ARC_PER_BLOCK void refresh(SlotState& S, const SynthParams& p) {
    const float* E = p.end;
    S.alg = uint8_t(enumOf(E[kAlgorithm], 7));
    S.fb = 0.0625f * float(enumOf(E[kFeedback], 7));
    S.dac = uint8_t(enumOf(E[kDac], kDacLadder));
    for (int k = 0; k < fm::kOps; ++k) {
        OpCfg& c = S.o[k];
        c.ratio = mulOf(enumOf(E[op(k, kMul)], 15));
        c.dt = uint8_t(enumOf(E[op(k, kDt)] + 3.0f, 6));
        c.level = clampf(E[op(k, kLevel)], 0.0f, 1.0f);
        c.rs = uint8_t(enumOf(E[op(k, kRs)], 3));
        c.ar = float(enumOf(E[op(k, kAr)], 31));
        c.d1r = float(enumOf(E[op(k, kD1r)], 31));
        c.d1l = d1lDb(enumOf(E[op(k, kD1l)], 15));
        c.d2r = float(enumOf(E[op(k, kD2r)], 31));
        c.rr = float(enumOf(E[op(k, kRr)], 15));
        c.loop = uint8_t(enumOf(E[op(k, kLoop)], kRepeatInv));
        c.ams = kAmsTab[enumOf(E[op(k, kAms)], 3)];
    }
    const int lr = enumOf(E[kLfoRate], 8);
    S.lfoOn = lr > 0;
    S.lfoInc = kLfoTab[lr] * kBlockT;
    S.pms = kPmsTab[enumOf(E[kPms], 7)];
    S.auxWave = uint8_t(enumOf(E[kAuxWave], kAuxNoise));
    S.auxLevel = clampf(E[kAuxLevel], 0.0f, 1.0f);
    S.auxSemi = 12.0f * float(enumOf(E[kAuxOctave] + 2.0f, 4) - 2);
    S.auxPer = float(enumOf(E[kAuxDecay], 15)) * kFrame;
    ch::setTricks(S.tc, enumOf(E[kArpMode], ch::kArpCustom), int(E[kArpNote2] + 0.5f), int(E[kArpNote3] + 0.5f),
                  enumOf(E[kArpRate], ch::kDiv128), 5.0f, 0.0f, 0.0f, E[kSlideStart], E[kSlideTime]);
    S.glideMode = uint8_t(enumOf(E[kGlideMode], kLegatoOverlap));
    const float gt = clampf(E[kGlideTime], 0.0f, 3.0f);
    S.glideC = gt < 0.0005f ? 0.0f : fastExp2(-4.3219281f * kBlockT / gt);
    S.serial = p.serial;
    S.valid = 1;
}

// One block of an operator's envelope (dB); rs: the rate steps Rate Scaling adds.
ARC_PER_BLOCK void envStep(const OpCfg& c, uint8_t& st, float& a, uint8_t& flip, uint8_t bit, float rs) {
    switch (st) {
        case kAtt: {
            if (c.ar <= 0.0f) return;   // AR 0: never starts
            const float t = attackOf(clampf(c.ar + rs, 1.0f, 31.0f));
            if (t <= kBlockT) {
                a = 0.0f;
            } else {
                a *= fastExp2(kAttLog2 * kBlockT / t);
                if (a < kAttEndDb) a = 0.0f;
            }
            if (a == 0.0f) st = kDec1;
            return;
        }
        case kDec1:
        case kDec2: {
            const float r = st == kDec1 ? c.d1r : c.d2r;
            if (r <= 0.0f) {
                if (st == kDec1) st = kDec2;   // D1R 0: straight to the second decay
                return;                       // D2R 0: hold
            }
            const float step = kLoopDb * kBlockT / decayOf(clampf(r + rs, 1.0f, 31.0f));
            if (c.loop == kMirror && (flip & bit)) {
                a -= step;   // mirrored: back up to 0 dB, then down again
                if (a <= 0.0f) {
                    a = 0.0f;
                    flip &= uint8_t(~bit);
                    st = kDec1;
                }
                return;
            }
            a += step;
            if (st == kDec1 && a >= c.d1l) st = kDec2;
            if (c.loop != kLoopOff && a >= kLoopDb) {
                switch (c.loop) {
                    case kRepeat: a = kSilentDb * 0.5f, st = kAtt; break;   // the attack again from -48 dB
                    case kMirror: a = kLoopDb, flip |= bit; break;
                    case kHoldInv: a = kLoopDb, flip |= bit, st = kDec2; break;
                    default: a = 0.0f, flip ^= bit, st = kDec1; break;      // Repeat Inv
                }
                if (c.loop == kHoldInv) return;
            }
            if (a >= kSilentDb) {
                a = kSilentDb;
                st = kIdle;
            }
            return;
        }
        case kRel:
            a += kLoopDb * kBlockT / decayOf(clampf(2.0f * c.rr + 1.0f + rs, 1.0f, 31.0f));
            if (a >= kSilentDb) {
                a = kSilentDb;
                st = kIdle;
            }
            return;
        default: a = kSilentDb; return;
    }
}

inline void glideTo(float& x, float t, float c) {
    if (x == t) return;
    x = t + (x - t) * c;
    if (__builtin_fabsf(x - t) < 0.01f) x = t;
}

// The Aux square (band-limited) or noise, x its stepped level x the gain, added into L / R.
void auxPass(float* L, float* R, uint32_t n, VoiceState& V, int wave, Lin dt, Lin g) {
    if (wave == kAuxSquare) {
        float p = V.auxP, z = V.auxZ;
        bool hi = V.auxHi;
        for (uint32_t i = 0; i < n; ++i) {
            const float y = g.v * vcoFrame<kShPulse>(p, z, hi, dt.v, 0.5f);
            L[i] += y;
            R[i] += y;
            dt.v += dt.d;
            g.v += g.d;
        }
        V.auxP = p;
        V.auxZ = z;
        V.auxHi = hi;
    } else {
        float ph = V.auxN, out = V.auxZ;
        uint32_t s = V.lfsr;
        for (uint32_t i = 0; i < n; ++i) {
            ph += 16.0f * dt.v;   // 16 shifts a cycle
            int k = int(ph);
            ph -= float(k);
            if (k) {
                if (k > 8) k = 8;
                out = ch::lfsrSteps(s, 15, 1, k) ? 1.0f : -1.0f;
            }
            const float y = g.v * out;
            L[i] += y;
            R[i] += y;
            dt.v += dt.d;
            g.v += g.d;
        }
        V.auxN = ph;
        V.auxZ = out;
        V.lfsr = s;
    }
}

class ArcEngine final : public ISynthEngine {
public:
    int32_t id() const override { return kEngineId; }
    const char* name() const override { return "ARCTYPE"; }

    void slotReset(SynthSlotScratch& sc) override { std::memset(sc.bytes, 0, sizeof(sc.bytes)); }
    void setTempo(float bpm) override { bpm_ = bpm; }

    ARC_PER_BLOCK void prepare(SynthSlotScratch& sc, const SynthParams& p) override {
        if (p.count < kParamCount) return;
        SlotState& S = sc.as<SlotState>();
        if (!S.valid || S.serial != p.serial || p.moving) refresh(S, p);
        // The LFO (a triangle per slot).
        float ph = S.lfoPh + S.lfoInc;
        if (ph >= 1.0f) ph -= float(int(ph));
        S.lfoPh = ph;
        S.lfo0 = S.lfo1;
        S.lfo1 = S.lfoOn ? (ph < 0.25f ? 4.0f * ph : (ph < 0.75f ? 2.0f - 4.0f * ph : 4.0f * ph - 4.0f)) : 0.0f;
    }

    ARC_PER_BLOCK void noteOn(SynthVoice& v, const SynthParams& p, const SynthNote& n) override {
        if (p.count < kParamCount) return;
        SlotState& S = v.slotScratch->as<SlotState>();
        VoiceState& V = v.as<VoiceState>();
        if (!S.valid || S.serial != p.serial) refresh(S, p);
        const bool held = n.reused && V.started;
        const int mode = S.glideMode;
        const bool legato = held && (mode == kLegato || mode == kLegatoOverlap) && n.overlap && !V.rel;
        const bool alwaysGlide = mode == kAlways || mode == kLegato;
        V.target = n.pitch;
        V.glide = S.glideC > 0.0f && (held || S.hasLast) && !n.fxGlide && (alwaysGlide || n.overlap);
        if (!V.glide) V.pitch = n.pitch;
        else if (!held) V.pitch = S.lastPitch;
        S.lastPitch = n.pitch;
        S.hasLast = 1;
        if (!legato) {
            for (int k = 0; k < fm::kOps; ++k) {
                V.stage[k] = kAtt;
                if (!n.reused) {
                    V.att[k] = kSilentDb;
                    V.ops.ph[k] = 0.0f;   // FM needs a defined phase relation at the attack
                }
            }
            if (!n.reused) V.ops.fbA = V.ops.fbB = 0.0f;
            V.flip = 0;
            V.auxEnv = 15.0f;
            ch::tricksStart(V.tr, S.tc, bpm_);
        }
        if (!n.reused) {
            V.lfsr = 0x7FFFu ^ (uint32_t(n.note) * 0x9E37u & 0x7FFEu);   // a voice per note: its own noise
            V.auxP = 0.0f;
            V.auxZ = 0.0f;
            V.ampSet = 0;
        }
        V.rel = 0;
        V.started = 1;
        v.level = 1.0f;
    }

    void noteOff(SynthVoice& v, const SynthParams&) override {
        VoiceState& V = v.as<VoiceState>();
        const SlotState& S = v.slotScratch->as<SlotState>();
        V.rel = 1;
        for (int k = 0; k < fm::kOps; ++k) {
            if (V.stage[k] == kIdle) continue;
            const uint8_t loop = S.valid ? S.o[k].loop : uint8_t(kLoopOff);
            if ((V.flip >> k) & 1u && (loop == kHoldInv || loop == kRepeatInv)) {
                // An inverted envelope releases from the level it plays: its
                // attenuation a' with 10^(-a'/20) = 1 - 10^(-a/20).
                const float g = 1.0f - fastExp2(-V.att[k] * kDbToLog2);
                V.att[k] = g > 1.0e-5f ? -6.0206f * ch::fastLog2(g) : kSilentDb;
            }
            V.flip &= uint8_t(~(1u << k));
            V.stage[k] = kRel;
        }
    }

    ARC_PER_BLOCK bool render(SynthVoice& v, const SynthParams& p, float g0, float gInc, float* L, float* R) override {
        VoiceState& V = v.as<VoiceState>();
        if (!V.started || p.count < kParamCount) {
            v.level = 0.0f;
            return false;
        }
        const SlotState& S = v.slotScratch->as<SlotState>();
        const fm::Alg& alg = fm::kAlgs[S.alg];
        // Glide; the envelopes; the operator gains at the block's end (envelope, Level, AMS).
        const float pit0 = V.pitch;
        glideTo(V.pitch, V.target, V.glide ? S.glideC : 0.0f);
        fm::OpRamp r;
        bool alive = false;
        float lv = 0.0f;
        constexpr float kInvB = 1.0f / float(kBlock);
        for (int k = 0; k < fm::kOps; ++k) {
            const OpCfg& c = S.o[k];
            const float rs = float(c.rs) * (V.pitch - 24.0f) * (1.0f / 32.0f);
            envStep(c, V.stage[k], V.att[k], V.flip, uint8_t(1u << k), rs > 0.0f ? rs : 0.0f);
            float e = 0.0f;
            if (V.stage[k] != kIdle) {
                e = fastExp2(-V.att[k] * kDbToLog2);
                if ((V.flip >> k) & 1u && (c.loop == kHoldInv || c.loop == kRepeatInv)) e = 1.0f - e;   // inverted
                if (c.ams > 0.0f) e *= fastExp2(-c.ams * 0.5f * (1.0f + S.lfo1) * kDbToLog2);          // then the AM
            }
            const float a1 = c.level * e;
            const float a0 = V.ampSet ? V.amp[k] : a1;
            r.amp[k] = a0;
            r.damp[k] = (a1 - a0) * kInvB;
            V.amp[k] = a1;
            if ((alg.carriers >> k) & 1) {
                alive = alive || (V.stage[k] != kIdle && c.level > 0.0f);
                lv = lv > e ? lv : e;
            }
        }
        V.ampSet = 1;
        r.fb = S.fb;
        // The Aux voice's 4-bit level (a step every Aux Decay frames; cut at the note's end).
        const float ax0 = V.auxEnv;
        if (V.rel) V.auxEnv = 0.0f;
        else if (S.auxPer > 0.0f) ch::stepEnvTo(V.auxEnv, 0.0f, S.auxPer, float(kBlock));
        const bool aux = S.auxWave != kAuxOff && S.auxLevel > 0.0f && (ax0 > 0.0f || V.auxEnv > 0.0f);
        // The pitch: the note, the bend, the LFO's depth (cents), the CHIP arp / slide; chunks at the ticks.
        const float vib0 = S.pms * 0.01f * S.lfo0, vib1 = S.pms * 0.01f * S.lfo1;
        const float base0 = pit0 + v.bendStart + vib0, base1 = V.pitch + v.bend + vib1;
        const bool ticking = ch::tricksTick(S.tc);
        ch::tricksRate(V.tr, S.tc, bpm_);
        float ratio[fm::kOps];
        for (int k = 0; k < fm::kOps; ++k) {
            const OpCfg& c = S.o[k];
            const float ct = dtCents(int(c.dt) - 3, V.pitch);
            ratio[k] = c.ratio * fastExp2(ct * (1.0f / 1200.0f));
        }
        const Kernel kern = kKernels[S.alg];
        const float gA = g0 * kTrim, gB = (g0 + gInc * float(kBlock)) * kTrim;
        Out out{L, R, gA, (gB - gA) * kInvB, S.dac};
        uint32_t at = 0;
        while (at < kBlock) {
            const uint32_t m = ticking ? V.tr.tick.chunk(kBlock - at) : kBlock - at;
            const float o0 = ch::tricksOffset(V.tr, S.tc, 0.0f), o1 = ch::tricksOffset(V.tr, S.tc, float(m) * kInvFs);
            const float n0 = base0 + (base1 - base0) * float(at) * kInvB + o0, n1 = base0 + (base1 - base0) * float(at + m) * kInvB + o1;
            const float inv = 1.0f / float(m);
            const float i0 = 440.0f * kInvFs * fastExp2((n0 - 69.0f) * (1.0f / 12.0f)), i1 = 440.0f * kInvFs * fastExp2((n1 - 69.0f) * (1.0f / 12.0f));
            for (int k = 0; k < fm::kOps; ++k) {
                const float a = clampf(i0 * ratio[k], 0.0f, 0.49f), b = clampf(i1 * ratio[k], 0.0f, 0.49f);
                r.inc[k] = a;
                r.dinc[k] = (b - a) * inv;
            }
            out.L = L + at;
            out.R = R + at;
            kern(V.ops, r, m, out);
            const bool t = ticking && V.tr.tick.advance(m);
            ch::tricksAdvance(V.tr, S.tc, m, t);
            at += m;
        }
        if (aux) {
            // The Aux at the block's pitch (it does not follow the arp's chunks: a chip's separate voice).
            const float as = fastExp2(S.auxSemi * (1.0f / 12.0f));
            const float d0 = clampf(440.0f * kInvFs * fastExp2((base0 - 69.0f) * (1.0f / 12.0f)) * as, 0.0f, kMaxDt);
            const float d1 = clampf(440.0f * kInvFs * fastExp2((base1 - 69.0f) * (1.0f / 12.0f)) * as, 0.0f, kMaxDt);
            const float l0 = ch::env4(ax0, true, false) * S.auxLevel * gA, l1 = ch::env4(V.auxEnv, true, false) * S.auxLevel * gB;
            auxPass(L, R, kBlock, V, S.auxWave, Lin{d0, (d1 - d0) * kInvB}, lin(l0, l1));
        }
        const bool auxOn = S.auxWave != kAuxOff && S.auxLevel > 0.0f && V.auxEnv > 0.0f;
        const float al = auxOn ? ch::env4(V.auxEnv, false, false) : 0.0f;
        v.level = lv > al ? lv : al;
        if (!alive && !auxOn) {
            V.started = 0;
            v.level = 0.0f;
            return false;
        }
        return true;
    }

private:
    float bpm_ = 120.0f;
};

ArcEngine gArc;

}  // namespace

float attackSeconds(int rate) { return rate <= 0 ? 1e9f : attackOf(float(rate > 31 ? 31 : rate)); }
float decaySeconds(int rate) { return rate <= 0 ? 1e9f : decayOf(float(rate > 31 ? 31 : rate)); }
float releaseSeconds(int rate) { return decayOf(2.0f * float(rate < 0 ? 0 : (rate > 15 ? 15 : rate)) + 1.0f); }
float lfoHz(int i) { return kLfoTab[i < 0 ? 0 : (i > 8 ? 8 : i)]; }
float pmsCents(int i) { return kPmsTab[i < 0 ? 0 : (i > 7 ? 7 : i)]; }
float amsDb(int i) { return kAmsTab[i < 0 ? 0 : (i > 3 ? 3 : i)]; }
float dtCents(int dt, float note) {
    const int a = dt < 0 ? -dt : dt;
    const float f = clampf(note * (1.0f / 64.0f), 0.25f, 2.0f);
    return (dt < 0 ? -1.0f : 1.0f) * kDtTab[a > 3 ? 3 : a] * f;
}

ISynthEngine* engine() { return &gArc; }

}  // namespace arc
}  // namespace audio
}  // namespace ot
