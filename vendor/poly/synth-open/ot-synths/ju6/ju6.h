// Copied from opentracker-synths (https://github.com/opentracker-fw/opentracker-synths, modules/ju6/src/ju6.h, commit eb150a5f741b),
// Copyright (c) 2026 Marcin Spoczynski, MIT licence, see licenses/LICENSE-OpenTracker-synths-MIT.txt. Not modified, except this notice.
// JU6: a Juno-style polysynth voice (OpenTracker 3.x module engine, id 0x81,
// module JU6S). Our own design after the voice described in the owner's
// manuals of the classic one-DCO polysynths of the early 1980s: one DCO with
// a band-limited saw and a pulse that can sound together (manual or LFO pulse
// width), a square sub-oscillator one octave down and noise; a four-position
// non-resonant high-pass (0 = bass boost, 1 = flat); a 24 dB/oct resonant
// low-pass (four one-pole stages in a feedback loop, soft saturation,
// self-oscillation at the top of Resonance) with Env (bipolar), LFO, Key
// follow and Velocity; one ADSR for the VCF and the VCA (VCA mode Env or
// Gate); one triangle LFO with Rate and Delay; the built-in stereo chorus
// (Off / I / II, a patch parameter) on the slot's voice sum, as the
// instrument always had it: the core's shared BBD chorus
// (audio/bbd_chorus.h, the JUNO insert's DSP), one line per slot. Not a copy
// of any instrument.
//
// Engine contract (audio/synth_engine.h): Volume (index 21) is never applied
// here; the voices are mono (L = R), the chorus makes the slot stereo.
#pragma once

#include "audio/synth_engine.h"

namespace ot {
namespace audio {
namespace ju6 {

constexpr int32_t kEngineId = 0x81;

// Parameter indices.
enum Param : int {
    kSaw = 0, kPulse, kPw, kPwMode, kSub, kNoise, kVibrato,          // DCO
    kHpf, kCutoff, kResonance, kEnvAmt, kVcfLfo, kKeyFollow, kVelVcf, // HPF / VCF
    kVcaMode,                                                         // VCA
    kAttack, kDecay, kSustain, kRelease,                              // ENV
    kLfoRate, kLfoDelay,                                              // LFO
    kVolume,
    kChorus,                                                          // CHORUS (after Volume: older patches keep their indices)
    kParamCount,
};
enum PwMode : int { kPwManual = 0, kPwLfo };
enum VcaMode : int { kVcaEnv = 0, kVcaGate };
enum Chorus : int { kChorusOff = 0, kChorusI, kChorusII };

ISynthEngine* engine();
// Tests: the chorus tap delay of side c (0 = L, 1 = R) at the end of the
// slot's last block, frames.
float chorusDelay(const SynthSlotScratch& sc, int c);

}  // namespace ju6
}  // namespace audio
}  // namespace ot
