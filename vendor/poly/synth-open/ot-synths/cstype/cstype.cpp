// Copied from opentracker-synths (https://github.com/opentracker-fw/opentracker-synths, modules/cstype/src/cstype.cpp, commit eb150a5f741b),
// Copyright (c) 2026 Marcin Spoczynski, MIT licence, see licenses/LICENSE-OpenTracker-synths-MIT.txt. Not modified, except this notice.
// CS-Type two-layer engine (see cstype.h).
//
// Per voice two layers, each two passes per 64-frame chunk: the
// oscillators (saw and pulse together off one phase, band-limited one frame
// late by va::vcoSawPulse; a cosine off the same phase; noise), then the
// resonant high-pass and the resonant low-pass (TPT state-variable filters,
// damping 1 - 1.1 x Res, h tracked per sample; the low-pass's below 0 from
// ~91 %: it grows until its level pulls the damping back, per sample,
// va::svfLevelK, and sings; the high-pass's damping stops at 0.05, a strong
// peak that does not sing; the high-pass skipped at 20 Hz), a soft limit
// above 1 (linear below, towards 2: the stacked resonances stay bounded)
// and the layer's VCA, added
// into the voice's sum. A layer at Level 0 is skipped (its phase runs on).
// The sum passes the ring modulator (a sine at RM Speed, its start swept by
// RM Sweep over RM Decay; Depth = wet) into L / R. The shared DSP is
// audio/va_dsp.h.
// At block rate, ramped across the 128-frame block from the previous
// block's end values: the envelopes (per layer the filter's IL / AL contour
// and the VCA's ADSR), glide, the pitches (Feet, II Detune, the sub-osc,
// the Touch vibrato, the Ribbon), the cutoffs (Brilliance, the contour, Key
// at half an octave per octave around C4, the sub-osc, Touch), the
// resonances (+ Resonance), the levels, the widths (each layer's PWM LFO),
// the ring modulator's rate and the VCAs (velocity, the sub-osc, Touch).
#include "cstype.h"

#include <cstring>

#include "audio/va_dsp.h"

#if defined(__GNUC__) && !defined(__clang__)
#define CSTYPE_PER_BLOCK __attribute__((optimize("Os")))
#else
#define CSTYPE_PER_BLOCK
#endif

namespace ot {
namespace audio {
namespace cstype {

namespace {

using namespace ot::audio::va;

constexpr float kDrive = 0.5f;          // a layer's wave levels -> its filters
constexpr float kOutTrim = 0.8f;        // the layers' sum -> slot bus (the ACD Init level)
constexpr float kSeed = 1.0e-4f;        // the low-pass state's seed: self-oscillation starts (note on, or Res raised)
constexpr float kSvfRes = 1.1f;         // damping 1 - 1.1 x Res
constexpr float kEnvOct = 4.0f;         // IL / AL 100 % = +-4 octaves
constexpr float kKeyOct = 0.5f / 12.0f; // Key: half an octave per octave around C4
constexpr float kFnSemi = 1.0f;         // sub-osc -> VCO 100 % = +-1 semitone
constexpr float kFnOct = 2.0f;          // sub-osc -> VCF 100 % = +-2 octaves
constexpr float kTouchOct = 2.0f;       // After -> VCF 100 % = +2 octaves at full Touch
constexpr float kTouchVib = 0.5f;       // After -> VCO 100 % = +-0.5 semitone vibrato at full Touch
constexpr float kVibHz = 5.5f;          // the Touch vibrato's rate
constexpr float kRmSweepOct = 3.0f;     // RM Sweep 100 % = the ring's rate starts 3 octaves off
constexpr float kHpOffHz = 20.5f;       // HPF at its bottom (20 Hz): off
constexpr float kHpKMin = 0.1f;         // HPF: 2 x damping at least (a +20 dB peak at the top)
constexpr int kChunk = 64;              // frames per pass: two kChunk buffers on the stack (512 B)

struct Layer {
    uint8_t on, saw, pulse, hpOn;       // Level > 0 (block start or end); waves; the HPF runs
    float semi;                         // feet (+ II Detune), semitones
    float pw, pwm;                      // width 0..1, PWM depth
    float pwmPh, tri0, tri1;            // the layer's PWM LFO (per slot): phase, triangle at block start / end
    float hpHz, lpHz;                   // cutoffs
    float hk[2], lk[2];                 // 2 x damping of the HPF / LPF: block start / end
    float lv0[3], lv1[3];               // sine, noise, layer level: block start / end
    float il, al;                       // IL / AL (octaves / kEnvOct)
    IlAl fc;                            // filter contour
    Contour vc;                         // VCA
    float hpRes, lpRes;                 // the Res values before Resonance
};
struct SlotState {
    uint32_t serial;
    uint32_t seed;                      // note-on phases, noise and sub-osc noise
    uint8_t valid, hasLast, glideMode, lvSet;
    uint8_t fn, ringOn;
    float bril, resAdd;                 // Brilliance, Resonance
    float rmDepth[2], rmHz, rmSweep, rmDecC;
    float fnInc, fnPh, fn0, fn1, fnHeld;   // the sub-osc LFO: increment, phase, value at block start / end, its noise value
    float toVco, toVcf, toVca;
    float touch0, touch1;               // Touch at block start / end
    float initBril, initLevel, aVco, aVcf, aVca;
    float vibPh, vib0, vib1;            // the Touch vibrato (a sine at kVibHz)
    float ribbon;                       // semitones
    float lastPitch, glideC;
    Layer L[2];
};
static_assert(sizeof(SlotState) <= kSynthSlotScratchBytes, "CS-Type slot state");

struct LayerV {
    float ph, z;                        // VCO phase, the saw / pulse sample held back one frame
    Svf hp, lp;                         // filter states
    float fenv, aenv;                   // contour, VCA envelope
    float hpG, lpG;                     // filter g at the end of the last block
    uint8_t fStage, aStage;
};
struct VoiceState {
    LayerV L[2];
    float pitch, target;                // glided note pitch, glide target
    float vel;                          // the note's velocity (Touch initial)
    float rmPh, rmEnv;                  // ring modulator phase, its sweep envelope (1 -> 0)
    uint32_t noise;
    uint8_t gate, started, glide, set;
};
static_assert(sizeof(VoiceState) <= kSynthVoiceStateBytes, "CS-Type voice state");

struct LayerRamp {
    Lin dt, du;                         // phase increment, duty
    Lin sine, noise, a;                 // levels (x kDrive), VCA
    Lin hg, hk, lg, lk;                 // HPF / LPF g and k (2 x damping; the LPF's wanted one)
    float hh, lh;                       // HPF / LPF h at the block start (then tracked per sample)
    float lkMin;                        // the LPF's smallest damping this block (va::svfKMin)
    float gs, gp;                       // saw / pulse levels (x kDrive)
};

// Linear up to 1, then a knee (slope 1 at 1) towards 2: bounds a layer
// without colouring it at normal levels.
inline float limit(float y) {
    const float a = __builtin_fabsf(y);
    if (a <= 1.0f) return y;
    const float t = a - 1.0f, o = 1.0f + t / (1.0f + t);
    return y < 0.0f ? -o : o;
}
// The layer's sine (a cosine: the phase is free) from the triangle of the
// phase, sin(pi / 2 t) to 1e-4.
inline float cosOf(float p) {
    const float t = 4.0f * __builtin_fabsf(p - 0.5f) - 1.0f, t2 = t * t;
    return t * (1.5707963f - t2 * (0.6459637f - 0.0796926f * t2));
}
// The ring modulator's carrier: a parabola per half cycle (its harmonics,
// 3 % at 3x, sit far below the sidebands).
inline float parabola(float p) {
    const float u = p < 0.5f ? p : p - 1.0f;
    return 8.0f * u * (1.0f - 2.0f * __builtin_fabsf(u));
}

// One chunk of a layer's oscillators into o: saw + pulse, the sine and the
// noise only when their levels are up.
__attribute__((noinline)) void oscPass(float* o, LayerV& V, uint32_t& nz, LayerRamp& q, bool sine, bool noise) {
    float p = V.ph, z = V.z;
    float dt = q.dt.v, du = q.du.v, si = q.sine.v, no = q.noise.v;
    bool high = p >= 1.0f - du;   // the pulse's state, carried while the width moves
    const float ddt = q.dt.d, ddu = q.du.d, dsi = q.sine.d, dno = q.noise.d;
    const float gs = q.gs, gp = q.gp;
    uint32_t n = nz;
    for (int i = 0; i < kChunk; ++i) {
        float s = vcoSawPulse(p, z, high, dt, du, gs, gp);
        if (sine) s += si * cosOf(p);
        if (noise) s += no * lcg(n);
        o[i] = s;
        dt += ddt;
        du += ddu;
        si += dsi;
        no += dno;
    }
    nz = n;
    V.ph = p;
    V.z = z;
    q.dt.v = dt;
    q.du.v = du;
    q.sine.v = si;
    q.noise.v = no;
}
// One chunk of a layer's filters, limit and VCA from o added into x. kHp:
// the high-pass runs.
template <bool kHp>
__attribute__((noinline)) void filterPass(const float* o, float* x, LayerV& V, LayerRamp& q) {
    Svf h = V.hp, l = V.lp;
    float A = q.a.v, hg = q.hg.v, hh = q.hh, hk = q.hk.v, lg = q.lg.v, lh = q.lh, lk = q.lk.v;
    const float dA = q.a.d, dhg = q.hg.d, dhk = q.hk.d, dlg = q.lg.d, dlk = q.lk.d;
    for (int i = 0; i < kChunk; ++i) {
        float s = o[i];
        float lp, bp, hp;
        if (kHp) {
            svfStep(h, SvfCoef{hg, hk, hh}, s, lp, bp, hp);
            s = hp;
            hg += dhg;
            hk += dhk;
            hh = svfHNext(hh, hg, hk);
        }
        const float kk = svfLevelK(lk, q.lkMin, l);   // + the state's level: singing, bounded
        lh = svfHTrack(lh, lg, kk);
        svfStep(l, SvfCoef{lg, kk, lh}, s, lp, bp, hp);
        x[i] += limit(lp) * A;
        A += dA;
        lg += dlg;
        lk += dlk;
    }
    V.hp = h;
    V.lp = l;
    q.a.v = A;
    q.hg.v = hg;
    q.hh = hh;
    q.hk.v = hk;
    q.lg.v = lg;
    q.lh = lh;
    q.lk.v = lk;
}
// A silent layer: its phase runs on.
void skipLayer(LayerV& V, LayerRamp& q) {
    V.ph += float(kChunk) * q.dt.v + 0.5f * float(kChunk * (kChunk - 1)) * q.dt.d;
    V.ph -= float(int(V.ph));
    V.z = 0.0f;
    q.dt.v += float(kChunk) * q.dt.d;
}
// One chunk of the ring modulator into L / R: x (1 - d + d sin).
__attribute__((noinline)) void outPass(const float* x, float* L, float* R, float& ph, Lin inc, Lin depth, bool ring) {
    if (!ring) {
        for (int i = 0; i < kChunk; ++i) {
            L[i] += x[i];
            R[i] += x[i];
        }
        return;
    }
    float p = ph, d = inc.v, m = depth.v;
    for (int i = 0; i < kChunk; ++i) {
        const float o = x[i] * (1.0f - m + m * parabola(p));
        L[i] += o;
        R[i] += o;
        p += d;
        if (p >= 1.0f) p -= 1.0f;
        d += inc.d;
        m += depth.d;
    }
    ph = p;
}

// The sub-osc functions of phase 0..1 (Noise: the held value).
inline float fnWave(int fn, float p, float held) {
    switch (fn) {
        case kFnSine: return sinePar(p);
        case kFnSaw: return 1.0f - (p + p);   // falling
        case kFnRamp: return p + p - 1.0f;    // rising
        case kFnSquare: return p < 0.5f ? 1.0f : -1.0f;
        default: return held;
    }
}
inline float triOf(float p) { return p < 0.25f ? 4.0f * p : (p < 0.75f ? 2.0f - 4.0f * p : 4.0f * p - 4.0f); }

CSTYPE_PER_BLOCK void refresh(SlotState& S, const SynthParams& p) {
    const float* E = p.end;
    static const float kOct[4] = {-1.0f, 0.0f, 1.0f, 2.0f};
    for (int j = 0; j < 2; ++j) {
        const float* P = E + j * kLayer2;
        Layer& Y = S.L[j];
        Y.semi = 12.0f * kOct[enumOf(P[kFeet], k2)] + (j ? 0.01f * clampf(E[kDetune], -50.0f, 50.0f) : 0.0f);
        Y.saw = P[kSaw] >= 0.5f;
        Y.pulse = P[kPulse] >= 0.5f;
        Y.pw = clampf(P[kPw], 0.0f, 1.0f);
        Y.pwm = clampf(P[kPwm], 0.0f, 1.0f);
        Y.hpHz = clampf(P[kHpfCutoff], 20.0f, 20000.0f);
        Y.lpHz = clampf(P[kLpfCutoff], 20.0f, 20000.0f);
        Y.hpRes = clampf(P[kHpfRes], 0.0f, 1.0f);
        Y.lpRes = clampf(P[kLpfRes], 0.0f, 1.0f);
        Y.il = clampf(P[kInitLevel], -1.0f, 1.0f);
        Y.al = clampf(P[kAttackLevel], -1.0f, 1.0f);
        setIlAl(Y.fc, P[kFAttack], P[kFDecay], P[kFRelease]);
        setContour(Y.vc, P[kAttack], P[kDecay], P[kSustain], P[kRelease]);
    }
    S.bril = clampf(E[kBrilliance], -1.0f, 1.0f);
    S.resAdd = 0.5f * clampf(E[kResonance], -1.0f, 1.0f);
    S.rmHz = clampf(E[kRmSpeed], 0.1f, 2000.0f);
    S.rmSweep = kRmSweepOct * clampf(E[kRmSweep], -1.0f, 1.0f);
    S.rmDecC = blockCoef(clampf(E[kRmDecay], 0.0f, 10.0f));
    S.fn = uint8_t(enumOf(E[kFunction], kFnNoise));
    S.fnInc = clampf(E[kSpeed], 0.1f, 20.0f) * kBlockT;
    S.toVco = kFnSemi * clampf(E[kToVco], 0.0f, 1.0f);
    S.toVcf = kFnOct * clampf(E[kToVcf], 0.0f, 1.0f);
    S.toVca = clampf(E[kToVca], 0.0f, 1.0f);
    S.initBril = clampf(E[kInitBril], 0.0f, 1.0f);
    S.initLevel = clampf(E[kInitLevelVel], 0.0f, 1.0f);
    S.aVco = kTouchVib * clampf(E[kAfterVco], 0.0f, 1.0f);
    S.aVcf = kTouchOct * clampf(E[kAfterVcf], 0.0f, 1.0f);
    S.aVca = clampf(E[kAfterVca], 0.0f, 1.0f);
    S.ribbon = clampf(E[kRibbon], -1.0f, 1.0f) * clampf(E[kRibbonRange], 0.0f, 24.0f);
    S.glideMode = uint8_t(enumOf(E[kGlideMode], kLegatoOverlap));
    const float gt = clampf(E[kGlideTime], 0.0f, 3.0f);
    S.glideC = gt < 0.0005f ? 0.0f : fastExp2(-4.3219281f * kBlockT / gt);
    S.serial = p.serial;
    S.valid = 1;
}

inline float damping(float res) { return 2.0f * (1.0f - kSvfRes * clampf(res, 0.0f, 1.0f)); }

class CstypeEngine final : public ISynthEngine {
public:
    int32_t id() const override { return kEngineId; }
    const char* name() const override { return "CSTYPE"; }

    void slotReset(SynthSlotScratch& sc) override { std::memset(sc.bytes, 0, sizeof(sc.bytes)); }

    CSTYPE_PER_BLOCK void prepare(SynthSlotScratch& sc, const SynthParams& p) override {
        if (p.count < kParamCount) return;
        SlotState& S = sc.as<SlotState>();
        const float* E = p.end;
        if (!S.valid || S.serial != p.serial || p.moving) refresh(S, p);
        const bool set = S.lvSet;
        for (int j = 0; j < 2; ++j) {
            const float* P = E + j * kLayer2;
            Layer& Y = S.L[j];
            const float to[3] = {kDrive * clampf(P[kSine], 0.0f, 1.0f), kDrive * clampf(P[kNoise], 0.0f, 1.0f),
                                 clampf(P[kLevel], 0.0f, 1.0f)};
            std::memcpy(Y.lv0, set ? Y.lv1 : to, sizeof(Y.lv0));
            std::memcpy(Y.lv1, to, sizeof(Y.lv1));
            Y.on = Y.lv0[2] > 0.0f || Y.lv1[2] > 0.0f;
            Y.hpOn = Y.hpHz > kHpOffHz;   // (Brilliance moves a 20 Hz high-pass inaudibly)
            const float hk = damping(Y.hpRes + S.resAdd), lk = damping(Y.lpRes + S.resAdd);
            Y.hk[0] = set ? Y.hk[1] : hk;
            Y.lk[0] = set ? Y.lk[1] : lk;
            Y.hk[1] = hk;
            Y.lk[1] = lk;
            // The layer's PWM LFO (a triangle per slot).
            float ph = Y.pwmPh + clampf(P[kPwmSpeed], 0.1f, 20.0f) * kBlockT;
            if (ph >= 1.0f) ph -= float(int(ph));
            Y.pwmPh = ph;
            Y.tri0 = set ? Y.tri1 : triOf(ph);
            Y.tri1 = triOf(ph);
        }
        S.rmDepth[0] = set ? S.rmDepth[1] : clampf(E[kRmDepth], 0.0f, 1.0f);
        S.rmDepth[1] = clampf(E[kRmDepth], 0.0f, 1.0f);
        S.ringOn = S.rmDepth[0] > 0.0f || S.rmDepth[1] > 0.0f;
        // The sub-osc LFO (Noise: a new value each cycle) and the Touch vibrato.
        float ph = S.fnPh + S.fnInc;
        if (ph >= 1.0f) {
            ph -= float(int(ph));
            S.seed = S.seed * 1664525u + 1013904223u;
            S.fnHeld = float(int32_t(S.seed)) * (1.0f / 2147483648.0f);
        }
        S.fnPh = ph;
        S.fn0 = set ? S.fn1 : fnWave(S.fn, ph, S.fnHeld);
        S.fn1 = fnWave(S.fn, ph, S.fnHeld);
        float vp = S.vibPh + kVibHz * kBlockT;
        if (vp >= 1.0f) vp -= 1.0f;
        S.vibPh = vp;
        S.vib0 = set ? S.vib1 : sinePar(vp);
        S.vib1 = sinePar(vp);
        S.touch0 = set ? S.touch1 : clampf(E[kTouch], 0.0f, 1.0f);
        S.touch1 = clampf(E[kTouch], 0.0f, 1.0f);
        S.lvSet = 1;
    }

    CSTYPE_PER_BLOCK void noteOn(SynthVoice& v, const SynthParams& p, const SynthNote& n) override {
        if (p.count < kParamCount) return;
        SlotState& S = v.slotScratch->as<SlotState>();
        VoiceState& V = v.as<VoiceState>();
        if (!S.valid || S.serial != p.serial) refresh(S, p);
        const bool held = n.reused && V.started;
        if (!held) {
            for (int j = 0; j < 2; ++j) {
                S.seed = S.seed * 1664525u + 1013904223u;
                V.L[j].ph = float(S.seed >> 8) * (1.0f / 16777216.0f);
            }
            V.noise = S.seed ^ 0x9E3779B9u;
            V.rmPh = 0.0f;
            for (int j = 0; j < 2; ++j) {
                V.L[j].lp.s1 = kSeed;
                V.L[j].fenv = S.L[j].il;   // the contour starts at the initial level
            }
        }
        const int mode = S.glideMode;
        const bool alwaysGlide = mode == kAlways || mode == kLegato;
        V.target = n.pitch;
        V.glide = S.glideC > 0.0f && (held || S.hasLast) && !n.fxGlide && (alwaysGlide || n.overlap);
        if (!V.glide) V.pitch = n.pitch;
        else if (!held) V.pitch = S.lastPitch;
        const bool legato = (mode == kLegato || mode == kLegatoOverlap) && n.overlap;
        if (!legato || (V.L[0].aStage == kIdle && V.L[1].aStage == kIdle)) {
            for (LayerV& Y : V.L) {
                Y.fStage = kAtt;   // from the current levels (no click on a reused voice)
                Y.aStage = kAtt;
            }
            V.rmEnv = 1.0f;
        }
        V.vel = clampf(n.velocity, 0.0f, 1.0f);
        S.lastPitch = n.pitch;
        S.hasLast = 1;
        V.gate = 1;
        V.started = 1;
        float lv = 0.0f;
        for (int j = 0; j < 2; ++j)
            if (S.L[j].lv1[2] > 0.0f && V.L[j].aenv > lv) lv = V.L[j].aenv;
        v.level = n.reused ? lv : 1.0f;
    }

    void noteOff(SynthVoice& v, const SynthParams&) override {
        VoiceState& V = v.as<VoiceState>();
        V.gate = 0;
        for (LayerV& Y : V.L) {
            if (Y.fStage != kIdle) Y.fStage = kRel;
            if (Y.aStage != kIdle) Y.aStage = kRel;
        }
    }

    CSTYPE_PER_BLOCK bool render(SynthVoice& v, const SynthParams& p, float g0, float gInc, float* Lo, float* Ro) override {
        VoiceState& V = v.as<VoiceState>();
        if (!V.started || p.count < kParamCount) {
            v.level = 0.0f;
            return false;
        }
        const SlotState& S = v.slotScratch->as<SlotState>();
        const float pitch0 = V.pitch;
        if (V.pitch != V.target) {
            V.pitch = V.glide ? V.target + (V.pitch - V.target) * S.glideC : V.target;
            if (__builtin_fabsf(V.pitch - V.target) < 0.01f) V.pitch = V.target;
        }
        // Velocity: the attack levels (Init -> Bril) and the VCAs (Init -> Level).
        const float velBril = 1.0f + S.initBril * (V.vel - 1.0f), velLevel = 1.0f + S.initLevel * (V.vel - 1.0f);
        // The pitch at the block start / end: the note, the sub-osc, the Touch vibrato, the Ribbon.
        const float key0 = pitch0 + v.bendStart + S.ribbon, key1 = V.pitch + v.bend + S.ribbon;
        const float pm0 = key0 + S.toVco * S.fn0 + S.aVco * S.touch0 * S.vib0;
        const float pm1 = key1 + S.toVco * S.fn1 + S.aVco * S.touch1 * S.vib1;
        // The cutoff offset common to both layers: Key, the sub-osc, Touch.
        const float co0 = kKeyOct * (key0 - 60.0f) + S.toVcf * S.fn0 + S.aVcf * S.touch0;
        const float co1 = kKeyOct * (key1 - 60.0f) + S.toVcf * S.fn1 + S.aVcf * S.touch1;
        // The VCA factor common to both layers: velocity, the sub-osc tremolo, Touch (up to +6 dB).
        const float va0 = velLevel * (1.0f - S.toVca * 0.5f * (1.0f - S.fn0)) * (1.0f + S.aVca * S.touch0);
        const float va1 = velLevel * (1.0f - S.toVca * 0.5f * (1.0f - S.fn1)) * (1.0f + S.aVca * S.touch1);
        const float gEnd = g0 + gInc * float(kBlock);
        LayerRamp q[2];
        bool run[2] = {false, false};   // the layer's passes run this block
        float peak = 0.0f;
        bool alive = false;
        for (int j = 0; j < 2; ++j) {
            const Layer& Y = S.L[j];
            LayerV& W = V.L[j];
            LayerRamp& r = q[j];
            const float fe0 = W.fenv, ae0 = W.aenv;
            W.fenv = stepIlAl(W.fStage, W.fenv, Y.fc, Y.il, Y.al * velBril);
            W.aenv = step(W.aStage, W.aenv, Y.vc);
            const bool done = W.aStage == kIdle || (W.aStage == kDec && W.aenv == 0.0f && Y.vc.sustain == 0.0f);
            if (!done && Y.on) alive = true;   // a layer at Level 0 does not hold the voice
            if (Y.on && W.aenv > peak) peak = W.aenv;
            r.dt = lin(incOf(pm0, Y.semi, 0.0f, kMaxDt), incOf(pm1, Y.semi, 0.0f, kMaxDt));
            if (!Y.on || done) continue;
            run[j] = true;
            auto duty = [&Y](float tri) { return 0.5f - 0.45f * clampf(Y.pw + Y.pwm * 0.5f * (1.0f + tri), 0.0f, 1.0f); };
            r.du = lin(duty(Y.tri0), duty(Y.tri1));
            r.gs = Y.saw ? kDrive : 0.0f;
            r.gp = Y.pulse ? kDrive : 0.0f;
            r.sine = lin(Y.lv0[0], Y.lv1[0]);
            r.noise = lin(Y.lv0[1], Y.lv1[1]);
            // Cutoffs: Brilliance (LPF x 2^(2 b), HPF x 2^b), the contour, the common offset.
            const float lg1 = svfG(Y.lpHz, 2.0f * S.bril + kEnvOct * W.fenv + co1);
            const float hg1 = svfG(Y.hpHz, S.bril + co1 - kKeyOct * (key1 - 60.0f));
            const float lg0 = V.set ? W.lpG : svfG(Y.lpHz, 2.0f * S.bril + kEnvOct * fe0 + co0);
            const float hg0 = V.set ? W.hpG : svfG(Y.hpHz, S.bril + co0 - kKeyOct * (key0 - 60.0f));
            W.lpG = lg1;
            W.hpG = hg1;
            r.lg = lin(lg0, lg1);
            r.hg = lin(hg0, hg1);
            // Damping: the layer's Res (+ Resonance); the LPF adds its level per sample.
            const float hk0 = Y.hk[0] > kHpKMin ? Y.hk[0] : kHpKMin, hk1 = Y.hk[1] > kHpKMin ? Y.hk[1] : kHpKMin;
            r.lk = lin(Y.lk[0], Y.lk[1]);
            r.hk = lin(hk0, hk1);
            r.lh = svfH(lg0, Y.lk[0]);
            r.hh = svfH(hg0, hk0);
            r.lkMin = svfKMin(lg0 > lg1 ? lg0 : lg1);
            // VCA: the envelope x level x the common factor x trim x the framework gain.
            r.a = lin(ae0 * Y.lv0[2] * va0 * kOutTrim * g0, W.aenv * Y.lv1[2] * va1 * kOutTrim * gEnd);
            if (!Y.hpOn) W.hp = Svf{0.0f, 0.0f};
            // A low-pass set to sing with nothing in it (a Res raised mid-note): seed it again.
            if (Y.lk[1] < 0.0f && __builtin_fabsf(W.lp.s1) + __builtin_fabsf(W.lp.s2) < 1.0e-9f) W.lp.s1 = kSeed;
        }
        V.set = 1;
        // The ring modulator's rate: Speed x 2^(Sweep x its envelope).
        const float rm0 = V.rmEnv;
        V.rmEnv *= S.rmDecC;
        if (V.rmEnv < 1.0e-4f) V.rmEnv = 0.0f;
        const float ri0 = clampf(S.rmHz * fastExp2(S.rmSweep * rm0) * kInvFs, 0.0f, 0.45f);
        const float ri1 = clampf(S.rmHz * fastExp2(S.rmSweep * V.rmEnv) * kInvFs, 0.0f, 0.45f);
        const Lin rmInc = lin(ri0, ri1), rmDepth = lin(S.rmDepth[0], S.rmDepth[1]);
        float x[kChunk], o[kChunk];   // the voice's sum, a layer's oscillators
        for (uint32_t c = 0; c < kBlock; c += kChunk) {
            std::memset(x, 0, sizeof(x));
            for (int j = 0; j < 2; ++j) {
                LayerV& W = V.L[j];
                if (run[j]) {
                    const bool sine = S.L[j].lv0[0] > 0.0f || S.L[j].lv1[0] > 0.0f;
                    const bool noise = S.L[j].lv0[1] > 0.0f || S.L[j].lv1[1] > 0.0f;
                    oscPass(o, W, V.noise, q[j], sine, noise);
                    if (S.L[j].hpOn) filterPass<true>(o, x, W, q[j]);
                    else filterPass<false>(o, x, W, q[j]);
                }
                else skipLayer(W, q[j]);
            }
            Lin ri = {rmInc.v + float(c) * rmInc.d, rmInc.d}, rd = {rmDepth.v + float(c) * rmDepth.d, rmDepth.d};
            outPass(x, Lo + c, Ro + c, V.rmPh, ri, rd, S.ringOn);
        }
        for (LayerV& W : V.L) {
            W.hp.s1 = flush(W.hp.s1);
            W.hp.s2 = flush(W.hp.s2);
            W.lp.s1 = flush(W.lp.s1);
            W.lp.s2 = flush(W.lp.s2);
        }
        v.level = peak;
        if (!alive) {
            V.started = 0;
            for (LayerV& W : V.L) {
                W.aStage = W.fStage = kIdle;
                W.aenv = W.fenv = 0.0f;
            }
            return false;
        }
        return true;
    }
};

CstypeEngine gCstype;

}  // namespace

ISynthEngine* engine() { return &gCstype; }

}  // namespace cstype
}  // namespace audio
}  // namespace ot
