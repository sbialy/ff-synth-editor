// Copied from opentracker-synths (https://github.com/opentracker-fw/opentracker-synths, modules/cstype/src/cstype.h, commit eb150a5f741b),
// Copyright (c) 2026 Marcin Spoczynski, MIT licence, see licenses/LICENSE-OpenTracker-synths-MIT.txt. Not modified, except this notice.
// CS-Type: a two-layer polyphonic synth voice (OpenTracker 3.x module engine,
// id 0x83, module CST1, Patches/CSTYPE/, "CS-Type" on the Synth page). Our
// own design after the large dual-channel polysynths of the late 1970s as
// their owner's manuals describe them: per note two layers (I and II), each a
// VCO (feet 16' .. 2', saw and pulse together with their own PWM LFO, a sine
// and noise) into a resonant 12 dB high-pass, then a resonant 12 dB low-pass
// with an initial-level / attack-level envelope, and a VCA with its own ADSR
// and level; the layers sum into a ring modulator with a sweep. Panel
// controls: Brilliance and Resonance over both layers, layer II detune, a
// sub-oscillator LFO (five functions) into the VCOs / filters / VCAs, Touch
// (initial = the note's velocity, after = the Touch parameter, on a macro),
// a Ribbon (pitch, on a macro), glide. Not a copy of any instrument.
//
// Polyphony is the slot setting. Engine contract (audio/synth_engine.h):
// Volume (index 66) is never applied here; the voice is mono (L = R).
#pragma once

#include "audio/synth_engine.h"

namespace ot {
namespace audio {
namespace cstype {

constexpr int32_t kEngineId = 0x83;

// One layer's parameters (layer I at 0, layer II at kLayerParams).
enum LayerParam : int {
    kFeet = 0, kSaw, kPulse, kPw, kPwm, kPwmSpeed, kSine, kNoise,                       // OSC
    kHpfCutoff, kHpfRes, kLpfCutoff, kLpfRes, kInitLevel, kAttackLevel,                 // VCF
    kFAttack, kFDecay, kFRelease,
    kAttack, kDecay, kSustain, kRelease, kLevel,                                        // VCA
    kLayerParams,   // 22
};
constexpr int kLayer2 = kLayerParams;
// Parameter indices after the two layers.
enum Param : int {
    kBrilliance = 2 * kLayerParams, kResonance, kDetune, kRmDepth, kRmSpeed, kRmSweep, kRmDecay,   // MIX (44..50)
    kFunction, kSpeed, kToVco, kToVcf, kToVca,                                                    // MOD (51..)
    kTouch, kInitBril, kInitLevelVel, kAfterVco, kAfterVcf, kAfterVca,
    kRibbon, kRibbonRange, kGlideMode, kGlideTime, kVolume,                                       // CTRL (62..66)
    kParamCount,   // 67
};
enum Feet : int { k16 = 0, k8, k4, k2 };
enum Function : int { kFnSine = 0, kFnSaw, kFnRamp, kFnSquare, kFnNoise };
enum GlideMode : int { kAlways = 0, kOverlap, kLegato, kLegatoOverlap };

ISynthEngine* engine();

}  // namespace cstype
}  // namespace audio
}  // namespace ot
