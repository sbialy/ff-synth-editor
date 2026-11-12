// Copied from opentracker-synths (https://github.com/opentracker-fw/opentracker-synths, modules/dtype/src/dtype.h, commit eb150a5f741b),
// Copyright (c) 2026 Marcin Spoczynski, MIT licence, see licenses/LICENSE-OpenTracker-synths-MIT.txt. Not modified, except this notice.
// D-Type: a three-oscillator mono synth voice (OpenTracker 3.x module engine,
// id 0x82, module DTY1, Patches/DTYPE/, "D-Type" on the Synth page). Our own
// design after the classic three-oscillator monophonic synthesizers of the
// early 1970s as their owner's manuals describe them: three VCOs (six waves,
// six ranges, VCO 2 / 3 tune and fine, VCO 3 free of the keyboard as an
// LFO), white or pink noise, a mixer that can drive the filter input and
// feed the output back, a 4-pole ladder low-pass (Cutoff, Emphasis up to
// self-oscillation, Contour amount, Key Track), two ADS contours with one
// Decay switch for the release, glide, and a modulation mix (VCO 3 .. noise)
// into the oscillators and the filter through the Wheel. Not a copy of any
// instrument.
//
// Mono by design: the Synth page's Poly setting sets the voices; Poly 1 plays
// last-note priority, legato and glide (SynthBank). Engine contract
// (audio/synth_engine.h): Volume (index 34) is never applied here; the voice
// is mono (L = R).
#pragma once

#include "audio/synth_engine.h"

namespace ot {
namespace audio {
namespace dtype {

constexpr int32_t kEngineId = 0x82;

// Parameter indices.
enum Param : int {
    kVco1Range = 0, kVco1Wave, kVco1Level,                                    // VCO 1
    kVco2Range, kVco2Wave, kVco2Tune, kVco2Fine, kVco2Level,                  // VCO 2
    kVco3Range, kVco3Wave, kVco3Tune, kVco3Fine, kVco3Level, kVco3Kb,         // VCO 3
    kNoiseLevel, kNoiseColour, kFeedback,                                     // MIX
    kCutoff, kEmphasis, kContour, kKeyTrack,                                  // VCF
    kFAttack, kFDecay, kFSustain,                                             // filter contour
    kLAttack, kLDecay, kLSustain,                                             // loudness contour
    kModMix, kOscMod, kFilterMod, kWheel,                                     // MOD
    kGlideMode, kGlideTime, kDecaySw, kVolume,                                // CTRL
    kParamCount,   // 35
};
enum Range : int { kLo = 0, k32, k16, k8, k4, k2 };
// VCO 1 / 2 waves; VCO 3 has Rev Saw in place of Tri-Saw.
enum Wave : int { kTri = 0, kTriSaw, kSaw, kSquare, kWide, kNarrow };
constexpr int kRevSaw = kTriSaw;
enum NoiseColour : int { kWhite = 0, kPink };
enum KeyTrack : int { kKeyOff = 0, kKey13, kKey23, kKeyFull };
enum GlideMode : int { kAlways = 0, kOverlap, kLegato, kLegatoOverlap };

ISynthEngine* engine();

}  // namespace dtype
}  // namespace audio
}  // namespace ot
