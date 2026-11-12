// Copied from opentracker-synths (https://github.com/opentracker-fw/opentracker-synths, modules/fm4/src/fm4.h, commit eb150a5f741b),
// Copyright (c) 2026 Marcin Spoczynski, MIT licence, see licenses/LICENSE-OpenTracker-synths-MIT.txt. Not modified, except this notice.
// FM4: a four-operator FM synth engine (OpenTracker 3.x module engine, id
// 0x80, module FM4S). Our own design in the spirit of the classic 4-op FM
// chips: four sine operators, eight algorithms (the usual 4-op topologies),
// feedback on operator 1, per operator Mult / Detune / Level and a 5-stage
// envelope (Attack, Decay, Sustain level, Sustain rate, Release), one LFO for
// vibrato and tremolo, glide. Not a copy of any instrument.
//
// Engine contract (audio/synth_engine.h): Volume (index 6) is never applied
// here; output is mono (L = R).
#pragma once

#include "audio/synth_engine.h"

namespace ot {
namespace audio {
namespace fm4 {

constexpr int32_t kEngineId = 0x80;

// Parameter indices.
enum Param : int {
    kAlgorithm = 0, kFeedback, kLfoRate, kVibrato, kTremolo, kGlideTime, kVolume,
    kOpBase = 7,   // operator k (0..3): kOpBase + kOpStride * k + field
    kParamCount = 7 + 4 * 9,
};
enum OpField : int { kMult = 0, kDetune, kLevel, kAttack, kDecay, kSustain, kSusRate, kRelease, kAm, kOpStride };
constexpr int op(int k, int field) { return kOpBase + kOpStride * k + field; }

// Mult enum index -> frequency ratio: 0 = 0.5, then 1..15.
inline float multOf(int i) { return i <= 0 ? 0.5f : float(i > 15 ? 15 : i); }

ISynthEngine* engine();

}  // namespace fm4
}  // namespace audio
}  // namespace ot
