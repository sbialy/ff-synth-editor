// Copied from opentracker-synths (https://github.com/opentracker-fw/opentracker-synths, modules/atype/src/atype.cpp, commit eb150a5f741b),
// Copyright (c) 2026 Marcin Spoczynski, MIT licence, see licenses/LICENSE-OpenTracker-synths-MIT.txt. Not modified, except this notice.
// A-Type duophonic engine (see atype.h).
//
// The block runs in 64-frame chunks of three passes: VCO 1 (saw or pulse,
// polyBLEP one frame late; with Sync on it marks its wraps for VCO 2), VCO 2
// (the same; with Sync on reset at VCO 1's wraps, the jump band-limited by
// va::vcoSync), then the mixer (the two VCOs, noise or the ring product, the
// seed noise), the high-pass (a TPT state-variable filter at Butterworth
// damping, skipped at 20 Hz), the low-pass and the VCA. The 4-pole is the
// ZDF ladder with a rational tanh on its loop input (no stage clips; loop
// gain 4.4 at Resonance 100 %, oscillating from ~91 %; a quarter of the pass
// band loss per unit of loop gain made up); the 2-pole the state-variable
// low-pass after the same tanh (damping 1 - 1.1 x Resonance: below 0 from
// ~91 %, it grows until its level pulls the damping back, per sample:
// va::svfLevelK, and sings). A VCO that nothing
// hears or reads is skipped (its phase runs on). The shared DSP is
// audio/va_dsp.h.
// The envelopes (ADSR, AR), glide, drift, the sample & hold (clocked per
// voice at block rate), the slot's LFO, the pitches, the widths, the cutoff
// (Key Track around C4, Env Amt, LFO Amt, S&H Amt), the resonance, the levels
// and the VCA run at block rate and are ramped across the 128-frame block
// from the previous block's end values (no step when a macro slams a
// parameter).
#include "atype.h"

#include <cstring>

#include "audio/va_dsp.h"

#if defined(__GNUC__) && !defined(__clang__)
#define ATYPE_PER_BLOCK __attribute__((optimize("Os")))
#else
#define ATYPE_PER_BLOCK
#endif

namespace ot {
namespace audio {
namespace atype {

namespace {

using namespace ot::audio::va;

constexpr float kDrive = 0.7f;          // mixer level 100 % -> filter input
constexpr float kOutTrim = 0.67f;       // filter output -> slot bus (the ACD Init level)
constexpr float kSeedNoise = 2.0e-4f;   // always-on noise floor: seeds self-oscillation
constexpr float kModSemi = 12.0f;       // VCO Mod / LFO Mod 100 % = +-12 semitones (x amount^2)
constexpr float kResK = 4.4f;           // ladder loop gain at Resonance 100 % (oscillates above 4)
constexpr float kResComp = 0.25f;       // ladder pass-band make-up per unit of loop gain
constexpr float kSvfRes = 1.1f;         // 2-pole damping 1 - 1.1 x Resonance
constexpr float kEnvOct = 7.0f;         // Env Amt 100 % = +-7 octaves
constexpr float kLfoOct = 3.0f;         // LFO Amt 100 % = +-3 octaves
constexpr float kShOct = 3.0f;          // S&H Amt 100 % = +-3 octaves
constexpr float kHpDamp = 0.70710678f;  // HPF: Butterworth, no resonance
constexpr float kHpOffHz = 20.5f;       // HPF at its bottom (20 Hz): off
constexpr float kDriftCents = 1.5f;     // per-VCO random walk bound
constexpr float kDriftStep = 0.3f;      // cents per block (uniform +-0.15)
constexpr int kChunk = 64;              // frames per pass: two kChunk buffers on the stack (512 B)

// A pulse width 0..1 (+ PWM x the LFO, 0..1 across its swing) -> the duty, 50 % .. 5 %.
inline float dutyOf(float pw, float pwm, float lfo) { return 0.5f - 0.45f * clampf(pw + pwm * 0.5f * (1.0f + lfo), 0.0f, 1.0f); }

// The LFO waves of phase 0..1.
inline float lfoWave(int shape, float p) {
    switch (shape) {
        case kSine: return sinePar(p);
        case kTri: return p < 0.25f ? 4.0f * p : (p < 0.75f ? 2.0f - 4.0f * p : 4.0f * p - 4.0f);
        case kSquare: return p < 0.5f ? 1.0f : -1.0f;
        default: return p + p - 1.0f;   // rising saw
    }
}

struct SlotState {
    uint32_t serial;
    uint32_t seed;                      // note-on phases, noise and drift seeds
    uint8_t valid, hasLast, glideMode, lvSet;
    uint8_t shape[2], sync, ring;       // VCO shapes (kShSaw / kShPulse), Sync On, Source Ring
    uint8_t vcaAr, envAr, modSrc, shIn; // the VCA's / filter's envelope is the AR; VCO 2 Mod source; S&H input
    uint8_t shKey, duo, lfoShape, mode;    // ... the 4-pole or 2-pole
    uint8_t hpOn;                       // the HPF runs this block
    float semi[2];                      // range + fine (+ VCO 2 tune), semitones
    float pw[2], pwm[2];                // pulse width 0..1 and its LFO depth
    float mod1, mod2;                   // semitones at a full source: VCO 1 LFO Mod, VCO 2 Mod (12 x amount^2)
    float lv0[3], lv1[3];               // VCO 1, VCO 2, source (x kDrive): block start / end
    float shInc, shLagC;                // S&H clock phase per block, lag factor per block
    float lastPitch;                    // the slot's previous note (glide source)
    float glideC;                       // per-block glide factor (0 = no glide)
    float lfoPh, lfo0, lfo1;            // the slot's free-running LFO: phase at the block end, value at start / end
    float cutoff, res;                  // Hz, 0..1
    float key, envOct, lfoOct, shOct;   // octaves per semitone around C4; octaves at a full envelope / LFO / S&H
    float hpHz, hpG[2], hpH[2];         // HPF: cutoff at the block end; g and h at the block start / end
    Contour adsr, ar;
};
static_assert(sizeof(SlotState) <= kSynthSlotScratchBytes, "A-Type slot state");

struct VoiceState {
    float ph[2];                        // VCO phases 0..1
    float z[2];                         // VCO samples held back one frame (their edge corrections)
    float drift[2];                     // cents
    float adsr, ar;                     // envelope levels
    float p1, p2, target;               // glided VCO 1 / VCO 2 pitches, the note
    float s[4];                         // ladder stage states (2-pole: s[0], s[1] the SVF's)
    Svf hp;                             // HPF states
    float G, k, out;                    // filter coefficient, loop gain / damping, VCA x trim: end of the last block
    float sh, shOut, shPh;              // S&H: the held value, after the lag, the clock phase
    uint32_t noise;
    uint8_t aStage, rStage, gate, started, glide, shKey;
    uint8_t set, mode;                  // G / k hold the last block's values for this filter mode
};
static_assert(sizeof(VoiceState) <= kSynthVoiceStateBytes, "A-Type voice state");

// One chunk of VCO 1 into a, its wraps into mark (frames since the wrap, -1
// none; all -1 without sync) for VCO 2.
template <int kSh>
__attribute__((noinline)) void vco1Pass(float* a, float* mark, VoiceState& V, Lin& dt, Lin& du, bool sync) {
    float p = V.ph[0], z = V.z[0], d = dt.v, w = du.v;
    const float dd = dt.d, dw = du.d;
    bool hi = vcoHi<kSh>(p, w);
    for (int i = 0; i < kChunk; ++i) {
        const float before = p;
        a[i] = vcoFrame<kSh>(p, z, hi, d, w);
        mark[i] = sync && p < before ? p / d : -1.0f;
        d += dd;
        w += dw;
    }
    V.ph[0] = p;
    V.z[0] = z;
    dt.v = d;
    du.v = w;
}
// One chunk of VCO 2 into b; b holds VCO 1's wrap marks on entry (vcoSync
// without a mark is the plain band-limited oscillator).
template <int kSh>
__attribute__((noinline)) void vco2Pass(float* b, VoiceState& V, Lin& dt, Lin& du) {
    float p = V.ph[1], z = V.z[1], d = dt.v, w = du.v;
    const float dd = dt.d, dw = du.d;
    for (int i = 0; i < kChunk; ++i) {
        b[i] = vcoSync<kSh>(p, z, d, w, b[i]);
        d += dd;
        w += dw;
    }
    V.ph[1] = p;
    V.z[1] = z;
    dt.v = d;
    du.v = w;
}
// A VCO nobody hears or reads: its phase runs on, nothing held, a silent buffer.
void skipVco(float* x, float& ph, float& zh, Lin& dt, Lin& du) {
    ph += float(kChunk) * dt.v + 0.5f * float(kChunk * (kChunk - 1)) * dt.d;
    ph -= float(int(ph));
    zh = 0.0f;
    dt.v += float(kChunk) * dt.d;
    du.v += float(kChunk) * du.d;
    std::memset(x, 0, sizeof(float) * kChunk);
}

using Vco1Pass = void (*)(float*, float*, VoiceState&, Lin&, Lin&, bool);
const Vco1Pass kVco1[2] = {vco1Pass<kShSaw>, vco1Pass<kShPulse>};
using Vco2Pass = void (*)(float*, VoiceState&, Lin&, Lin&);
const Vco2Pass kVco2[2] = {vco2Pass<kShSaw>, vco2Pass<kShPulse>};

struct FilterRamp {
    Lin G, r, k;                        // 4-pole: stage gain, 1 / (1 + k G^4), loop gain; 2-pole: g, h (its start), the wanted 2 x damping
    float kmin;                         // 2-pole: the smallest damping this block (va::svfKMin)
    Lin a;                              // VCA x trim x make-up
    Lin l1, l2, ls;                     // mixer levels
    Lin hg;                             // HPF g
    float hh;                           // HPF h (tracked per sample: va::svfHNext)
};
// One chunk of the mixer, the HPF, the low-pass (4-pole or 2-pole) and the
// VCA into L / R.
__attribute__((noinline)) void filterPass(const float* a, const float* b, float* L, float* R, VoiceState& V, FilterRamp& q, bool ring,
                                          bool hpOn, bool ladder) {
    float s[4] = {V.s[0], V.s[1], V.s[2], V.s[3]};
    Svf h = V.hp;
    uint32_t nz = V.noise;
    float G = q.G.v, r = q.r.v, k = q.k.v, A = q.a.v, l1 = q.l1.v, l2 = q.l2.v, ls = q.ls.v, hg = q.hg.v, hh = q.hh;
    const float dG = q.G.d, dr = q.r.d, dk = q.k.d, dA = q.a.d, d1 = q.l1.d, d2 = q.l2.d, ds = q.ls.d, dhg = q.hg.d;
    constexpr float kHpK = kHpDamp + kHpDamp;
    for (int i = 0; i < kChunk; ++i) {
        const float w = lcg(nz);
        float x = l1 * a[i] + l2 * b[i] + ls * (ring ? a[i] * b[i] : w) + kSeedNoise * w;
        if (hpOn) {
            float lp, bp, hpo;
            svfStep(h, SvfCoef{hg, kHpK, hh}, x, lp, bp, hpo);
            x = hpo;
        }
        float y;
        if (ladder) {
            y = ladderStep<false>(x, s, G, k, r);
        } else {
            Svf f{s[0], s[1]};
            const float kk = svfLevelK(k, q.kmin, f);   // + the state's level: singing, bounded
            r = svfHTrack(r, G, kk);
            float bp, hpo;
            svfStep(f, SvfCoef{G, kk, r}, tanhR(x), y, bp, hpo);
            s[0] = f.s1;
            s[1] = f.s2;
        }
        const float o = y * A;
        L[i] += o;
        R[i] += o;
        G += dG;
        k += dk;
        if (ladder) r += dr;
        A += dA;
        l1 += d1;
        l2 += d2;
        ls += ds;
        if (hpOn) {
            hg += dhg;
            hh = svfHNext(hh, hg, kHpK);
        }
    }
    for (int j = 0; j < 4; ++j) V.s[j] = s[j];
    V.hp = h;
    V.noise = nz;
    q.G.v = G;
    q.r.v = r;
    q.k.v = k;
    q.a.v = A;
    q.l1.v = l1;
    q.l2.v = l2;
    q.ls.v = ls;
    q.hg.v = hg;
    q.hh = hh;
}

ATYPE_PER_BLOCK void refresh(SlotState& S, const SynthParams& p) {
    const float* E = p.end;
    static const float kOct[4] = {-2.0f, -1.0f, 0.0f, 1.0f};
    S.shape[0] = enumOf(E[kVco1Wave], kPulse) == kPulse ? kShPulse : kShSaw;
    S.shape[1] = enumOf(E[kVco2Wave], kPulse) == kPulse ? kShPulse : kShSaw;
    S.semi[0] = 12.0f * kOct[enumOf(E[kVco1Range], k4)] + 0.01f * clampf(E[kVco1Fine], -100.0f, 100.0f);
    S.semi[1] = 12.0f * kOct[enumOf(E[kVco2Range], k4)] + clampf(E[kVco2Tune], -24.0f, 24.0f) +
                0.01f * clampf(E[kVco2Fine], -100.0f, 100.0f);
    S.pw[0] = clampf(E[kVco1Pw], 0.0f, 1.0f);
    S.pwm[0] = clampf(E[kVco1Pwm], 0.0f, 1.0f);
    S.pw[1] = clampf(E[kVco2Pw], 0.0f, 1.0f);
    S.pwm[1] = clampf(E[kVco2Pwm], 0.0f, 1.0f);
    const float m1 = clampf(E[kVco1LfoMod], 0.0f, 1.0f), m2 = clampf(E[kVco2Mod], 0.0f, 1.0f);
    S.mod1 = kModSemi * m1 * m1;
    S.mod2 = kModSemi * m2 * m2;
    S.modSrc = uint8_t(enumOf(E[kVco2ModSrc], kModAdsr));
    S.sync = E[kSync] >= 0.5f;
    S.ring = enumOf(E[kSource], kRing) == kRing;
    S.shIn = uint8_t(enumOf(E[kShInput], kShMix));
    S.shKey = enumOf(E[kShClock], kClockKey) == kClockKey;
    S.shInc = clampf(E[kShRate], 0.1f, 50.0f) * kBlockT;
    S.shLagC = blockCoef(clampf(E[kShLag], 0.0f, 1.0f));
    S.cutoff = clampf(E[kCutoff], 20.0f, 20000.0f);
    S.res = clampf(E[kResonance], 0.0f, 1.0f);
    S.mode = uint8_t(enumOf(E[kFilterMode], k2Pole));
    S.key = clampf(E[kKeyTrack], 0.0f, 1.0f) * (1.0f / 12.0f);
    S.envOct = kEnvOct * clampf(E[kEnvAmt], -1.0f, 1.0f);
    S.lfoOct = kLfoOct * clampf(E[kLfoAmt], 0.0f, 1.0f);
    S.shOct = kShOct * clampf(E[kShAmt], 0.0f, 1.0f);
    S.envAr = enumOf(E[kEnvSrc], kAr) == kAr;
    S.vcaAr = enumOf(E[kVcaEnv], kAr) == kAr;
    setContour(S.adsr, E[kAttack], E[kDecay], E[kSustain], E[kRelease]);
    setContour(S.ar, E[kArAttack], 0.0f, 1.0f, E[kArRelease]);
    S.lfoShape = uint8_t(enumOf(E[kLfoShape], kSawUp));
    S.duo = enumOf(E[kKeyboard], kDuo) == kDuo;
    S.glideMode = uint8_t(enumOf(E[kGlideMode], kLegatoOverlap));
    // Exponential glide: 95 % of the way after Glide Time.
    const float gt = clampf(E[kGlideTime], 0.0f, 3.0f);
    S.glideC = gt < 0.0005f ? 0.0f : fastExp2(-4.3219281f * kBlockT / gt);
    S.serial = p.serial;
    S.valid = 1;
}

// One block of glide towards t (snapped within a cent).
inline void glideTo(float& x, float t, float c) {
    if (x == t) return;
    x = t + (x - t) * c;
    if (__builtin_fabsf(x - t) < 0.01f) x = t;
}

class AtypeEngine final : public ISynthEngine {
public:
    int32_t id() const override { return kEngineId; }
    const char* name() const override { return "ATYPE"; }

    void slotReset(SynthSlotScratch& sc) override { std::memset(sc.bytes, 0, sizeof(sc.bytes)); }

    ATYPE_PER_BLOCK void prepare(SynthSlotScratch& sc, const SynthParams& p) override {
        if (p.count < kParamCount) return;
        SlotState& S = sc.as<SlotState>();
        const float* E = p.end;
        if (!S.valid || S.serial != p.serial || p.moving) refresh(S, p);
        // Levels glide from the last block's values (a macro slam does not step).
        const float to[3] = {kDrive * clampf(E[kVco1Level], 0.0f, 1.0f), kDrive * clampf(E[kVco2Level], 0.0f, 1.0f),
                             kDrive * clampf(E[kSourceLevel], 0.0f, 1.0f)};
        std::memcpy(S.lv0, S.lvSet ? S.lv1 : to, sizeof(S.lv0));
        std::memcpy(S.lv1, to, sizeof(S.lv1));
        // HPF coefficients at the block start (the last block's end) and end.
        const float hz = clampf(E[kHpf], 20.0f, 20000.0f), g = svfG(hz, 0.0f);
        S.hpOn = hz > kHpOffHz || (S.lvSet && S.hpHz > kHpOffHz);
        S.hpG[0] = S.lvSet ? S.hpG[1] : g;
        S.hpH[0] = S.lvSet ? S.hpH[1] : svfH(g, kHpDamp + kHpDamp);
        S.hpG[1] = g;
        S.hpH[1] = svfH(g, kHpDamp + kHpDamp);
        S.hpHz = hz;
        // The LFO: free-running per slot, its value at the block start and end.
        float ph = S.lfoPh + clampf(E[kLfoRate], 0.1f, 30.0f) * kBlockT;
        if (ph >= 1.0f) ph -= float(int(ph));
        S.lfoPh = ph;
        const float l1 = lfoWave(S.lfoShape, ph);
        S.lfo0 = S.lvSet ? S.lfo1 : l1;
        S.lfo1 = l1;
        S.lvSet = 1;
    }

    ATYPE_PER_BLOCK void noteOn(SynthVoice& v, const SynthParams& p, const SynthNote& n) override {
        if (p.count < kParamCount) return;
        SlotState& S = v.slotScratch->as<SlotState>();
        VoiceState& V = v.as<VoiceState>();
        if (!S.valid || S.serial != p.serial) refresh(S, p);
        const bool held = n.reused && V.started;
        if (!held) {
            // A fresh voice: free-running VCOs (arbitrary phases), its own noise, drift and S&H value.
            for (int j = 0; j < 2; ++j) {
                S.seed = S.seed * 1664525u + 1013904223u;
                V.ph[j] = float(S.seed >> 8) * (1.0f / 16777216.0f);
                V.drift[j] = kDriftCents * (float(S.seed & 0xFFu) * (2.0f / 255.0f) - 1.0f) * 0.5f;
            }
            V.noise = S.seed ^ 0x9E3779B9u;
            V.sh = V.shOut = lcg(V.noise);
            V.shPh = 0.0f;
        }
        // Glide (ACD semantics): Always / Legato from the slot's previous note,
        // Overlap / Legato Overlap only from a held one; a Glide FX owns the start.
        const int mode = S.glideMode;
        const bool alwaysGlide = mode == kAlways || mode == kLegato;
        const bool hasFrom = held || S.hasLast;
        V.target = n.pitch;
        V.glide = S.glideC > 0.0f && hasFrom && !n.fxGlide && (alwaysGlide || n.overlap);
        if (!V.glide) V.p1 = V.p2 = n.pitch;
        else if (!held) V.p1 = V.p2 = S.lastPitch;
        // Legato modes: an overlapping note does not restart the envelopes.
        const bool legato = (mode == kLegato || mode == kLegatoOverlap) && n.overlap;
        if (!legato || (V.aStage == kIdle && V.rStage == kIdle)) {
            V.aStage = kAtt;   // from the current levels (no click on a reused voice)
            V.rStage = kAtt;
        }
        V.shKey = S.shKey;   // Key clock: a new S&H value with each note
        S.lastPitch = n.pitch;
        S.hasLast = 1;
        V.gate = 1;
        V.started = 1;
        // A fresh voice reports full level (the framework must not take it as
        // a steal victim before its first block).
        v.level = n.reused ? (S.vcaAr ? V.ar : V.adsr) : 1.0f;
    }

    void noteOff(SynthVoice& v, const SynthParams&) override {
        VoiceState& V = v.as<VoiceState>();
        V.gate = 0;
        if (V.aStage != kIdle) V.aStage = kRel;
        if (V.rStage != kIdle) V.rStage = kRel;
    }

    ATYPE_PER_BLOCK bool render(SynthVoice& v, const SynthParams& p, float g0, float gInc, float* L, float* R) override {
        VoiceState& V = v.as<VoiceState>();
        if (!V.started || p.count < kParamCount) {
            v.level = 0.0f;
            return false;
        }
        const SlotState& S = v.slotScratch->as<SlotState>();
        // Envelopes, glide, drift (one block step).
        const float a0 = V.adsr, r0 = V.ar;
        V.adsr = step(V.aStage, V.adsr, S.adsr);
        V.ar = step(V.rStage, V.ar, S.ar);
        const float p10 = V.p1, p20 = V.p2;
        // Keyboard Duo: two or more notes held on a Poly 1 slot -> VCO 1 to
        // the lowest, VCO 2 to the highest (both glide); else both on the note.
        float t1 = V.target, t2 = V.target;
        if (S.duo && p.held.mono && p.held.count >= 2) {
            t1 = float(p.held.low);
            t2 = float(p.held.high);
        }
        const float gc = V.glide ? S.glideC : 0.0f;
        glideTo(V.p1, t1, gc);
        glideTo(V.p2, t2, gc);
        float drift0[2];
        for (int j = 0; j < 2; ++j) {
            drift0[j] = V.drift[j];
            V.noise = V.noise * 1664525u + 1013904223u;
            const float d = V.drift[j] + kDriftStep * (float(V.noise >> 8) * (1.0f / 16777216.0f) - 0.5f);
            V.drift[j] = clampf(d, -kDriftCents, kDriftCents);
        }
        // S&H: a new value at the clock (the rate, block-quantised, or a note
        // with the Key clock) from its input, then the lag.
        bool tick = V.shKey;
        V.shKey = 0;
        if (!S.shKey) {
            V.shPh += S.shInc;
            if (V.shPh >= 1.0f) {
                V.shPh -= float(int(V.shPh));
                tick = true;
            }
        }
        if (tick) {
            float in;
            switch (S.shIn) {
                case kShVco1: in = V.z[0]; break;
                case kShVco2: in = V.z[1]; break;
                case kShMix: in = (S.lv1[0] * V.z[0] + S.lv1[1] * V.z[1]) * (1.0f / kDrive); break;
                default: in = lcg(V.noise); break;
            }
            V.sh = clampf(in, -1.0f, 1.0f);
        }
        const float sh0 = V.shOut;
        V.shOut = V.sh + (V.shOut - V.sh) * S.shLagC;
        // VCO increments and widths: the pitch, VCO 1's vibrato, VCO 2's Mod.
        constexpr float n = 1.0f / float(kBlock);
        const float src0 = S.modSrc == kModLfo ? S.lfo0 : (S.modSrc == kModSh ? sh0 : a0);
        const float src1 = S.modSrc == kModLfo ? S.lfo1 : (S.modSrc == kModSh ? V.shOut : V.adsr);
        Lin dt[2], du[2];
        {
            const float a = incOf(p10 + v.bendStart + S.mod1 * S.lfo0, S.semi[0], drift0[0], kMaxDt);
            const float b = incOf(V.p1 + v.bend + S.mod1 * S.lfo1, S.semi[0], V.drift[0], kMaxDt);
            dt[0] = {a, (b - a) * n};
            const float c = incOf(p20 + v.bendStart + S.mod2 * src0, S.semi[1], drift0[1], kMaxDt);
            const float d = incOf(V.p2 + v.bend + S.mod2 * src1, S.semi[1], V.drift[1], kMaxDt);
            dt[1] = {c, (d - c) * n};
        }
        for (int j = 0; j < 2; ++j) du[j] = lin(dutyOf(S.pw[j], S.pwm[j], S.lfo0), dutyOf(S.pw[j], S.pwm[j], S.lfo1));
        FilterRamp q;
        q.l1 = lin(S.lv0[0], S.lv1[0]);
        q.l2 = lin(S.lv0[1], S.lv1[1]);
        q.ls = lin(S.lv0[2], S.lv1[2]);
        q.hg = lin(S.hpG[0], S.hpG[1]);
        q.hh = S.hpH[0];
        if (!S.hpOn) V.hp = Svf{0.0f, 0.0f};
        // The cutoff: Key Track (VCO 2's pitch: the high note in Duo), the
        // envelope, the LFO, the S&H; from the last block's coefficients.
        const float fe0 = S.envAr ? r0 : a0, fe1 = S.envAr ? V.ar : V.adsr;
        const float oct0 = S.key * (p20 + v.bendStart - 60.0f) + S.envOct * fe0 + S.lfoOct * S.lfo0 + S.shOct * sh0;
        const float oct1 = S.key * (V.p2 + v.bend - 60.0f) + S.envOct * fe1 + S.lfoOct * S.lfo1 + S.shOct * V.shOut;
        const bool same = V.set && V.mode == S.mode;
        float makeUp;
        if (S.mode == k4Pole) {
            const float G1 = stageGain(S.cutoff, oct1), G0 = same ? V.G : stageGain(S.cutoff, oct0);
            const float k1 = kResK * S.res, k0 = same ? V.k : k1;
            q.G = lin(G0, G1);
            q.k = lin(k0, k1);
            q.r = lin(1.0f / (1.0f + k0 * G0 * G0 * G0 * G0), 1.0f / (1.0f + k1 * G1 * G1 * G1 * G1));
            V.G = G1;
            V.k = k1;
            makeUp = 1.0f + kResComp * k1;
        } else {
            const float g1 = svfG(S.cutoff, oct1), g0 = same ? V.G : svfG(S.cutoff, oct0);
            const float k1 = 2.0f * (1.0f - kSvfRes * S.res), k0 = same ? V.k : k1;
            q.G = lin(g0, g1);
            q.k = lin(k0, k1);
            q.r = {svfH(g0, k0), 0.0f};   // tracked per sample with the level term
            q.kmin = svfKMin(g0 > g1 ? g0 : g1);
            V.G = g1;
            V.k = k1;
            makeUp = 1.0f;
        }
        V.set = 1;
        V.mode = S.mode;
        // VCA: its envelope x trim x make-up, from the last block's value (0
        // for a fresh voice; no step when the resonance moves).
        const float env = S.vcaAr ? V.ar : V.adsr;
        const float out1 = env * kOutTrim * makeUp;
        const float gEnd = g0 + gInc * float(kBlock);
        q.a = {V.out * g0, (out1 * gEnd - V.out * g0) * n};
        V.out = out1;
        // The passes, chunk by chunk (a VCO nothing hears or reads is skipped).
        const bool ring = S.ring && (S.lv0[2] > 0.0f || S.lv1[2] > 0.0f);
        const bool need1 = S.lv0[0] > 0.0f || S.lv1[0] > 0.0f || ring || S.sync || S.shIn == kShVco1 || S.shIn == kShMix;
        const bool need2 = S.lv0[1] > 0.0f || S.lv1[1] > 0.0f || ring || S.shIn == kShVco2 || S.shIn == kShMix;
        const bool mark = S.sync && need2;
        const Vco1Pass vco1 = kVco1[S.shape[0] == kShPulse];
        const Vco2Pass vco2 = kVco2[S.shape[1] == kShPulse];
        float a[kChunk], b[kChunk];   // VCO 1, VCO 2 (VCO 1's wrap marks first when synced)
        for (uint32_t c = 0; c < kBlock; c += kChunk) {
            if (need1) vco1(a, b, V, dt[0], du[0], mark);
            else skipVco(a, V.ph[0], V.z[0], dt[0], du[0]);
            if (!need1 && need2)
                for (float& m : b) m = -1.0f;   // no marks: VCO 2 runs free
            if (need2) vco2(b, V, dt[1], du[1]);
            else skipVco(b, V.ph[1], V.z[1], dt[1], du[1]);
            filterPass(a, b, L + c, R + c, V, q, ring, S.hpOn, S.mode == k4Pole);
        }
        for (float& z : V.s) z = flush(z);
        V.hp.s1 = flush(V.hp.s1);
        V.hp.s2 = flush(V.hp.s2);
        v.level = env;
        // The VCA's envelope ended, or a held ADSR note decayed to Sustain 0.
        const uint8_t st = S.vcaAr ? V.rStage : V.aStage;
        if (st == kIdle || (!S.vcaAr && st == kDec && env == 0.0f && S.adsr.sustain == 0.0f)) {
            V.started = 0;
            V.aStage = V.rStage = kIdle;
            V.adsr = V.ar = 0.0f;
            return false;
        }
        return true;
    }
};

AtypeEngine gAtype;

}  // namespace

ISynthEngine* engine() { return &gAtype; }

}  // namespace atype
}  // namespace audio
}  // namespace ot
