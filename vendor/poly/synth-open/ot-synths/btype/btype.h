// Copied from opentracker-synths (https://github.com/opentracker-fw/opentracker-synths, modules/btype/src/btype.h, commit eb150a5f741b),
// Copyright (c) 2026 Marcin Spoczynski, MIT licence, see licenses/LICENSE-OpenTracker-synths-MIT.txt. Not modified, except this notice.
// B-Type: a chip-style voice in the spirit of a 4-channel 8-bit home
// computer sound chip with polynomial counters (OpenTracker 3.x module engine,
// id 0x88, module BTY1, Patches/BTYPE/, "B-Type" on the Synth page). Our own
// design from general knowledge of such chips: a channel whose pitch comes
// from a divider of a base clock (15.6 kHz, 64 kHz or 1.79 MHz; Tuning Free,
// Coarse: the nearest 8-bit divider, out of tune up high, or Fine: a 16-bit
// divider), whose output is a square or, at each divider event, the next bits
// of polynomial counters (the "buzz" distortions), an optional second
// channel a few divider steps away, the high-pass pair trick (the output less
// itself a fixed time earlier: a comb), a 4-bit stepped ADSR in 1/60 s
// frames, a small DAC, glide and the CHIP tricks (audio/chip_dsp.h). Not a
// copy of any chip.
//
// Engine contract (audio/synth_engine.h): Volume (index 26) is never applied
// here; the voice is mono (L = R).
#pragma once

#include "audio/synth_engine.h"

namespace ot {
namespace audio {
namespace btype {

constexpr int32_t kEngineId = 0x88;

// Parameter indices.
enum Param : int {
    kClock = 0, kDistortion, kTuning, kPolyReset, kHiPass, kHpFreq,              // CHAN
    kOsc2Level, kOsc2Detune, kOsc2Distortion,                                   // OSC2
    kAttack, kDecay, kSustain, kRelease, kEnvBits,                              // ENV
    kArpMode, kArpRate, kArpNote2, kArpNote3, kVibRate, kVibDepth, kVibDelay,   // CHIP
    kSlideStart, kSlideTime,
    kGlideMode, kGlideTime, kDacBits, kVolume,                                  // CTRL
    kParamCount,   // 27
};
enum Clock : int { k15k = 0, k64k, k179M };
enum Distortion : int { kPure = 0, kPoly4, kPoly5, kPoly9, kPoly17, kPoly5x4, kPoly5x17, kPoly5x9, kDistCount };
enum Tuning : int { kFree = 0, kCoarse, kFine };
enum GlideMode : int { kAlways = 0, kOverlap, kLegato, kLegatoOverlap };

// The base clock (Hz) of a Clock setting.
float clockHz(int clock);
// The pitch (Hz) a channel plays for a wanted pitch: Free exact; Coarse the
// nearest 8-bit divider N at the clock (clock / (2 (N + 1))); Fine a 16-bit
// divider at 1.79 MHz. divider: N (Free: fractional).
float tunedHz(float hz, int clock, int tuning, float* divider = nullptr);

ISynthEngine* engine();

}  // namespace btype
}  // namespace audio
}  // namespace ot
