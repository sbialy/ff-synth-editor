// Copied from opentracker-synths (https://github.com/opentracker-fw/opentracker-synths, modules/dtype/src/dtype.cpp, commit eb150a5f741b),
// Copyright (c) 2026 Marcin Spoczynski, MIT licence, see licenses/LICENSE-OpenTracker-synths-MIT.txt. Not modified, except this notice.
// D-Type three-oscillator mono engine (see dtype.h).
//
// The block runs in 64-frame chunks of four passes: VCO 3 and the noise (a
// per-voice LCG, pink through a 3-pole filter) start the mix and give the
// modulation source; VCO 1 and 2 add to it with the Osc Mod FM (each pass
// skipped while its VCO is silent); the ladder and the VCA. Saw and pulse
// edges get a polyBLEP residual, the triangle's corners a polyBLAMP one,
// one frame late (vcoFrame). The ladder: the mix plus the feedback of the
// last output sample into four one-pole (trapezoidal) stages with the
// feedback loop solved for this sample, a rational tanh on the loop input,
// a cubic soft clip on each stage input.
// The contours, glide, drift, pitch, cutoff (Contour, Key Track, Filter
// Mod), Emphasis, levels and the VCA run at block rate and are ramped across
// the 128-frame block from the previous block's end values (no step when a
// macro slams a parameter). The Filter Mod source is sampled at the block
// end (block rate: a documented limitation); Osc Mod is per sample.
#include "dtype.h"

#include <cstring>

#include "audio/dsp.h"

#if defined(__GNUC__) && !defined(__clang__)
#define DTYPE_PER_BLOCK __attribute__((optimize("Os")))
#else
#define DTYPE_PER_BLOCK
#endif

namespace ot {
namespace audio {
namespace dtype {

namespace {

constexpr float kBlockT = float(kBlock) / kSampleRate;
constexpr float kInvFs = 1.0f / kSampleRate;
constexpr float kPi = 3.14159265f;
constexpr float kLog2e = 1.44269504f;
constexpr float kDrive = 0.8f;          // mixer level 100 % -> ladder input (one VCO ~0.8, three saturate it)
constexpr float kOutTrim = 0.55f;       // ladder output -> slot bus (the ACD Init level)
constexpr float kSeedNoise = 2.0e-4f;   // always-on noise floor: seeds self-oscillation
constexpr float kEmphK = 5.3f;          // loop gain at Emphasis 100 % (oscillates above 4: from ~75 %)
constexpr float kMakeUp = 0.5f;         // half the pass-band loss made up: x (1 + 0.5 k)
constexpr float kContourOct = 6.0f;     // Contour 100 % = +6 octaves
constexpr float kFilterModOct = 4.0f;   // Filter Mod x Wheel 100 % = +-4 octaves
// Feedback 100 %: the last output sample back into the mixer at 0.9 x the
// ladder's pass-band loss (1 + k): a DC loop gain of 0.9 (bass boost and
// drive, no latch-up: the loop phase reaches 0 only at DC), ~+11 dB at k = 3.
constexpr float kFeedbackLoop = 0.9f;
constexpr float kAttOver = 1.3f;        // the attack aims past 1 (an RC charging curve)
constexpr float kShortRel = 0.005f;     // Decay switch Off: the release
constexpr float kFmDepth = 0.9f;        // Osc Mod x Wheel 100 %: the frequency x (1 +- 0.9) (linear FM)
constexpr float kFmPeak = 2.7f;         // the modulation source's peak (pink noise 2.63, a narrow pulse 1.8)
constexpr float kDriftCents = 1.5f;     // per-VCO random walk bound
constexpr float kDriftStep = 0.3f;      // cents per block (uniform +-0.15)
constexpr float kPinkTrim = 0.34f;      // pink at about the white rms
constexpr float kC3 = 48.0f;            // VCO 3 off the keyboard: from C3
constexpr float kMaxDt = 0.45f;         // phase increment ceiling (polyBLEP needs < 0.5)

inline float clampf(float x, float lo, float hi) { return x < lo ? lo : (x > hi ? hi : x); }
inline int enumOf(float x, int max) {
    const int i = int(x + 0.5f);
    return i < 0 ? 0 : (i > max ? max : i);
}
inline float fastExp2(float x) {
    x = clampf(x, -60.0f, 60.0f);
    const int i = int(x + (x >= 0.0f ? 0.5f : -0.5f));
    const float f = x - float(i);
    const float p = 1.0f + f * (0.693147181f + f * (0.240226507f + f * (0.0555041087f + f * (0.00961812911f + f * 0.00133335581f))));
    const uint32_t b = uint32_t(i + 127) << 23;
    float s;
    std::memcpy(&s, &b, 4);
    return p * s;
}
// Per-block factor reaching ~1 % after t seconds (0 = instant).
inline float blockCoef(float t) { return t <= 0.0005f ? 0.0f : fastExp2(-4.6f * kLog2e * kBlockT / t); }
// tan(x) for 0 <= x < pi / 2 (Pade 7/6; < 0.1 % up to 1.4).
inline float tanPade(float x) {
    const float x2 = x * x;
    return x * (135135.0f - x2 * (17325.0f - x2 * (378.0f - x2))) /
           (135135.0f - x2 * (62370.0f - x2 * (3150.0f - 28.0f * x2)));
}
inline float flush(float x) { return __builtin_fabsf(x) < 1.0e-20f ? 0.0f : x; }

enum Stage : uint8_t { kIdle = 0, kAtt, kDec, kRel };
// Oscillator shapes (the six waves of each VCO map onto these).
enum Shape : uint8_t { kShTri = 0, kShTriSaw, kShSaw, kShPulse, kShOff };

struct Contour {
    float attC, decC, relC, sustain;
    uint8_t attInstant;
};

struct SlotState {
    uint32_t serial;
    uint32_t seed;                      // note-on phases, noise and drift seeds
    uint8_t valid, hasLast, glideMode, pink;
    uint8_t kb3, lvSet, shape[3];
    float sign[3];                      // +1, or -1 for VCO 3's Rev Saw
    float duty[3];                      // pulse high fraction
    float semi[3];                      // range + tune + fine, semitones
    float lastPitch;                    // the slot's previous note (glide source)
    float glideC;                       // per-block glide factor (0 = no glide)
    float cutoff, k;
    float contourOct, key;              // octaves at a full contour; octaves per semitone around C4
    float fmOct, oscFm, modMix;         // Filter Mod / Osc Mod depths (x Wheel, squared), source mix
    float lv0[5], lv1[5];               // VCO 1-3, noise (x kDrive), feedback: block start / end
    Contour fc, lc;                     // filter / loudness contours
};
static_assert(sizeof(SlotState) <= kSynthSlotScratchBytes, "D-Type slot state");

struct VoiceState {
    float ph[3];                        // VCO phases 0..1
    float z[3];                         // VCO samples held back one frame (their edge corrections)
    float drift[3];                     // cents
    float s[4];                         // ladder stage states
    float y;                            // ladder output, last sample (feedback)
    float pk[3];                        // pink noise poles
    float fenv, lenv;
    float pitch, target;                // glided note pitch, glide target
    float G, k, out;                    // ladder gain, loop gain, VCA x trim at the end of the last block
    float mod;                          // modulation source at the end of the last block (Filter Mod)
    uint32_t noise;
    uint8_t fStage, lStage, gate, started, set;
};
static_assert(sizeof(VoiceState) <= kSynthVoiceStateBytes, "D-Type voice state");

// A block-rate value ramped across the block: its value now and the
// per-frame increment.
struct Lin {
    float v, d;
};
constexpr int kChunk = 64;   // frames per pass: two kChunk buffers on the stack (512 B)

// One VCO frame, band-limited: the steps (saw wrap, pulse edges) get the
// two-frame polyBLEP residual, the triangle's corners the polyBLAMP one. An
// edge is found when it is crossed (the wrap, or a change of the hi / lo
// state carried in `hi`), so the frame before it is still held in z: it gets
// the residual's first half, the frame now the second. Returns the held
// frame (the VCO sounds one frame late) and holds the new one.
// Residuals of a step h at the fraction x of a frame past the edge: before
// h x^2 / 2, after -h (1 - x)^2 / 2; of a slope change c per frame: before
// c x^3 / 6, after c (1 - x)^3 / 6.
template <int kSh>
inline float vcoFrame(float& p, float& z, bool& hi, float d, float duty) {
    constexpr float kSaw = kSh == kShSaw ? 1.0f : (kSh == kShTriSaw ? 0.5f : 0.0f);
    constexpr float kTri = kSh == kShTri ? 1.0f : (kSh == kShTriSaw ? 0.5f : 0.0f);
    p += d;
    const bool wrap = p >= 1.0f;
    if (wrap) p -= 1.0f;
    float out = z, cur = 0.0f;
    if (kSaw > 0.0f) {   // 2p - 1: a step of -2 at the wrap
        cur = kSaw * (p + p - 1.0f);
        if (wrap) {
            const float x = p / d, y = 1.0f - x;
            cur += kSaw * y * y;
            out -= kSaw * x * x;
        }
    }
    if (kTri > 0.0f) {   // 4 |p - 1/2| - 1: corners of -8 d per frame at the wrap, +8 d at one half
        cur += kTri * (4.0f * __builtin_fabsf(p - 0.5f) - 1.0f);
        const float k = kTri * (8.0f / 6.0f) * d;
        if (wrap) {
            const float x = p / d, y = 1.0f - x;
            cur -= k * y * y * y;
            out -= k * x * x * x;
        }
        const bool h = p < 0.5f;
        if (!h && hi) {
            const float x = (p - 0.5f) / d, y = 1.0f - x;
            cur += k * y * y * y;
            out += k * x * x * x;
        }
        hi = h;
    }
    if (kSh == kShPulse) {   // +1 below the duty, -1 above, less its mean: +2 at the wrap, -2 at the duty
        const bool h = p < duty;
        cur = (h ? 1.0f : -1.0f) - (duty + duty - 1.0f);
        if (wrap) {
            const float x = p / d, y = 1.0f - x;
            cur -= y * y;
            out += x * x;
        }
        if (!h && (hi || wrap)) {
            const float x = (p - duty) / d, y = 1.0f - x;
            cur += y * y;
            out -= x * x;
        }
        hi = h;
    }
    z = cur;
    return out;
}
// The hi / lo state of a phase for vcoFrame (the triangle's half, the pulse's duty).
template <int kSh>
inline bool vcoHi(float p, float duty) {
    return p < (kSh == kShPulse ? duty : 0.5f);
}
// Rational tanh, exact at 0 and +-3 (where it reaches +-1), clamped beyond.
inline float tanhR(float x) {
    x = clampf(x, -3.0f, 3.0f);
    const float x2 = x * x;
    return x * (27.0f + x2) / (27.0f + 9.0f * x2);
}
// Cubic soft clip of a ladder stage input.
inline float clip3(float x) { return x - x * x * x * (1.0f / 27.0f); }

// One chunk of VCO 3 and the noise: x = their mix (with the seed noise);
// m = the Osc Mod factor of the modulation source (VCO 3 .. noise by Mod
// Mix; 1 at fm 0). kShOff: VCO 3 neither heard nor a source (its phase
// still runs). Pink is a run-time switch here (flash: one pass per shape).
template <int kSh>
__attribute__((noinline)) void srcPass(float* x, float* m, VoiceState& V, Lin& dt, Lin& l3, Lin& ln, float sign, float duty,
                                       float mm, float fm, bool pink) {
    float p = V.ph[2], z = V.z[2], d = dt.v, a = l3.v, b = ln.v;
    const float dd = dt.d, da = l3.d, db = ln.d;
    bool hi = vcoHi<kSh>(p, duty);
    float k0 = V.pk[0], k1 = V.pk[1], k2 = V.pk[2];
    uint32_t nz = V.noise;
    float o = 0.0f, n = 0.0f;
    if (kSh == kShOff) {
        p += float(kChunk) * d + 0.5f * float(kChunk * (kChunk - 1)) * dd;
        p -= float(int(p));
        z = 0.0f;
    }
    for (int i = 0; i < kChunk; ++i) {
        if (kSh != kShOff) o = sign * vcoFrame<kSh>(p, z, hi, d, duty);
        nz = nz * 1664525u + 1013904223u;
        const float w = float(int32_t(nz)) * (1.0f / 2147483648.0f);
        n = w;
        if (pink) {   // 3-pole pink approximation (-3 dB / octave)
            k0 = 0.99765f * k0 + w * 0.0990460f;
            k1 = 0.96300f * k1 + w * 0.2965164f;
            k2 = 0.57000f * k2 + w * 1.0526913f;
            n = (k0 + k1 + k2 + w * 0.1848f) * kPinkTrim;
        }
        x[i] = a * o + b * n + kSeedNoise * w;
        // The Osc Mod factor: linear FM (the pitch centre stays). Only pink
        // noise reaches below -1 (the factor must stay > 0); the peaks above
        // (pulse 1.8, pink 2.63) are in the caller's increment ceiling.
        float u = fm * (o + mm * (n - o));
        if (u < -1.0f) u = -1.0f;
        m[i] = 1.0f + kFmDepth * u;
        d += dd;
        a += da;
        b += db;
    }
    V.ph[2] = p;
    V.z[2] = z;
    dt.v = d;
    l3.v = a;
    ln.v = b;
    V.pk[0] = k0;
    V.pk[1] = k1;
    V.pk[2] = k2;
    V.noise = nz;
    V.mod = o + mm * (n - o);
}

// One chunk of VCO 1 or 2 into the mix; the increment x the Osc Mod factor m.
template <int kSh>
__attribute__((noinline)) void vcoPass(float* x, const float* m, float& ph, float& zh, Lin& dt, Lin& lv, float duty) {
    float p = ph, z = zh, d = dt.v, l = lv.v;
    const float dd = dt.d, dl = lv.d;
    bool hi = vcoHi<kSh>(p, duty);
    for (int i = 0; i < kChunk; ++i) {
        x[i] += l * vcoFrame<kSh>(p, z, hi, d * m[i], duty);
        d += dd;
        l += dl;
    }
    ph = p;
    zh = z;
    dt.v = d;
    lv.v = l;
}
// A silent VCO: its phase runs on, nothing held.
void skipVco(float& ph, float& zh, Lin& dt, Lin& lv) {
    ph += float(kChunk) * dt.v + 0.5f * float(kChunk * (kChunk - 1)) * dt.d;
    ph -= float(int(ph));
    zh = 0.0f;
    dt.v += float(kChunk) * dt.d;
    lv.v += float(kChunk) * lv.d;
}

struct LadderRamp {
    Lin G, r, k;                        // stage gain, 1 / (1 + k G^4), loop gain
    Lin a;                              // VCA x trim x make-up
    Lin fb;                             // feedback gain
};
// One chunk of the ladder and the VCA into L / R:
// y4 = G^4 u + (1 - G) (((s0 G + s1) G + s2) G + s3), u = tanh(x + fb y - k y4).
__attribute__((noinline)) void ladderPass(const float* x, float* L, float* R, VoiceState& V, LadderRamp& q) {
    float s0 = V.s[0], s1 = V.s[1], s2 = V.s[2], s3 = V.s[3], y = V.y;
    float G = q.G.v, r = q.r.v, k = q.k.v, a = q.a.v, fb = q.fb.v;
    const float dG = q.G.d, dr = q.r.d, dk = q.k.d, da = q.a.d, dfb = q.fb.d;
    for (int i = 0; i < kChunk; ++i) {
        const float sig = (1.0f - G) * (((s0 * G + s1) * G + s2) * G + s3);
        const float u = tanhR((x[i] + fb * y - k * sig) * r);
        float v = G * (clip3(u) - s0);
        const float y0 = v + s0;
        s0 = y0 + v;
        v = G * (clip3(y0) - s1);
        const float y1 = v + s1;
        s1 = y1 + v;
        v = G * (clip3(y1) - s2);
        const float y2 = v + s2;
        s2 = y2 + v;
        v = G * (clip3(y2) - s3);
        y = v + s3;
        s3 = y + v;
        const float o = y * a;
        L[i] += o;
        R[i] += o;
        G += dG;
        r += dr;
        k += dk;
        a += da;
        fb += dfb;
    }
    V.s[0] = s0;
    V.s[1] = s1;
    V.s[2] = s2;
    V.s[3] = s3;
    V.y = y;
    q.G.v = G;
    q.r.v = r;
    q.k.v = k;
    q.a.v = a;
    q.fb.v = fb;
}

using SrcPass = void (*)(float*, float*, VoiceState&, Lin&, Lin&, Lin&, float, float, float, float, bool);
const SrcPass kSrc[5] = {srcPass<kShTri>, srcPass<kShTriSaw>, srcPass<kShSaw>, srcPass<kShPulse>, srcPass<kShOff>};
using VcoPass = void (*)(float*, const float*, float&, float&, Lin&, Lin&, float);
const VcoPass kVco[4] = {vcoPass<kShTri>, vcoPass<kShTriSaw>, vcoPass<kShSaw>, vcoPass<kShPulse>};

// Phase increment of a VCO at note + offset semitones + drift cents.
DTYPE_PER_BLOCK float incOf(float note, float semi, float drift, float maxDt) {
    return clampf(440.0f * kInvFs * fastExp2((note + semi + 0.01f * drift - 69.0f) * (1.0f / 12.0f)), 1.0e-7f, maxDt);
}
// Ladder stage gain G = g / (1 + g), g = tan(pi f / fs), at cutoff x 2^oct.
DTYPE_PER_BLOCK float stageGain(float cutoff, float oct) {
    const float hz = clampf(cutoff * fastExp2(oct), 8.0f, 0.45f * kSampleRate);
    const float t = tanPade(kPi * hz * kInvFs);
    return t / (1.0f + t);
}

DTYPE_PER_BLOCK void setContour(Contour& c, float att, float dec, float sus, bool decaySw) {
    // Attack: an RC curve towards 1.3 that reaches 1 after Attack seconds.
    c.attInstant = att <= kBlockT;
    c.attC = c.attInstant ? 0.0f : fastExp2(-1.466f * kLog2e * kBlockT / att);
    c.decC = blockCoef(dec);
    c.relC = blockCoef(decaySw ? dec : kShortRel);
    c.sustain = clampf(sus, 0.0f, 1.0f);
}
// One block step of a contour.
inline float step(uint8_t& st, float e, const Contour& c) {
    switch (st) {
        case kAtt:
            e = c.attInstant ? 1.0f : kAttOver - (kAttOver - e) * c.attC;
            if (e >= 1.0f) {
                e = 1.0f;
                st = kDec;
            }
            return e;
        case kDec:   // and holds at Sustain (snapped: no endless approach, no subnormals)
            e = c.sustain + (e - c.sustain) * c.decC;
            if (__builtin_fabsf(e - c.sustain) < 1.0e-5f) e = c.sustain;
            return e;
        case kRel:
            e *= c.relC;
            if (e < 1.0e-4f) {
                e = 0.0f;
                st = kIdle;
            }
            return e;
        default: return 0.0f;
    }
}

DTYPE_PER_BLOCK void refresh(SlotState& S, const SynthParams& p) {
    const float* E = p.end;
    static const float kOct[6] = {-6.0f, -2.0f, -1.0f, 0.0f, 1.0f, 2.0f};
    static const uint8_t kShape[6] = {kShTri, kShTriSaw, kShSaw, kShPulse, kShPulse, kShPulse};
    static const float kDuty[6] = {0.5f, 0.5f, 0.5f, 0.5f, 0.3f, 0.1f};
    const int rg[3] = {kVco1Range, kVco2Range, kVco3Range}, wv[3] = {kVco1Wave, kVco2Wave, kVco3Wave};
    for (int j = 0; j < 3; ++j) {
        const int w = enumOf(E[wv[j]], kNarrow);
        S.shape[j] = kShape[w];
        S.duty[j] = kDuty[w];
        S.sign[j] = 1.0f;
        S.semi[j] = 12.0f * kOct[enumOf(E[rg[j]], k2)];
    }
    if (enumOf(E[kVco3Wave], kNarrow) == kRevSaw) {   // VCO 3: Rev Saw in place of Tri-Saw
        S.shape[2] = kShSaw;
        S.sign[2] = -1.0f;
    }
    S.semi[1] += clampf(E[kVco2Tune], -24.0f, 24.0f) + 0.01f * clampf(E[kVco2Fine], -100.0f, 100.0f);
    S.semi[2] += clampf(E[kVco3Tune], -24.0f, 24.0f) + 0.01f * clampf(E[kVco3Fine], -100.0f, 100.0f);
    S.kb3 = E[kVco3Kb] >= 0.5f;
    S.pink = enumOf(E[kNoiseColour], kPink) == kPink;
    S.cutoff = clampf(E[kCutoff], 20.0f, 20000.0f);
    S.k = kEmphK * clampf(E[kEmphasis], 0.0f, 1.0f);
    S.contourOct = kContourOct * clampf(E[kContour], 0.0f, 1.0f);
    static const float kKey[4] = {0.0f, 1.0f / 3.0f, 2.0f / 3.0f, 1.0f};
    S.key = kKey[enumOf(E[kKeyTrack], kKeyFull)] * (1.0f / 12.0f);
    const float wheel = clampf(E[kWheel], 0.0f, 1.0f);
    const float om = clampf(E[kOscMod], 0.0f, 1.0f) * wheel, fm = clampf(E[kFilterMod], 0.0f, 1.0f) * wheel;
    S.oscFm = om * om;
    S.fmOct = kFilterModOct * fm * fm;
    S.modMix = clampf(E[kModMix], 0.0f, 1.0f);
    const bool decaySw = E[kDecaySw] >= 0.5f;
    setContour(S.fc, E[kFAttack], E[kFDecay], E[kFSustain], decaySw);
    setContour(S.lc, E[kLAttack], E[kLDecay], E[kLSustain], decaySw);
    S.glideMode = uint8_t(enumOf(E[kGlideMode], kLegatoOverlap));
    // Exponential glide: 95 % of the way after Glide Time.
    const float gt = clampf(E[kGlideTime], 0.0f, 3.0f);
    S.glideC = gt < 0.0005f ? 0.0f : fastExp2(-4.3219281f * kBlockT / gt);
    S.serial = p.serial;
    S.valid = 1;
}

class DtypeEngine final : public ISynthEngine {
public:
    int32_t id() const override { return kEngineId; }
    const char* name() const override { return "DTYPE"; }

    void slotReset(SynthSlotScratch& sc) override { std::memset(sc.bytes, 0, sizeof(sc.bytes)); }

    DTYPE_PER_BLOCK void prepare(SynthSlotScratch& sc, const SynthParams& p) override {
        if (p.count < kParamCount) return;
        SlotState& S = sc.as<SlotState>();
        const float* E = p.end;
        if (!S.valid || S.serial != p.serial || p.moving) refresh(S, p);
        // Levels glide from the last block's values (a macro slam does not step).
        const int lv[4] = {kVco1Level, kVco2Level, kVco3Level, kNoiseLevel};
        float to[5];
        for (int j = 0; j < 4; ++j) to[j] = kDrive * clampf(E[lv[j]], 0.0f, 1.0f);
        to[4] = kFeedbackLoop * (1.0f + S.k) * clampf(E[kFeedback], 0.0f, 1.0f);
        std::memcpy(S.lv0, S.lvSet ? S.lv1 : to, sizeof(S.lv0));
        std::memcpy(S.lv1, to, sizeof(S.lv1));
        S.lvSet = 1;
    }

    DTYPE_PER_BLOCK void noteOn(SynthVoice& v, const SynthParams& p, const SynthNote& n) override {
        if (p.count < kParamCount) return;
        SlotState& S = v.slotScratch->as<SlotState>();
        VoiceState& V = v.as<VoiceState>();
        if (!S.valid || S.serial != p.serial) refresh(S, p);
        if (!n.reused || !V.started) {
            // A fresh voice: free-running VCOs (arbitrary phases), its own noise and drift.
            for (int j = 0; j < 3; ++j) {
                S.seed = S.seed * 1664525u + 1013904223u;
                V.ph[j] = float(S.seed >> 8) * (1.0f / 16777216.0f);
                V.drift[j] = kDriftCents * (float(S.seed & 0xFFu) * (2.0f / 255.0f) - 1.0f) * 0.5f;
            }
            V.noise = S.seed ^ 0x9E3779B9u;
        }
        // Glide (ACD semantics): Always / Legato from the slot's previous note,
        // Overlap / Legato Overlap only from a held one; a Glide FX owns the start.
        const int mode = S.glideMode;
        const bool alwaysGlide = mode == kAlways || mode == kLegato;
        const bool hasFrom = (n.reused && V.started) || S.hasLast;
        const float from = n.reused && V.started ? V.pitch : S.lastPitch;
        V.target = n.pitch;
        V.pitch = S.glideC > 0.0f && hasFrom && !n.fxGlide && (alwaysGlide || n.overlap) ? from : n.pitch;
        // Legato modes: an overlapping note does not restart the contours.
        const bool legato = (mode == kLegato || mode == kLegatoOverlap) && n.overlap;
        if (!legato || V.lStage == kIdle) {
            V.fStage = kAtt;   // from the current levels (no click on a reused voice)
            V.lStage = kAtt;
        }
        S.lastPitch = n.pitch;
        S.hasLast = 1;
        V.gate = 1;
        V.started = 1;
        // A fresh voice reports full level (the framework must not take it as
        // a steal victim before its first block).
        v.level = n.reused ? V.lenv : 1.0f;
    }

    void noteOff(SynthVoice& v, const SynthParams&) override {
        VoiceState& V = v.as<VoiceState>();
        V.gate = 0;
        if (V.fStage != kIdle) V.fStage = kRel;
        if (V.lStage != kIdle) V.lStage = kRel;
    }

    DTYPE_PER_BLOCK bool render(SynthVoice& v, const SynthParams& p, float g0, float gInc, float* L, float* R) override {
        VoiceState& V = v.as<VoiceState>();
        if (!V.started || p.count < kParamCount) {
            v.level = 0.0f;
            return false;
        }
        const SlotState& S = v.slotScratch->as<SlotState>();
        constexpr float n = 1.0f / float(kBlock);
        // Contours, glide, drift (one block step).
        const float fe0 = V.fenv;
        V.fenv = step(V.fStage, V.fenv, S.fc);
        V.lenv = step(V.lStage, V.lenv, S.lc);
        const float pitch0 = V.pitch;
        if (V.pitch != V.target) {
            V.pitch = V.target + (V.pitch - V.target) * S.glideC;
            if (__builtin_fabsf(V.pitch - V.target) < 0.01f) V.pitch = V.target;
        }
        float drift0[3];
        for (int j = 0; j < 3; ++j) {
            drift0[j] = V.drift[j];
            V.noise = V.noise * 1664525u + 1013904223u;
            const float d = V.drift[j] + kDriftStep * (float(V.noise >> 8) * (1.0f / 16777216.0f) - 0.5f);
            V.drift[j] = clampf(d, -kDriftCents, kDriftCents);
        }
        // VCO increments (the FM headroom keeps the modulated increment below kMaxDt).
        const float fmMax = 1.0f + kFmDepth * kFmPeak * S.oscFm;   // the largest Osc Mod factor
        const float key0 = pitch0 + v.bendStart, key1 = V.pitch + v.bend;
        Lin dt[3], lv[5];
        for (int j = 0; j < 3; ++j) {
            const float maxDt = j < 2 ? kMaxDt / fmMax : kMaxDt;
            const bool kb = j < 2 || S.kb3;
            const float a = incOf(kb ? key0 : kC3, S.semi[j], drift0[j], maxDt), b = incOf(kb ? key1 : kC3, S.semi[j], V.drift[j], maxDt);
            dt[j] = {a, (b - a) * n};
        }
        for (int j = 0; j < 5; ++j) lv[j] = {S.lv0[j], (S.lv1[j] - S.lv0[j]) * n};
        // Ladder: cutoff x Contour x Key Track (around C4) x Filter Mod.
        const float G1 = stageGain(S.cutoff, S.contourOct * V.fenv + S.key * (key1 - 60.0f) + S.fmOct * V.mod);
        const float G0 = V.set ? V.G : stageGain(S.cutoff, S.contourOct * fe0 + S.key * (key0 - 60.0f) + S.fmOct * V.mod);
        const float k0 = V.set ? V.k : S.k, k1 = S.k;
        V.G = G1;
        V.k = k1;
        const float r0 = 1.0f / (1.0f + k0 * G0 * G0 * G0 * G0), r1 = 1.0f / (1.0f + k1 * G1 * G1 * G1 * G1);
        LadderRamp q;
        q.G = {G0, (G1 - G0) * n};
        q.r = {r0, (r1 - r0) * n};
        q.k = {k0, (k1 - k0) * n};
        q.fb = lv[4];
        // VCA: the loudness contour x trim x the half bass make-up, from the
        // last block's value (0 for a fresh voice; no step when Emphasis moves).
        const float out1 = V.lenv * kOutTrim * (1.0f + kMakeUp * k1);
        const float gEnd = g0 + gInc * float(kBlock);
        q.a = {V.out * g0, (out1 * gEnd - V.out * g0) * n};
        V.out = out1;
        V.set = 1;
        // The passes, chunk by chunk: VCO 3 + noise, VCO 1, VCO 2 (skipped
        // while silent), the ladder.
        const bool src3 = S.lv0[2] > 0.0f || S.lv1[2] > 0.0f || S.oscFm > 0.0f || S.fmOct > 0.0f;
        const SrcPass src = kSrc[src3 ? int(S.shape[2]) : int(kShOff)];
        const bool on1 = S.lv0[0] > 0.0f || S.lv1[0] > 0.0f, on2 = S.lv0[1] > 0.0f || S.lv1[1] > 0.0f;
        const VcoPass vco1 = kVco[S.shape[0]], vco2 = kVco[S.shape[1]];
        float x[kChunk], m[kChunk];   // the mix, the Osc Mod factor
        for (uint32_t c = 0; c < kBlock; c += kChunk) {
            src(x, m, V, dt[2], lv[2], lv[3], S.sign[2], S.duty[2], S.modMix, S.oscFm, S.pink);
            if (on1) vco1(x, m, V.ph[0], V.z[0], dt[0], lv[0], S.duty[0]);
            else skipVco(V.ph[0], V.z[0], dt[0], lv[0]);
            if (on2) vco2(x, m, V.ph[1], V.z[1], dt[1], lv[1], S.duty[1]);
            else skipVco(V.ph[1], V.z[1], dt[1], lv[1]);
            ladderPass(x, L + c, R + c, V, q);
        }
        for (float& z : V.s) z = flush(z);
        for (float& z : V.pk) z = flush(z);
        V.y = flush(V.y);
        v.level = V.lenv;
        // The release ended, or a held note decayed to Sustain 0.
        if (V.lStage == kIdle || (V.lStage == kDec && V.lenv == 0.0f && S.lc.sustain == 0.0f)) {
            V.started = 0;
            V.lStage = kIdle;
            V.lenv = 0.0f;
            return false;
        }
        return true;
    }
};

DtypeEngine gDtype;

}  // namespace

ISynthEngine* engine() { return &gDtype; }

}  // namespace dtype
}  // namespace audio
}  // namespace ot
