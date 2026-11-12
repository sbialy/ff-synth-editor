// Copied from opentracker-synths (https://github.com/opentracker-fw/opentracker-synths, modules/fm4/src/fm4.cpp, commit eb150a5f741b),
// Copyright (c) 2026 Marcin Spoczynski, MIT licence, see licenses/LICENSE-OpenTracker-synths-MIT.txt. Not modified, except this notice.
// FM4 four-operator FM engine (see fm4.h).
//
// Per sample the operators run 1..4; each one's phase is modulated by the
// outputs of the operators the algorithm routes into it (this sample's
// values), operator 1 by its own last two outputs (Feedback). A modulator
// at Level 100 % moves its target's phase by one cycle (2 pi rad). The
// carriers' sum, divided by their count, is the voice output.
// Envelopes, LFO, glide and every level run at block rate and are ramped
// across the 128-frame block.
#include "fm4.h"

#include <cstring>

#include "audio/dsp.h"

#if defined(__GNUC__) && !defined(__clang__)
#define FM4_PER_BLOCK __attribute__((optimize("Os")))
#else
#define FM4_PER_BLOCK
#endif

namespace ot {
namespace audio {
namespace fm4 {

namespace {

constexpr float kBlockT = float(kBlock) / kSampleRate;
constexpr float kInvFs = 1.0f / kSampleRate;
constexpr float kLog2e = 1.44269504f;
constexpr float kOutTrim = 0.5f;
constexpr int kOps = 4;

inline float clampf(float x, float lo, float hi) { return x < lo ? lo : (x > hi ? hi : x); }
inline float absf(float x) { return __builtin_fabsf(x); }
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
// x - floor(x) for x > -8.
inline float fracf(float x) {
    x += 8.0f;
    return x - float(int(x));
}
// sin(2 pi x), x in [0, 1): refined parabola (error < 0.1 %).
inline float sinCyc(float x) {
    const float t = 2.0f * x - 1.0f;
    const float y = 4.0f * t * (1.0f - absf(t));
    return -(y + 0.225f * (y * absf(y) - y));
}

// Algorithms: for each operator, the operators modulating it (bit j = op j),
// and the carriers.
struct Alg {
    uint8_t mod[kOps];
    uint8_t carriers;
};
constexpr Alg kAlgs[8] = {
    {{0, 1, 2, 4}, 8},          // 1 > 2 > 3 > 4
    {{0, 0, 3, 4}, 8},          // (1 + 2) > 3 > 4
    {{0, 0, 2, 5}, 8},          // (1 + (2 > 3)) > 4
    {{0, 1, 0, 6}, 8},          // ((1 > 2) + 3) > 4
    {{0, 1, 0, 4}, 10},         // 1 > 2, 3 > 4
    {{0, 1, 1, 1}, 14},         // 1 > (2, 3, 4)
    {{0, 1, 0, 0}, 14},         // 1 > 2, 3, 4
    {{0, 0, 0, 0}, 15},         // 1, 2, 3, 4
};

enum Stage : uint8_t { kIdle = 0, kAtt, kDec, kSus, kRel };

struct SlotState {
    uint32_t serial;
    uint8_t valid, alg, hasLast, pad;
    float ratio[kOps];                 // Mult x Detune
    float attInc[kOps], decC[kOps], susRateC[kOps], relC[kOps];
    float sustain[kOps], level[kOps];
    uint8_t am[kOps];
    float fb;                          // feedback depth (cycles per unit)
    float glideCoef;
    float lfoPh0, lfoPh1, lfoInc;      // free-running LFO (slot), phase at block start / end
    float lastPitch;
};
static_assert(sizeof(SlotState) <= kSynthSlotScratchBytes, "FM4 slot scratch");

struct VoiceState {
    float ph[kOps];
    float env[kOps];
    float amp[kOps];          // operator output gain at the end of the last block
    float fbA, fbB;           // operator 1, one and two samples back
    float pitch, target;
    uint8_t stage[kOps];
    uint8_t started, ampValid;
};
static_assert(sizeof(VoiceState) <= kSynthVoiceStateBytes, "FM4 voice state");

struct Ramp {
    float inc[kOps], dinc[kOps];
    float amp[kOps], damp[kOps];
    float fb;
    float outScale;
};

template <int kA>
void kernel(float* L, float* R, VoiceState& V, Ramp r, float g, float dg) {
    constexpr Alg a = kAlgs[kA];
    constexpr float kOut = 1.0f / float(((a.carriers >> 0) & 1) + ((a.carriers >> 1) & 1) + ((a.carriers >> 2) & 1) +
                                        ((a.carriers >> 3) & 1));
    float p0 = V.ph[0], p1 = V.ph[1], p2 = V.ph[2], p3 = V.ph[3];
    float fa = V.fbA, fb = V.fbB;
    for (uint32_t i = 0; i < kBlock; ++i) {
        p0 += r.inc[0];
        p1 += r.inc[1];
        p2 += r.inc[2];
        p3 += r.inc[3];
        if (p0 >= 1.0f) p0 -= 1.0f;
        if (p1 >= 1.0f) p1 -= 1.0f;
        if (p2 >= 1.0f) p2 -= 1.0f;
        if (p3 >= 1.0f) p3 -= 1.0f;
        const float y0 = r.amp[0] * sinCyc(fracf(p0 + r.fb * (fa + fb)));
        fb = fa;
        fa = y0;
        float in1 = 0.0f, in2 = 0.0f, in3 = 0.0f;
        if (a.mod[1] & 1) in1 += y0;
        const float y1 = r.amp[1] * sinCyc(fracf(p1 + in1));
        if (a.mod[2] & 1) in2 += y0;
        if (a.mod[2] & 2) in2 += y1;
        const float y2 = r.amp[2] * sinCyc(fracf(p2 + in2));
        if (a.mod[3] & 1) in3 += y0;
        if (a.mod[3] & 2) in3 += y1;
        if (a.mod[3] & 4) in3 += y2;
        const float y3 = r.amp[3] * sinCyc(fracf(p3 + in3));
        float out = 0.0f;
        if (a.carriers & 1) out += y0;
        if (a.carriers & 2) out += y1;
        if (a.carriers & 4) out += y2;
        if (a.carriers & 8) out += y3;
        const float o = out * kOut * g;
        L[i] += o;
        R[i] += o;
        g += dg;
        for (int k = 0; k < kOps; ++k) {
            r.inc[k] += r.dinc[k];
            r.amp[k] += r.damp[k];
        }
    }
    V.ph[0] = p0;
    V.ph[1] = p1;
    V.ph[2] = p2;
    V.ph[3] = p3;
    V.fbA = absf(fa) < 1.0e-20f ? 0.0f : fa;
    V.fbB = absf(fb) < 1.0e-20f ? 0.0f : fb;
}

using KernelFn = void (*)(float*, float*, VoiceState&, Ramp, float, float);
constexpr KernelFn kKernels[8] = {kernel<0>, kernel<1>, kernel<2>, kernel<3>,
                                  kernel<4>, kernel<5>, kernel<6>, kernel<7>};

inline float lfoTri(float ph) { return ph < 0.25f ? 4.0f * ph : (ph < 0.75f ? 2.0f - 4.0f * ph : 4.0f * ph - 4.0f); }

class Fm4Engine final : public ISynthEngine {
public:
    int32_t id() const override { return kEngineId; }
    const char* name() const override { return "FM4"; }

    void slotReset(SynthSlotScratch& sc) override { std::memset(sc.bytes, 0, sizeof(sc.bytes)); }

    FM4_PER_BLOCK void prepare(SynthSlotScratch& sc, const SynthParams& p) override {
        if (p.count < kParamCount) return;
        SlotState& S = sc.as<SlotState>();
        const float* E = p.end;
        if (!S.valid || S.serial != p.serial || p.moving) {
            S.alg = uint8_t(enumOf(E[kAlgorithm], 7));
            S.fb = 0.0625f * float(enumOf(E[kFeedback], 7));   // 0 .. 0.44 cycles per unit
            for (int k = 0; k < kOps; ++k) {
                S.ratio[k] = multOf(enumOf(E[op(k, kMult)], 15)) * fastExp2(3.0f * E[op(k, kDetune)] / 1200.0f);
                const float a = E[op(k, kAttack)];
                S.attInc[k] = a <= kBlockT ? 2.0f : kBlockT / a;
                S.decC[k] = blockCoef(E[op(k, kDecay)]);
                const float sr = E[op(k, kSusRate)];
                S.susRateC[k] = sr <= 0.0005f ? 1.0f : blockCoef(sr);   // 0 = hold the sustain level
                S.relC[k] = blockCoef(E[op(k, kRelease)]);
                S.sustain[k] = clampf(E[op(k, kSustain)], 0.0f, 1.0f);
                S.level[k] = clampf(E[op(k, kLevel)], 0.0f, 1.0f);
                S.am[k] = E[op(k, kAm)] >= 0.5f;
            }
            S.glideCoef = blockCoef(E[kGlideTime]);
            S.serial = p.serial;
            S.valid = 1;
        }
        S.lfoInc = clampf(E[kLfoRate], 0.0f, 20.0f) * kBlockT;
        S.lfoPh0 = S.lfoPh1;
        float ph = S.lfoPh1 + S.lfoInc;
        if (ph >= 1.0f) ph -= float(int(ph));
        S.lfoPh1 = ph;
    }

    FM4_PER_BLOCK void noteOn(SynthVoice& v, const SynthParams& p, const SynthNote& n) override {
        SlotState& S = v.slotScratch->as<SlotState>();
        VoiceState& V = v.as<VoiceState>();
        const bool glide = !n.fxGlide && p.end[kGlideTime] > 0.0005f && (n.reused || S.hasLast);
        const float from = n.reused ? V.pitch : S.lastPitch;
        V.target = n.pitch;
        V.pitch = glide ? from : n.pitch;
        S.lastPitch = n.pitch;
        S.hasLast = 1;
        if (!n.overlap) {
            for (int k = 0; k < kOps; ++k) {
                V.stage[k] = kAtt;
                V.ph[k] = 0.0f;   // FM needs a defined phase relation at the attack
            }
            V.fbA = V.fbB = 0.0f;
        }
        V.started = 1;
        V.ampValid = 0;
        v.level = 1.0f;
    }

    void noteOff(SynthVoice& v, const SynthParams&) override {
        VoiceState& V = v.as<VoiceState>();
        for (int k = 0; k < kOps; ++k)
            if (V.stage[k] != kIdle) V.stage[k] = kRel;
    }

    FM4_PER_BLOCK bool render(SynthVoice& v, const SynthParams& p, float g0, float gInc, float* L, float* R) override {
        VoiceState& V = v.as<VoiceState>();
        if (!V.started || p.count < kParamCount) {
            v.level = 0.0f;
            return false;
        }
        const SlotState& S = v.slotScratch->as<SlotState>();
        const Alg& alg = kAlgs[S.alg];
        // Glide, LFO.
        const float pitch0 = V.pitch;
        if (V.pitch != V.target) {
            const float d = (V.pitch - V.target) * S.glideCoef;
            V.pitch = absf(d) < 0.001f ? V.target : V.target + d;
        }
        const float lfo0 = lfoTri(S.lfoPh0), lfo1 = lfoTri(S.lfoPh1);
        const float vib = clampf(p.end[kVibrato], 0.0f, 1.0f), trem = clampf(p.end[kTremolo], 0.0f, 1.0f);
        // Envelopes (one block step); the voice ends when every carrier is idle.
        bool alive = false;
        float env0[kOps];
        for (int k = 0; k < kOps; ++k) {
            env0[k] = V.env[k];
            float e = V.env[k];
            switch (V.stage[k]) {
                case kAtt:
                    e += S.attInc[k];
                    if (e >= 1.0f) {
                        e = 1.0f;
                        V.stage[k] = kDec;
                    }
                    break;
                case kDec:
                    e = S.sustain[k] + (e - S.sustain[k]) * S.decC[k];
                    if (absf(e - S.sustain[k]) < 1.0e-4f) V.stage[k] = kSus;
                    break;
                case kSus:
                    e *= S.susRateC[k];
                    break;
                case kRel:
                    e *= S.relC[k];
                    if (e < 1.0e-4f) {
                        e = 0.0f;
                        V.stage[k] = kIdle;
                    }
                    break;
                default: e = 0.0f; break;
            }
            if (V.stage[k] == kSus && e < 1.0e-4f && S.susRateC[k] < 1.0f) {
                e = 0.0f;
                V.stage[k] = kIdle;
            }
            V.env[k] = e;
            if ((alg.carriers >> k) & 1) alive = alive || V.stage[k] != kIdle;
        }
        // Increments and operator gains at both block ends, ramped.
        Ramp r;
        constexpr float n = 1.0f / float(kBlock);
        const float base0 = 440.0f * kInvFs * fastExp2((pitch0 + v.bendStart + vib * lfo0 - 69.0f) * (1.0f / 12.0f));
        const float base1 = 440.0f * kInvFs * fastExp2((V.pitch + v.bend + vib * lfo1 - 69.0f) * (1.0f / 12.0f));
        for (int k = 0; k < kOps; ++k) {
            const float i0 = clampf(base0 * S.ratio[k], 0.0f, 0.49f), i1 = clampf(base1 * S.ratio[k], 0.0f, 0.49f);
            r.inc[k] = i0;
            r.dinc[k] = (i1 - i0) * n;
            const float am0 = S.am[k] ? 1.0f - trem * 0.5f * (1.0f + lfo0) : 1.0f;
            const float am1 = S.am[k] ? 1.0f - trem * 0.5f * (1.0f + lfo1) : 1.0f;
            const float a1 = S.level[k] * V.env[k] * am1;
            const float a0 = V.ampValid ? V.amp[k] : S.level[k] * env0[k] * am0;
            r.amp[k] = a0;
            r.damp[k] = (a1 - a0) * n;
            V.amp[k] = a1;
        }
        V.ampValid = 1;
        r.fb = S.fb;
        const float gEnd = g0 + gInc * float(kBlock);
        kKernels[S.alg](L, R, V, r, g0 * kOutTrim, (gEnd - g0) * kOutTrim * n);
        float lv = 0.0f;
        for (int k = 0; k < kOps; ++k)
            if ((alg.carriers >> k) & 1) lv = lv > V.env[k] ? lv : V.env[k];
        v.level = lv;
        if (!alive) {
            V.started = 0;
            return false;
        }
        return true;
    }
};

Fm4Engine gFm4;

}  // namespace

ISynthEngine* engine() { return &gFm4; }

}  // namespace fm4
}  // namespace audio
}  // namespace ot
