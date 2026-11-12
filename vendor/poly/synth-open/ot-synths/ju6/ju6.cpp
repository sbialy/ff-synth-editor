// Copied from opentracker-synths (https://github.com/opentracker-fw/opentracker-synths, modules/ju6/src/ju6.cpp, commit eb150a5f741b),
// Copyright (c) 2026 Marcin Spoczynski, MIT licence, see licenses/LICENSE-OpenTracker-synths-MIT.txt. Not modified, except this notice.
// JU6 Juno-style poly engine (see ju6.h).
//
// Per sample: the DCO phase advances; the saw, the pulse (both edges) and the
// sub square (it flips at every DCO wrap) get a polyBLEP correction near
// their steps; noise is a per-voice LCG. The mix goes through the HPF (one
// one-pole low-pass: subtracted for positions 2 and 3, added for the bass
// boost of position 0, unused at 1) into the VCF: four one-pole
// (trapezoidal) stages with the feedback loop solved for this sample, a soft
// cubic clip on the loop input, then the VCA.
// Envelope, LFO, pitch, cutoff and the VCA level run at block rate and are
// ramped across the 128-frame block. The LFO is one free-running triangle per
// slot (as on the instrument); the Delay fades it in per voice from its note
// on. PWM in LFO mode follows the LFO without the delay.
// The chorus runs once per slot on the voices' sum (slotPost): the shared BBD
// chorus at the Juno's fixed settings (Mix 100, Width 100, Tone ~8.5 kHz),
// each slot with its own line; Off leaves the bus untouched.
#include "ju6.h"

#include <cstring>

#include "audio/bbd_chorus.h"
#include "audio/dsp.h"

#if defined(__GNUC__) && !defined(__clang__)
#define JU6_PER_BLOCK __attribute__((optimize("Os")))
#else
#define JU6_PER_BLOCK
#endif

namespace ot {
namespace audio {
namespace ju6 {

namespace {

constexpr float kBlockT = float(kBlock) / kSampleRate;
constexpr float kInvFs = 1.0f / kSampleRate;
constexpr float kPi = 3.14159265f;
constexpr float kLog2e = 1.44269504f;
constexpr float kDrive = 0.7f;          // DCO mix -> VCF input
constexpr float kOutTrim = 0.63f;       // VCF output -> slot bus (the ACD Init level)
constexpr float kSeedNoise = 2.0e-4f;   // always-on noise floor: seeds self-oscillation
constexpr float kResK = 4.4f;           // loop gain at Resonance 100 % (oscillates above 4)
constexpr float kResComp = 0.25f;       // pass-band make-up per unit of loop gain
constexpr float kEnvOct = 7.0f;         // VCF Env 100 % = +7 octaves
constexpr float kLfoOct = 3.0f;         // VCF LFO 100 % = +-3 octaves
constexpr float kVibSemi = 2.0f;        // Vibrato 100 % = +-2 semitones
constexpr float kAttOver = 1.3f;        // the attack aims past 1 (an RC charging curve)

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
// One-pole low-pass coefficient for hz.
inline float onePole(float hz) { return 1.0f - fastExp2(-2.0f * kPi * hz * kInvFs * kLog2e); }
// tan(x) for 0 <= x < pi / 2 (Pade 7/6; < 0.1 % up to 1.4).
inline float tanPade(float x) {
    const float x2 = x * x;
    return x * (135135.0f - x2 * (17325.0f - x2 * (378.0f - x2))) /
           (135135.0f - x2 * (62370.0f - x2 * (3150.0f - 28.0f * x2)));
}
// Triangle -1..1 of phase 0..1.
inline float lfoTri(float ph) { return ph < 0.25f ? 4.0f * ph : (ph < 0.75f ? 2.0f - 4.0f * ph : 4.0f * ph - 4.0f); }

enum Stage : uint8_t { kIdle = 0, kAtt, kDec, kRel };

struct SlotState {
    uint32_t serial;
    uint32_t seed;                      // note-on phases and noise seeds
    uint8_t valid, pwLfo, gateVca, attInstant;
    float sawG, pulseG, subG, noiseG;   // x kDrive (noise with the seed floor)
    float pw;                           // manual width (0..1) or PWM depth
    float vib;                          // semitones at LFO 1
    float hpA, hpK;                     // HPF one-pole and its mix (-1 high-pass, 0 flat, > 0 boost)
    float cutoff, k, comp;
    float envOct, lfoOct, key, velAmt;
    float attC, decC, relC, sustain;
    float delay;
    float lfoPh0, lfoPh1, lfoInc;       // free-running LFO (slot), phase at block start / end
    bbd::State chorus;                  // the slot's chorus (its line: gChorusLine[slot])
    uint32_t quiet;                     // chorus input frames without a voice (saturates)
    uint8_t chorusMode;                 // 0 Off, 1 I, 2 II
    uint8_t lineReady;                  // the slot's line was cleared since the scratch was
    uint8_t voiced;                     // a voice rendered since prepare() (this block)
};
static_assert(sizeof(SlotState) <= kSynthSlotScratchBytes, "JU6 slot scratch");

// The chorus lines, one per synth slot (.bss, ModuleInfo sramAudioBytes).
int16_t gChorusLine[kSynthSlots][bbd::kLine];
constexpr uint8_t kChorusTone = 50;   // the BBD filters at ~8.5 kHz

struct VoiceState {
    float ph, sub;                      // DCO phase 0..1, sub square +-1
    float hp;                           // HPF one-pole state
    float s[4];                         // VCF stage states
    float env, amp, out;                // ADSR, VCA level, VCA x trim at the end of the last block
    float k;                            // VCF loop gain at the end of the last block
    float tOn;                          // seconds since the note on (LFO delay)
    float pitch, vel;
    uint32_t noise;
    uint8_t stage, gate, started, kSet;
};
static_assert(sizeof(VoiceState) <= kSynthVoiceStateBytes, "JU6 voice state");

// Block-start values and per-frame increments.
struct Ramp {
    float dt, ddt, idt, didt;           // DCO increment and its inverse
    float pw, dpw;                      // pulse duty
    float G, dG, r, dr;                 // VCF stage gain, 1 / (1 + k G^4)
    float k, dk;                        // VCF loop gain
    float a, da;                        // VCA x output trim
};

// polyBLEP residual of a step at phase 0 (t in 0..1, dt = phase increment).
inline float blep(float t, float dt, float idt) {
    if (t < dt) {
        const float x = t * idt;
        return x + x - x * x - 1.0f;
    }
    if (t > 1.0f - dt) {
        const float x = (t - 1.0f) * idt;
        return x * x + x + x + 1.0f;
    }
    return 0.0f;
}

__attribute__((noinline)) void kernel(float* L, float* R, VoiceState& V, const SlotState& S, Ramp r) {
    float ph = V.ph, sub = V.sub, hp = V.hp;
    float s0 = V.s[0], s1 = V.s[1], s2 = V.s[2], s3 = V.s[3];
    uint32_t nz = V.noise;
    const float sawG = S.sawG, pulseG = S.pulseG, subG = S.subG, noiseG = S.noiseG;
    const float hpA = S.hpA, hpK = S.hpK;
    for (uint32_t i = 0; i < kBlock; ++i) {
        const float dt = r.dt, idt = r.idt, pw = r.pw;
        ph += dt;
        if (ph >= 1.0f) {
            ph -= 1.0f;
            sub = -sub;
        }
        // DCO: saw (step -2 at the wrap), pulse (+2 at the wrap, -2 at pw, DC removed), sub.
        const float b0 = blep(ph, dt, idt);
        float q = ph - pw;
        if (q < 0.0f) q += 1.0f;
        const float b1 = blep(q, dt, idt);
        const float saw = ph + ph - 1.0f - b0;
        const float pulse = (ph < pw ? 1.0f : -1.0f) - (pw + pw - 1.0f) + b0 - b1;
        const float sq = sub + (ph < 0.5f ? sub : -sub) * b0;
        nz = nz * 1664525u + 1013904223u;
        const float n = float(int32_t(nz)) * (1.0f / 2147483648.0f);
        float x = sawG * saw + pulseG * pulse + subG * sq + noiseG * n;
        // HPF.
        hp += hpA * (x - hp);
        x += hpK * hp;
        // VCF: y4 = G^4 u + (1 - G) (((s0 G + s1) G + s2) G + s3), u = x - k y4.
        const float G = r.G, k = r.k;
        const float sig = (1.0f - G) * (((s0 * G + s1) * G + s2) * G + s3);
        float u = clampf((x - k * sig) * r.r, -1.5f, 1.5f);
        u -= 0.148148148f * u * u * u;   // soft clip, 1 at 1.5
        float v = G * (u - s0);
        const float y0 = v + s0;
        s0 = y0 + v;
        v = G * (y0 - s1);
        const float y1 = v + s1;
        s1 = y1 + v;
        v = G * (y1 - s2);
        const float y2 = v + s2;
        s2 = y2 + v;
        v = G * (y2 - s3);
        const float y3 = v + s3;
        s3 = y3 + v;
        const float o = y3 * r.a;
        L[i] += o;
        R[i] += o;
        r.dt += r.ddt;
        r.idt += r.didt;
        r.pw += r.dpw;
        r.G += r.dG;
        r.r += r.dr;
        r.k += r.dk;
        r.a += r.da;
    }
    V.ph = ph;
    V.sub = sub;
    V.hp = hp;
    V.s[0] = s0;
    V.s[1] = s1;
    V.s[2] = s2;
    V.s[3] = s3;
    V.noise = nz;
}

class Ju6Engine final : public ISynthEngine {
public:
    int32_t id() const override { return kEngineId; }
    const char* name() const override { return "JU6"; }

    void slotReset(SynthSlotScratch& sc) override { std::memset(sc.bytes, 0, sizeof(sc.bytes)); }

    JU6_PER_BLOCK void prepare(SynthSlotScratch& sc, const SynthParams& p) override {
        if (p.count < kParamCount) return;
        SlotState& S = sc.as<SlotState>();
        const float* E = p.end;
        if (!S.valid || S.serial != p.serial || p.moving) {
            S.sawG = E[kSaw] >= 0.5f ? kDrive : 0.0f;
            S.pulseG = E[kPulse] >= 0.5f ? kDrive : 0.0f;
            S.subG = kDrive * clampf(E[kSub], 0.0f, 1.0f);
            S.noiseG = kDrive * (clampf(E[kNoise], 0.0f, 1.0f) + kSeedNoise);
            S.pw = clampf(E[kPw], 0.0f, 1.0f);
            S.pwLfo = enumOf(E[kPwMode], 1) == kPwLfo;
            S.vib = kVibSemi * clampf(E[kVibrato], 0.0f, 1.0f);
            // HPF positions: 0 = bass boost (+2.7 dB at 65 Hz), 1 = flat, 2 / 3 = high-pass.
            static const float kHpHz[4] = {100.0f, 100.0f, 240.0f, 720.0f};
            static const float kHpMix[4] = {0.5f, 0.0f, -1.0f, -1.0f};
            const int h = enumOf(E[kHpf], 3);
            S.hpA = onePole(kHpHz[h]);
            S.hpK = kHpMix[h];
            S.cutoff = clampf(E[kCutoff], 20.0f, 20000.0f);
            S.k = kResK * clampf(E[kResonance], 0.0f, 1.0f);
            S.comp = 1.0f + kResComp * S.k;
            S.envOct = kEnvOct * clampf(E[kEnvAmt], -1.0f, 1.0f);
            S.lfoOct = kLfoOct * clampf(E[kVcfLfo], 0.0f, 1.0f);
            S.key = clampf(E[kKeyFollow], 0.0f, 1.0f) * (1.0f / 12.0f);
            S.velAmt = clampf(E[kVelVcf], 0.0f, 1.0f);
            S.gateVca = enumOf(E[kVcaMode], 1) == kVcaGate;
            // Attack: an RC curve towards 1.3 that reaches 1 after Attack seconds.
            const float a = E[kAttack];
            S.attInstant = a <= kBlockT;
            S.attC = S.attInstant ? 0.0f : fastExp2(-1.466f * kLog2e * kBlockT / a);
            S.decC = blockCoef(E[kDecay]);
            S.relC = blockCoef(E[kRelease]);
            S.sustain = clampf(E[kSustain], 0.0f, 1.0f);
            S.delay = clampf(E[kLfoDelay], 0.0f, 5.0f);
            S.chorusMode = uint8_t(enumOf(E[kChorus], kChorusII));
            S.serial = p.serial;
            S.valid = 1;
        }
        S.voiced = 0;
        S.lfoInc = clampf(E[kLfoRate], 0.0f, 20.0f) * kBlockT;
        S.lfoPh0 = S.lfoPh1;
        float ph = S.lfoPh1 + S.lfoInc;
        if (ph >= 1.0f) ph -= float(int(ph));
        S.lfoPh1 = ph;
    }

    JU6_PER_BLOCK void noteOn(SynthVoice& v, const SynthParams&, const SynthNote& n) override {
        SlotState& S = v.slotScratch->as<SlotState>();
        VoiceState& V = v.as<VoiceState>();
        if (!n.reused || !V.started) {
            // A fresh voice: the DCO is free-running, so its phase is arbitrary.
            S.seed = S.seed * 1664525u + 1013904223u;
            V.ph = float(S.seed >> 8) * (1.0f / 16777216.0f);
            V.sub = (S.seed & 0x80u) ? 1.0f : -1.0f;
            V.noise = S.seed ^ 0x9E3779B9u;
        }
        if (!n.overlap) {
            V.stage = kAtt;   // from the current level (no click on a reused voice)
            V.tOn = 0.0f;
        }
        V.pitch = n.pitch;
        V.vel = clampf(n.velocity, 0.0f, 1.0f);
        V.gate = 1;
        V.started = 1;
        // A fresh voice reports full level (the framework must not take it as
        // a steal victim before its first block, as FM4).
        v.level = n.reused ? V.amp : 1.0f;
    }

    void noteOff(SynthVoice& v, const SynthParams&) override {
        VoiceState& V = v.as<VoiceState>();
        V.gate = 0;
        if (V.stage != kIdle) V.stage = kRel;
    }

    JU6_PER_BLOCK bool render(SynthVoice& v, const SynthParams& p, float g0, float gInc, float* L, float* R) override {
        VoiceState& V = v.as<VoiceState>();
        if (!V.started || p.count < kParamCount) {
            v.level = 0.0f;
            return false;
        }
        SlotState& S = v.slotScratch->as<SlotState>();
        S.voiced = 1;   // the chorus input is not silent this block
        // ADSR (one block step).
        const float env0 = V.env;
        float e = V.env;
        switch (V.stage) {
            case kAtt:
                e = S.attInstant ? 1.0f : kAttOver - (kAttOver - e) * S.attC;
                if (e >= 1.0f) {
                    e = 1.0f;
                    V.stage = kDec;
                }
                break;
            case kDec:   // and holds at Sustain (snapped: no endless approach, no subnormals)
                e = S.sustain + (e - S.sustain) * S.decC;
                if (__builtin_fabsf(e - S.sustain) < 1.0e-5f) e = S.sustain;
                break;
            case kRel:
                e *= S.relC;
                if (e < 1.0e-4f) {
                    e = 0.0f;
                    V.stage = kIdle;
                }
                break;
            default: e = 0.0f; break;
        }
        V.env = e;
        // LFO with the per-voice delay: held back for the first half of Delay, then fades in.
        const float tOn0 = V.tOn;
        V.tOn = tOn0 + kBlockT > 60.0f ? 60.0f : tOn0 + kBlockT;
        auto fade = [&S](float t) {
            if (S.delay <= 0.0f) return 1.0f;
            return clampf((t - 0.5f * S.delay) * (2.0f / S.delay), 0.0f, 1.0f);
        };
        const float raw0 = lfoTri(S.lfoPh0), raw1 = lfoTri(S.lfoPh1);
        const float lfo0 = raw0 * fade(tOn0), lfo1 = raw1 * fade(V.tOn);
        // DCO increments.
        Ramp r;
        constexpr float n = 1.0f / float(kBlock);
        const float dt0 = clampf(440.0f * kInvFs * fastExp2((V.pitch + v.bendStart + S.vib * lfo0 - 69.0f) * (1.0f / 12.0f)),
                                 1.0e-5f, 0.45f);
        const float dt1 = clampf(440.0f * kInvFs * fastExp2((V.pitch + v.bend + S.vib * lfo1 - 69.0f) * (1.0f / 12.0f)),
                                 1.0e-5f, 0.45f);
        r.dt = dt0;
        r.ddt = (dt1 - dt0) * n;
        r.idt = 1.0f / dt0;
        r.didt = (1.0f / dt1 - r.idt) * n;
        // Pulse duty: 50 % at PW 0 down to 5 % at PW 100 % (LFO mode: swept by the LFO).
        const float pw0 = 0.5f - 0.45f * S.pw * (S.pwLfo ? 0.5f + 0.5f * raw0 : 1.0f);
        const float pw1 = 0.5f - 0.45f * S.pw * (S.pwLfo ? 0.5f + 0.5f * raw1 : 1.0f);
        r.pw = pw0;
        r.dpw = (pw1 - pw0) * n;
        // VCF cutoff: Env (velocity-scaled), LFO, key follow around C4.
        const float envOct = S.envOct * (1.0f - S.velAmt * (1.0f - V.vel));
        const float keyOct = S.key * (V.pitch - 60.0f);
        auto stageGain = [&S](float oct) {
            const float hz = clampf(S.cutoff * fastExp2(oct), 8.0f, 0.45f * kSampleRate);
            const float t = tanPade(kPi * hz * kInvFs);
            return t / (1.0f + t);
        };
        const float G0 = stageGain(envOct * env0 + S.lfoOct * lfo0 + keyOct);
        const float G1 = stageGain(envOct * e + S.lfoOct * lfo1 + keyOct);
        const float k0 = V.kSet ? V.k : S.k, k1 = S.k;   // Resonance glides across the block
        V.k = k1;
        V.kSet = 1;
        const float r0 = 1.0f / (1.0f + k0 * G0 * G0 * G0 * G0), r1 = 1.0f / (1.0f + k1 * G1 * G1 * G1 * G1);
        r.G = G0;
        r.dG = (G1 - G0) * n;
        r.r = r0;
        r.dr = (r1 - r0) * n;
        r.k = k0;
        r.dk = (k1 - k0) * n;
        // VCA: the ADSR, or the gate (full level at once, closed at the gate off).
        const float a1 = S.gateVca ? (V.gate ? 1.0f : 0.0f) : e;
        V.amp = a1;
        // The output ramp runs from the last block's VCA x trim (the Resonance make-up
        // changes with a macro: no step at the block boundary).
        const float out1 = a1 * kOutTrim * S.comp;
        const float gEnd = g0 + gInc * float(kBlock);
        r.a = V.out * g0;
        r.da = (out1 * gEnd - V.out * g0) * n;
        V.out = out1;
        kernel(L, R, V, S, r);
        v.level = a1;
        // Env VCA: the release ended, or a held note decayed to Sustain 0.
        const bool done = S.gateVca ? (!V.gate && a1 == 0.0f)
                                    : (V.stage == kIdle || (V.stage == kDec && e == 0.0f && S.sustain == 0.0f));
        if (done) {
            V.started = 0;
            V.stage = kIdle;
            V.env = 0.0f;
            return false;
        }
        return true;
    }

    // The chorus on the slot's voice sum (mono in, stereo out); true while
    // its line may still hold sound (the tail after the last voice: until
    // bbd::kTailFrames frames went in without a voice).
    bool slotPost(int slot, SynthSlotScratch& sc, const SynthParams& p, float* L, float* R) override {
        SlotState& S = sc.as<SlotState>();
        if (!S.valid || p.count < kParamCount || unsigned(slot) >= unsigned(kSynthSlots)) return false;
        if (!S.chorusMode && S.chorus.wet <= 0.0f) return false;   // Off: the bus untouched
        int16_t* const line = gChorusLine[slot];
        if (!S.lineReady) {
            bbd::clear(S.chorus, line);
            S.lineReady = 1;
        }
        S.quiet = S.voiced ? 0u : (S.quiet < bbd::kTailFrames ? S.quiet + kBlock : S.quiet);
        return bbd::process(S.chorus, line, S.chorusMode, 1.0f, 1.0f, kChorusTone, L, R, kBlock) &&
               S.quiet < bbd::kTailFrames;
    }
};

Ju6Engine gJu6;

}  // namespace

ISynthEngine* engine() { return &gJu6; }

float chorusDelay(const SynthSlotScratch& sc, int c) {
    const SlotState& S = sc.as<SlotState>();
    return c ? S.chorus.dr : S.chorus.dl;
}

}  // namespace ju6
}  // namespace audio
}  // namespace ot
