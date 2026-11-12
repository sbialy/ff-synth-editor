// Copied from opentracker-synths (https://github.com/opentracker-fw/opentracker-synths, modules/atype/src/atype.h, commit eb150a5f741b),
// Copyright (c) 2026 Marcin Spoczynski, MIT licence, see licenses/LICENSE-OpenTracker-synths-MIT.txt. Not modified, except this notice.
// A-Type: a duophonic two-oscillator synth voice (OpenTracker 3.x module
// engine, id 0x84, module ATY1, Patches/ATYPE/, "A-Type" on the Synth page).
// Our own design after the semi-modular duophonic synthesizers of the 1970s
// as their owner's manuals describe them: two VCOs (saw or pulse with PWM,
// four ranges, VCO 2 tune, hard sync), a mixer with noise or the ring
// modulator as the third source, a sample & hold (noise, VCO 1, VCO 2 or the
// mix; clocked at a rate or by the keys; lag), a high-pass then a resonant
// 4-pole or 2-pole low-pass, an ADSR and an AR envelope, one LFO, glide.
// Not a copy of any instrument.
//
// Keyboard Duo (Poly 1): with two or more notes held on the slot VCO 1 plays
// the lowest, VCO 2 the highest (SynthParams::held); one note plays both.
// Priority Last / Low / High (the framework's note priority, C1:
// kSynthFlagNotePriority + priorityParam). At Poly 2 and more Duo is
// ignored. Engine contract (audio/synth_engine.h): Volume (index 45) is never
// applied here; the voice is mono (L = R).
#pragma once

#include "audio/synth_engine.h"

namespace ot {
namespace audio {
namespace atype {

constexpr int32_t kEngineId = 0x84;

// Parameter indices.
enum Param : int {
    kVco1Range = 0, kVco1Fine, kVco1Wave, kVco1Pw, kVco1Pwm, kVco1LfoMod,              // VCO1
    kVco2Range, kVco2Tune, kVco2Fine, kVco2Wave, kVco2Pw, kVco2Pwm, kVco2Mod,           // VCO2
    kVco2ModSrc, kSync,
    kVco1Level, kVco2Level, kSource, kSourceLevel,                                      // MIX
    kShInput, kShClock, kShRate, kShLag,                                                // S&H
    kCutoff, kResonance, kFilterMode, kKeyTrack, kEnvAmt, kEnvSrc, kLfoAmt, kShAmt,     // VCF
    kHpf,
    kVcaEnv, kAttack, kDecay, kSustain, kRelease, kArAttack, kArRelease,                // ENV
    kLfoRate, kLfoShape,                                                                // LFO
    kKeyboard, kPriority, kGlideMode, kGlideTime, kVolume,                              // CTRL
    kParamCount,   // 46
};
enum Range : int { k32 = 0, k16, k8, k4 };
enum Wave : int { kSaw = 0, kPulse };
enum ModSrc : int { kModLfo = 0, kModSh, kModAdsr };
enum Source : int { kNoise = 0, kRing };
enum ShInput : int { kShNoise = 0, kShVco1, kShVco2, kShMix };
enum ShClock : int { kClockRate = 0, kClockKey };
enum FilterMode : int { k4Pole = 0, k2Pole };
enum EnvSel : int { kAdsr = 0, kAr };
enum LfoShape : int { kSine = 0, kTri, kSquare, kSawUp };
enum Keyboard : int { kMono = 0, kDuo };
enum Priority : int { kLast = 0, kLow, kHigh };
enum GlideMode : int { kAlways = 0, kOverlap, kLegato, kLegatoOverlap };

ISynthEngine* engine();

}  // namespace atype
}  // namespace audio
}  // namespace ot
