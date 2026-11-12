// Copied from opentracker-synths (https://github.com/opentracker-fw/opentracker-synths, modules/hand/src/hand.cpp, commit eb150a5f741b),
// Copyright (c) 2026 Marcin Spoczynski, MIT licence, see licenses/LICENSE-OpenTracker-synths-MIT.txt. Not modified, except this notice.
// Hand-Type engine (see hand.h).
//
// A channel is a unipolar signal u (0..1: the pulse high or low, band-limited
// by va::vcoFrame; the wave table's step / 15; the noise register's bit)
// times the 4-bit envelope e (a level 0..15 held for the block: the steps
// are the sound), on a DAC of Bits bits (u e rounded to 2^Bits - 1 steps;
// Bits 8: clean), less the channel's known mean x e on the same steps (no DC
// to filter beyond half a step). The envelope, the sweep (one step per Sweep Time x 1/128 s), the
// Length timer, glide and the levels run at block rate; the CHIP tricks split
// the block at their ticks (chip::Tricks: the pitch steps exactly on the
// tick). An ending voice (Release Cut, a choked hat, Sweep Cut, Length) fades
// over one block after the DAC. Drums pick a channel set-up per note; the
// hats share a serial in the slot scratch (a new hat cuts the older one).
#include "hand.h"

#include <cstring>

#include "audio/chip_dsp.h"
#include "audio/va_dsp.h"

#if defined(__GNUC__) && !defined(__clang__)
#define HAND_PER_BLOCK __attribute__((optimize("Os")))
#else
#define HAND_PER_BLOCK
#endif

namespace ot {
namespace audio {
namespace hand {

namespace {

using namespace ot::audio::va;

constexpr float kTrim = 0.92f;            // DAC output (+-1) -> slot bus (the ACD Init level)
constexpr float kDrumTrim = 0.6f;         // a drum hit (five at once stay below full scale)
constexpr float kSweepTick = kSampleRate / 128.0f;   // frames per sweep tick
constexpr float kEnvTick = kSampleRate / 64.0f;      // frames per envelope tick
constexpr float kLenTick = kSampleRate / 16.0f;      // frames per Length unit

const uint8_t kTables[kUser][32] = {
    {8, 9, 10, 12, 13, 14, 14, 15, 15, 15, 14, 14, 13, 12, 10, 9, 8, 6, 5, 3, 2, 1, 1, 0, 0, 0, 1, 1, 2, 3, 5, 6},     // Sine
    {8, 8, 9, 10, 11, 12, 13, 14, 15, 14, 13, 12, 11, 10, 9, 8, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 6, 7},       // Triangle
    {0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15},      // Saw
    {15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0},  // Square 50
    {15, 15, 15, 15, 15, 15, 15, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0},          // Square 25
    {8, 11, 14, 15, 15, 13, 12, 11, 11, 11, 11, 11, 10, 9, 8, 8, 8, 7, 7, 6, 5, 4, 4, 4, 4, 4, 3, 2, 0, 0, 1, 4},      // Organ
    {10, 12, 14, 15, 15, 15, 14, 13, 12, 10, 10, 9, 9, 9, 9, 10, 10, 10, 10, 9, 8, 6, 4, 3, 1, 0, 0, 0, 1, 3, 5, 8},   // Bass
    {8, 9, 10, 10, 11, 12, 12, 13, 14, 14, 15, 8, 9, 10, 10, 11, 3, 4, 5, 5, 6, 7, 0, 1, 1, 2, 3, 3, 4, 5, 5, 6},      // Buzz
    {8, 13, 15, 14, 11, 9, 8, 8, 8, 8, 8, 9, 11, 14, 15, 13, 8, 2, 0, 1, 4, 6, 7, 7, 7, 7, 7, 6, 4, 1, 0, 2},          // Nasal
    {8, 12, 15, 15, 14, 13, 12, 13, 13, 13, 12, 13, 14, 15, 15, 12, 8, 3, 0, 0, 1, 2, 3, 2, 2, 2, 3, 2, 1, 0, 0, 3},   // Hollow
    {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},      // Ramp 2
};
const float kDutyOf[4] = {0.125f, 0.25f, 0.5f, 0.75f};
const float kDrumStep[8] = {0.002f, 0.004f, 0.008f, 0.016f, 0.031f, 0.047f, 0.078f, 0.125f};   // seconds per level
const float kLevel4[4] = {0.0f, 0.25f, 0.5f, 1.0f};   // the 4-level wave volume
// One sweep step in semitones at Shift 1..7: Up -12 log2(1 - 2^-s), Down -12 log2(1 + 2^-s).
const float kSweepUpSt[8] = {0.0f, 12.0f, 4.98045f, 2.31174f, 1.11731f, 0.54964f, 0.27264f, 0.13578f};
const float kSweepDownSt[8] = {0.0f, -7.01955f, -3.86314f, -2.03910f, -1.04955f, -0.53273f, -0.26841f, -0.13473f};
constexpr float kPitch20Hz = 15.4868f, kPitch20kHz = 135.0762f;   // the notes of 20 Hz and 20 kHz

// The channel a voice plays this block (from the patch, or a drum's set-up).
enum Kind : uint8_t { kKPulse = 0, kKWave, kKNoise };
struct Cfg {
    uint8_t kind, duty, p2duty, sweepDir, sweepTime, sweepShift, sweepCut, width, levels4, envUp, track, clap;
    float p2Level, p2Semi;   // the second pulse (0: none), its offset in semitones
    float noise;             // shifts per frame
    float per;               // frames per envelope level (0: none)
    float semi;              // pitch offset (drums)
};

struct SlotState {
    uint32_t serial;
    uint32_t hatSerial;
    uint8_t valid, hasLast, glideMode, chan;
    uint8_t duty, p2duty, sweepDir, sweepTime, sweepShift, sweepCut, width, track;
    uint8_t levels4, envInit, envUp, fade, length, bits, wave, snareWidth;
    uint8_t kickShift, pad[3];
    float p2Level, p2Semi, noise, envPer;
    float glideC, lastPitch, kickTune, hatShift;
    float dStep[7];            // drum frames per level: kick, snare, hat closed, hat open, crash, tom, blip
    float hatPer[4];           // the four hats' frames per level
    float waveMean;            // the table's mean / 15
    uint8_t table[32];         // the wave (User: expanded)
    chip::TricksCfg tc;
};
static_assert(sizeof(SlotState) <= kSynthSlotScratchBytes, "Hand-Type slot state");

struct VoiceState {
    float ph, z, ph2, z2;      // pulse phases (the wave uses ph) and the held frames
    float nph;                 // noise clock phase (shifts)
    uint32_t lfsr;
    float env;                 // 0..15
    float pitch, target;       // glided note, the note
    float sweep;               // semitones
    float sweepLeft;           // frames to the next sweep step
    float life;                // frames left (Length), < 0: none
    float du, du2;             // duties at the last block's end
    float p2l;                 // pulse 2 level at the last block's end
    float age;                 // seconds (the clap's bursts)
    uint32_t hat;              // hat serial
    chip::Tricks tr;
    uint8_t started, rel, cut, hi, hi2, drum, hatIdx, glide;
    uint8_t nbit, pad[3];
};
static_assert(sizeof(VoiceState) <= kSynthVoiceStateBytes, "Hand-Type voice state");

inline float noiseShifts(int shift, int div) { return noiseHz(shift, div) * (1.0f / kSampleRate); }

// The nearest noise clock to f Hz (Track): over the dividers, the shift that comes closest.
float trackShifts(float f) {
    float best = 1.0f, err = 1e9f;
    for (int d = 0; d < 8; ++d) {
        const float base = noiseHz(0, d);
        int s = 0;
        while (s < 13 && base / float(1 << (s + 1)) >= f) ++s;
        for (int k = s; k <= s + 1 && k <= 13; ++k) {
            const float r = base / float(1 << k), e = r > f ? r / f : f / r;
            if (e < err) {
                err = e;
                best = r;
            }
        }
    }
    best *= 1.0f / kSampleRate;
    return best > 8.0f ? 8.0f : best;
}

HAND_PER_BLOCK void refresh(SlotState& S, const SynthParams& p) {
    const float* E = p.end;
    S.chan = uint8_t(enumOf(E[kChannel], kDrums));
    S.duty = uint8_t(enumOf(E[kDuty], kDuty75));
    S.p2duty = uint8_t(enumOf(E[kP2Duty], kDuty75));
    S.sweepDir = uint8_t(enumOf(E[kSweepDir], kSweepDown));
    S.sweepTime = uint8_t(clampf(E[kSweepTime], 1.0f, 7.0f) + 0.5f);
    S.sweepShift = uint8_t(clampf(E[kSweepShift], 1.0f, 7.0f) + 0.5f);
    S.sweepCut = E[kSweepCut] >= 0.5f;
    S.p2Level = clampf(E[kP2Level], 0.0f, 1.0f);
    S.p2Semi = 0.01f * clampf(E[kP2Detune], -50.0f, 50.0f);
    S.width = uint8_t(enumOf(E[kWidth], kWidth7));
    S.track = E[kTrack] >= 0.5f;
    S.noise = noiseShifts(enumOf(E[kNoiseShift], 13), enumOf(E[kDivider], 7));
    S.levels4 = enumOf(E[kLevels], kLevels16) == kLevels4;
    S.envInit = uint8_t(enumOf(E[kEnvInit], 15));
    S.envUp = enumOf(E[kEnvDir], kUp) == kUp;
    S.envPer = envStepSeconds(enumOf(E[kEnvStep], 6)) * kSampleRate;
    S.fade = enumOf(E[kRelease], kFade) == kFade;
    S.length = uint8_t(enumOf(E[kLength], 7));
    S.bits = uint8_t(enumOf(E[kBits], 8));
    if (S.bits < 4) S.bits = 4;
    S.kickTune = clampf(E[kKickTune], -24.0f, 24.0f);
    S.kickShift = uint8_t(8 - enumOf(E[kKickSweep], 7));
    if (S.kickShift > 7) S.kickShift = 7;
    S.snareWidth = uint8_t(enumOf(E[kSnareWidth], kWidth7));
    S.hatShift = noiseShifts(enumOf(E[kHatShift], 13), 0);
    static const int kD[7] = {kKickDecay, kSnareDecay, kHatClosedDecay, kHatOpenDecay, kCrashDecay, kTomDecay, kBlipDecay};
    for (int k = 0; k < 7; ++k) S.dStep[k] = drumStepSeconds(enumOf(E[kD[k]], 7)) * kSampleRate;
    // The hats closed .. open: the step time from Closed to Open in equal ratios.
    const float r = S.dStep[3] / S.dStep[2], r3 = fastExp2(chip::fastLog2(r) * (1.0f / 3.0f));
    S.hatPer[0] = S.dStep[2];
    S.hatPer[1] = S.dStep[2] * r3;
    S.hatPer[2] = S.dStep[2] * r3 * r3;
    S.hatPer[3] = S.dStep[3];
    // The wave: a built-in table, or the 8 User points stretched to 32 (linear, rounded).
    S.wave = uint8_t(enumOf(E[kWave], kUser));
    if (S.wave < kUser) {
        std::memcpy(S.table, kTables[S.wave], 32);
    } else {
        for (int s = 0; s < 32; ++s) {
            const int k = s >> 2, j = (k + 1) & 7;
            const float a = clampf(E[kUser1 + k], 0.0f, 15.0f), b = clampf(E[kUser1 + j], 0.0f, 15.0f);
            S.table[s] = uint8_t(a + (b - a) * float(s & 3) * 0.25f + 0.5f);
        }
    }
    int sum = 0;
    for (int s = 0; s < 32; ++s) sum += S.table[s];
    S.waveMean = float(sum) * (1.0f / (32.0f * 15.0f));
    chip::setTricks(S.tc, enumOf(E[kArpMode], chip::kArpCustom), int(E[kArpNote2] + 0.5f), int(E[kArpNote3] + 0.5f),
                    enumOf(E[kArpRate], chip::kDiv128), E[kVibRate], E[kVibDepth], E[kVibDelay], E[kSlideStart], E[kSlideTime]);
    S.glideMode = uint8_t(enumOf(E[kGlideMode], kLegatoOverlap));
    const float gt = clampf(E[kGlideTime], 0.0f, 3.0f);
    S.glideC = gt < 0.0005f ? 0.0f : fastExp2(-4.3219281f * kBlockT / gt);
    S.serial = p.serial;
    S.valid = 1;
}

// The channel set-up of this block: the patch's, or the voice's drum.
HAND_PER_BLOCK void cfgOf(const SlotState& S, const VoiceState& V, Cfg& c) {
    std::memset(&c, 0, sizeof(c));
    c.duty = S.duty;
    c.p2duty = S.p2duty;
    c.levels4 = S.levels4;
    if (S.chan != kDrums) {
        c.kind = S.chan == kPulse ? kKPulse : (S.chan == kWaveCh ? kKWave : kKNoise);
        c.sweepDir = S.sweepDir;
        c.sweepTime = S.sweepTime;
        c.sweepShift = S.sweepShift;
        c.sweepCut = S.sweepCut;
        c.width = S.width;
        c.track = S.track;
        c.p2Level = S.p2Level;
        c.p2Semi = S.p2Semi;
        c.noise = S.noise;
        c.envUp = S.envUp;
        c.per = S.envPer;
        return;
    }
    c.levels4 = 0;
    c.duty = kDuty50;
    switch (V.drum) {
        case kKick:
            c.semi = S.kickTune;
            c.sweepDir = kSweepDown;
            c.sweepTime = 1;
            c.sweepShift = S.kickShift;
            c.sweepCut = 1;
            c.per = S.dStep[0];
            break;
        case kBlip:
            c.semi = 24.0f;
            c.per = S.dStep[6];
            break;
        case kSnare:
        case kCrash:
            c.kind = kKNoise;
            c.width = V.drum == kSnare ? S.snareWidth : uint8_t(kWidth15);
            c.noise = noiseShifts(1, 0);
            c.per = S.dStep[V.drum == kSnare ? 1 : 4];
            break;
        case kClap:
            c.kind = kKNoise;
            c.width = kWidth7;
            c.noise = noiseShifts(2, 0);
            c.per = S.dStep[1];
            c.clap = 1;
            break;
        case kHat: {
            c.kind = kKNoise;
            c.width = kWidth7;
            c.noise = S.hatShift;
            c.per = S.hatPer[V.hatIdx & 3];
            break;
        }
        case kRide:
            c.kind = kKNoise;
            c.width = kWidth7;
            c.noise = noiseShifts(3, 0);
            c.per = S.dStep[4];
            break;
        case kBell:
            c.semi = 12.0f;
            c.duty = c.p2duty = kDuty25;
            c.p2Level = 1.0f;
            c.p2Semi = 7.02f;
            c.per = S.dStep[4] * 0.5f;
            break;
        default:   // tom
            c.sweepDir = kSweepDown;
            c.sweepTime = 2;
            c.sweepShift = 5;
            c.per = S.dStep[5];
            break;
    }
}

// One chunk of the pulse channel (one or two pulses) into u (0..1): twin,
// (u1 + l2 u2) / (1 + l2) with both weights ramped (wa, wb).
template <bool kTwin>
void pulsePass(float* u, uint32_t n, VoiceState& V, Lin dt, Lin dt2, Lin du, Lin du2, Lin wa, Lin wb) {
    float p = V.ph, z = V.z, p2 = V.ph2, z2 = V.z2;
    bool hi = V.hi, hi2 = V.hi2;
    for (uint32_t i = 0; i < n; ++i) {
        float y = 0.5f * chip::pulseFrame(p, z, hi, dt.v, du.v) + du.v;
        if (kTwin) {
            const float y2 = 0.5f * chip::pulseFrame(p2, z2, hi2, dt2.v, du2.v) + du2.v;
            y = wa.v * y + wb.v * y2;
            dt2.v += dt2.d;
            du2.v += du2.d;
            wa.v += wa.d;
            wb.v += wb.d;
        }
        u[i] = y;
        dt.v += dt.d;
        du.v += du.d;
    }
    V.ph = p;
    V.z = z;
    V.ph2 = p2;
    V.z2 = z2;
    V.hi = hi;
    V.hi2 = hi2;
}
void wavePass(float* u, uint32_t n, VoiceState& V, const uint8_t* t, Lin dt) {
    float p = V.ph;
    for (uint32_t i = 0; i < n; ++i) {
        p += dt.v;
        if (p >= 1.0f) p -= 1.0f;
        u[i] = float(t[int(p * 32.0f) & 31]) * (1.0f / 15.0f);
        dt.v += dt.d;
    }
    V.ph = p;
}
// The register steps k = the clock's whole shifts this frame (<= 8; one
// lfsrSteps for up to bits - 1 of them); the output holds its last bit.
void noisePass(float* u, uint32_t n, VoiceState& V, float r, int bits) {
    float ph = V.nph;
    uint32_t s = V.lfsr;
    float out = float(V.nbit);
    const int most = bits - 1;
    for (uint32_t i = 0; i < n; ++i) {
        ph += r;
        int k = int(ph);
        ph -= float(k);
        if (k) {
            if (k > most) {
                chip::lfsrSteps(s, bits, 1, most);
                k -= most;
            }
            out = float(chip::lfsrSteps(s, bits, 1, k));
        }
        u[i] = out;
    }
    V.nph = ph;
    V.lfsr = s;
    V.nbit = uint8_t(out);
}

inline void glideTo(float& x, float t, float c) {
    if (x == t) return;
    x = t + (x - t) * c;
    if (__builtin_fabsf(x - t) < 0.01f) x = t;
}

class HandEngine final : public ISynthEngine {
public:
    int32_t id() const override { return kEngineId; }
    const char* name() const override { return "HANDTYPE"; }

    void slotReset(SynthSlotScratch& sc) override { std::memset(sc.bytes, 0, sizeof(sc.bytes)); }
    void setTempo(float bpm) override { bpm_ = bpm; }

    HAND_PER_BLOCK void prepare(SynthSlotScratch& sc, const SynthParams& p) override {
        if (p.count < kParamCount) return;
        SlotState& S = sc.as<SlotState>();
        if (!S.valid || S.serial != p.serial || p.moving) refresh(S, p);
    }

    HAND_PER_BLOCK void noteOn(SynthVoice& v, const SynthParams& p, const SynthNote& n) override {
        if (p.count < kParamCount) return;
        SlotState& S = v.slotScratch->as<SlotState>();
        VoiceState& V = v.as<VoiceState>();
        if (!S.valid || S.serial != p.serial) refresh(S, p);
        const bool held = n.reused && V.started && !V.rel;
        const int mode = S.glideMode;
        const bool legato = held && (mode == kLegato || mode == kLegatoOverlap) && n.overlap;
        float pitch = n.pitch;
        V.drum = 0;
        V.hatIdx = 0;
        if (S.chan == kDrums) {
            int hat = 0;
            V.drum = uint8_t(drumForNote(n.note, &hat));
            V.hatIdx = uint8_t(hat);
            if (V.drum != kTom) pitch = 60.0f;
            if (V.drum == kHat) V.hat = ++S.hatSerial;
        }
        // Glide (A-Type's semantics); drums never glide.
        const bool alwaysGlide = mode == kAlways || mode == kLegato;
        V.target = pitch;
        V.glide = S.chan != kDrums && S.glideC > 0.0f && (held || S.hasLast) && !n.fxGlide && (alwaysGlide || n.overlap);
        if (!V.glide) V.pitch = pitch;
        else if (!held) V.pitch = S.lastPitch;
        S.lastPitch = pitch;
        S.hasLast = 1;
        if (!legato) {
            // A new note: the envelope at Init (drums: 15), the sweep, the Length, the tricks.
            V.env = S.chan == kDrums ? 15.0f : float(S.envInit);
            V.sweep = 0.0f;
            V.sweepLeft = 0.0f;
            V.life = S.chan != kDrums && S.length ? float(S.length) * kLenTick : -1.0f;
            V.age = 0.0f;
            chip::tricksStart(V.tr, S.tc, bpm_);
            if (!n.reused) {
                V.ph = V.ph2 = 0.0f;
                V.z = V.z2 = 0.0f;
                V.lfsr = 0x7FFFu ^ (uint32_t(n.note) * 0x9E37u & 0x7FFEu);   // a voice per note: its own noise
                V.nph = 0.0f;
                V.du = kDutyOf[S.duty];
                V.du2 = kDutyOf[S.p2duty];
                V.p2l = S.p2Level;
            }
        }
        V.rel = 0;
        V.cut = 0;
        V.started = 1;
        v.level = n.reused ? V.env * (1.0f / 15.0f) : 1.0f;
    }

    void noteOff(SynthVoice& v, const SynthParams&) override {
        VoiceState& V = v.as<VoiceState>();
        if (!V.started) return;
        const SlotState& S = v.slotScratch->as<SlotState>();
        if (S.chan == kDrums) return;   // a hit rings out
        V.rel = 1;
        if (!S.fade) V.cut = 1;
    }

    HAND_PER_BLOCK bool render(SynthVoice& v, const SynthParams& p, float g0, float gInc, float* L, float* R) override {
        VoiceState& V = v.as<VoiceState>();
        if (!V.started || p.count < kParamCount) {
            v.level = 0.0f;
            return false;
        }
        const SlotState& S = v.slotScratch->as<SlotState>();
        Cfg c;
        cfgOf(S, V, c);
        // Endings that fade over this block.
        if (V.drum == kHat && S.chan == kDrums && V.hat != S.hatSerial) V.cut = 1;   // choked
        if (V.life >= 0.0f) {
            V.life -= float(kBlock);
            if (V.life <= 0.0f) V.cut = 1;
        }
        // The envelope (held for the block): toward 15 (Up) or 0; Release
        // Fade: toward 0 a level per step time.
        float e = V.env;
        if (c.clap) {
            // Three bursts (6 ms on, 6 ms low), then the tail from 12.
            V.age += kBlockT;
            const float a = V.age;
            if (a < 0.03f) e = (int(a * (1.0f / 0.006f)) & 1) ? 2.0f : 15.0f;
            else {
                if (V.env > 12.0f) V.env = 12.0f;
                chip::stepEnvTo(V.env, 0.0f, c.per, float(kBlock));
                e = V.env;
            }
        } else if (c.per > 0.0f) {
            chip::stepEnvTo(V.env, V.rel || !c.envUp ? 0.0f : 15.0f, c.per, float(kBlock));
            e = V.env;
        }
        const bool rising = !V.rel && c.envUp;
        float eg = chip::env4(e, true, rising);
        if (c.kind == kKWave && c.levels4) eg = kLevel4[int(eg * 3.0f + 0.5f)];
        if (eg <= 0.0f && !rising && (!c.clap || V.age >= 0.03f)) V.cut = 1;   // decayed to 0: done
        // Glide, the sweep (and Sweep Cut), the pitch at both block ends.
        const float pit0 = V.pitch;
        glideTo(V.pitch, V.target, V.glide ? S.glideC : 0.0f);
        const float sw0 = V.sweep;
        if (c.sweepDir != kSweepOff) {
            V.sweepLeft -= float(kBlock);
            const float st = c.sweepDir == kSweepDown ? kSweepDownSt[c.sweepShift] : kSweepUpSt[c.sweepShift];
            while (V.sweepLeft <= 0.0f) {
                V.sweep += st;
                V.sweepLeft += float(c.sweepTime) * kSweepTick;
            }
            const float n = V.pitch + c.semi + V.sweep + v.bend;
            if (c.sweepCut && (n < kPitch20Hz || n > kPitch20kHz)) V.cut = 1;
        }
        const float base0 = pit0 + c.semi + sw0 + v.bendStart, base1 = V.pitch + c.semi + V.sweep + v.bend;
        // The channel, chunk by chunk at the CHIP ticks.
        float u[kBlock];
        const bool ticking = chip::tricksTick(S.tc);
        chip::tricksRate(V.tr, S.tc, bpm_);
        const Lin du = lin(V.du, kDutyOf[c.duty]), du2 = lin(V.du2, kDutyOf[c.p2duty]);
        const Lin wa = lin(1.0f / (1.0f + V.p2l), 1.0f / (1.0f + c.p2Level)), wb = lin(V.p2l / (1.0f + V.p2l), c.p2Level / (1.0f + c.p2Level));
        const bool twin = c.p2Level > 0.0f || V.p2l > 0.0f;
        constexpr float kInvB = 1.0f / float(kBlock);
        // Track: the noise clock nearest the note, once a block (the block's middle pitch).
        const float trackR = c.kind == kKNoise && c.track
                                 ? trackShifts(32.0f * 440.0f * fastExp2((0.5f * (base0 + base1) + chip::tricksOffset(V.tr, S.tc, 0.0f) - 69.0f) *
                                                                         (1.0f / 12.0f)))
                                 : 0.0f;
        uint32_t done = 0;
        while (done < kBlock) {
            const uint32_t m = ticking ? V.tr.tick.chunk(kBlock - done) : kBlock - done;
            const float o0 = chip::tricksOffset(V.tr, S.tc, 0.0f), o1 = chip::tricksOffset(V.tr, S.tc, float(m) * kInvFs);
            const float f0 = float(done) * kInvB, f1 = float(done + m) * kInvB;
            const float n0 = base0 + (base1 - base0) * f0 + o0, n1 = base0 + (base1 - base0) * f1 + o1;
            const float inv = 1.0f / float(m);
            if (c.kind == kKNoise) {
                const float r = c.track ? trackR : c.noise;
                noisePass(u + done, m, V, r > 8.0f ? 8.0f : r, c.width == kWidth7 ? 7 : 15);
            } else {
                const float a = incOf(n0, 0.0f, 0.0f, kMaxDt), b = incOf(n1, 0.0f, 0.0f, kMaxDt);
                const Lin dt{a, (b - a) * inv};
                if (c.kind == kKWave) {
                    wavePass(u + done, m, V, S.table, dt);
                } else {
                    // The duty / pulse 2 ramps run over the whole block.
                    const float at = float(done);
                    const Lin d1{du.v + du.d * at, du.d}, d2{du2.v + du2.d * at, du2.d};
                    if (twin) {
                        const float a2 = incOf(n0, c.p2Semi, 0.0f, kMaxDt), b2 = incOf(n1, c.p2Semi, 0.0f, kMaxDt);
                        pulsePass<true>(u + done, m, V, dt, Lin{a2, (b2 - a2) * inv}, d1, d2, Lin{wa.v + wa.d * at, wa.d},
                                        Lin{wb.v + wb.d * at, wb.d});
                    } else {
                        pulsePass<false>(u + done, m, V, dt, dt, d1, d2, wa, wb);
                    }
                }
            }
            const bool t = ticking && V.tr.tick.advance(m);
            chip::tricksAdvance(V.tr, S.tc, m, t);
            done += m;
        }
        V.du = kDutyOf[c.duty];
        V.du2 = kDutyOf[c.p2duty];
        V.p2l = c.p2Level;
        // The DAC: u e on 2^Bits - 1 steps, less the channel's mean x e on
        // the same steps; an ending voice fades to 0 over the block.
        float mean0, mean1;
        if (c.kind == kKNoise) {
            mean0 = mean1 = 0.5f;
        } else if (c.kind == kKWave) {
            mean0 = mean1 = S.waveMean;
        } else {
            mean0 = twin ? wa.v * du.v + wb.v * du2.v : du.v;
            mean1 = twin ? (V.du + V.p2l * V.du2) / (1.0f + V.p2l) : V.du;
        }
        const float trim = S.chan == kDrums ? kDrumTrim : kTrim;
        const float gEnd = V.cut ? 0.0f : (g0 + gInc * float(kBlock)) * trim;
        if (S.bits >= 8) {
            Lin g = lin(g0 * trim, gEnd);
            Lin d = lin(mean0 * eg, mean1 * eg);
            for (uint32_t i = 0; i < kBlock; ++i) {
                const float y = (u[i] * eg - d.v) * g.v;
                L[i] += y;
                R[i] += y;
                d.v += d.d;
                g.v += g.d;
            }
        } else {
            const float M = float((1 << S.bits) - 1), em = eg * M;
            Lin g = lin(g0 * trim / M, gEnd / M);
            Lin d = lin(mean0 * em, mean1 * em);
            for (uint32_t i = 0; i < kBlock; ++i) {
                float q = u[i] * em;
                q = q < 0.0f ? 0.0f : (q > em ? em : q);
                const float y = float(int(q + 0.5f) - int(d.v + 0.5f)) * g.v;
                L[i] += y;
                R[i] += y;
                d.v += d.d;
                g.v += g.d;
            }
        }
        v.level = eg;
        if (V.cut) {
            V.started = 0;
            v.level = 0.0f;
            return false;
        }
        return true;
    }

private:
    float bpm_ = 120.0f;
};

HandEngine gHand;

}  // namespace

Drum drumForNote(int note, int* hat) {
    if (hat) *hat = 0;
    if (note < 60) return kTom;
    const int n = 60 + (note - 60) % 12;
    switch (n) {
        case 60: return kKick;
        case 61: return kBlip;
        case 62: return kSnare;
        case 63:
        case 71: return kClap;
        case 64:
        case 65:
        case 66:
        case 67:
            if (hat) *hat = n - 64;
            return kHat;
        case 68: return kBell;
        case 69: return kCrash;
        default: return kRide;
    }
}

float envStepSeconds(int step) { return float((step < 0 ? 0 : (step > 6 ? 6 : step)) + 1) * (1.0f / 64.0f); }
float drumStepSeconds(int decay) { return kDrumStep[decay < 0 ? 0 : (decay > 7 ? 7 : decay)]; }
float noiseHz(int shift, int divider) {
    shift = shift < 0 ? 0 : (shift > 13 ? 13 : shift);
    divider = divider < 0 ? 0 : (divider > 7 ? 7 : divider);
    return 8.0f * kSampleRate / float(divider ? 2 * divider : 1) / float(1 << shift);
}
const uint8_t* waveTable(int wave) { return kTables[wave < 0 ? 0 : (wave >= kUser ? kUser - 1 : wave)]; }

ISynthEngine* engine() { return &gHand; }

}  // namespace hand
}  // namespace audio
}  // namespace ot
