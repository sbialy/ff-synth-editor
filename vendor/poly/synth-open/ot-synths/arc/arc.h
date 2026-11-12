// Copied from opentracker-synths (https://github.com/opentracker-fw/opentracker-synths, modules/arc/src/arc.h, commit eb150a5f741b),
// Copyright (c) 2026 Marcin Spoczynski, MIT licence, see licenses/LICENSE-OpenTracker-synths-MIT.txt. Not modified, except this notice.
// Arc-Type: a chip-style voice in the spirit of a home-console 4-operator FM
// sound chip with its square / noise companion (OpenTracker 3.x module engine,
// id 0x89, module ARC1, Patches/ARCTYPE/, "Arc-Type" on the Synth page). Our
// own design from general knowledge of such chips: four sine operators in one
// of eight algorithms (audio/fm_dsp.h), feedback on operator 1, per operator
// Multiple / Detune / Level, a 5-rate envelope (attack, first decay to the
// first decay level, second decay, release; rates speed up with the note by
// Rate Scaling) with a looping mode at -48 dB (repeat, mirror, hold inverted,
// repeat inverted), amplitude-modulation sensitivity; one LFO with pitch and
// amplitude depths; a 9-bit DAC with an optional ladder character (a gap
// around zero, uneven steps); an Aux square or noise voice with a 4-bit
// stepped decay; glide and the CHIP arp / slide (audio/chip_dsp.h). Not a
// copy of any chip.
//
// Engine contract (audio/synth_engine.h): Volume (index 5) is never applied
// here; the voice is mono (L = R).
#pragma once

#include "audio/synth_engine.h"

namespace ot {
namespace audio {
namespace arc {

constexpr int32_t kEngineId = 0x89;

// Per operator (k = 0..3): op(k, field).
enum OpField : int { kMul = 0, kDt, kLevel, kRs, kAr, kD1r, kD1l, kD2r, kRr, kLoop, kAms, kOpStride };
// Parameter indices.
enum Param : int {
    kAlgorithm = 0, kFeedback, kDac, kGlideMode, kGlideTime, kVolume,   // GLOBAL
    kLfoRate, kPms,                                                    // LFO
    kOpBase = 8,                                                       // OP1..OP4
    kAuxWave = 52, kAuxLevel, kAuxOctave, kAuxDecay,                   // AUX
    kArpMode, kArpRate, kArpNote2, kArpNote3, kSlideStart, kSlideTime, // CHIP
    kParamCount,   // 62
};
constexpr int op(int k, int field) { return kOpBase + kOpStride * k + field; }
enum Dac : int { kDacOff = 0, kDac9, kDacLadder };
enum Loop : int { kLoopOff = 0, kRepeat, kMirror, kHoldInv, kRepeatInv };
enum AuxWave : int { kAuxOff = 0, kAuxSquare, kAuxNoise };
enum GlideMode : int { kAlways = 0, kOverlap, kLegato, kLegatoOverlap };

// Multiple index -> ratio: 0 = 0.5, then 1..15.
inline float mulOf(int i) { return i <= 0 ? 0.5f : float(i > 15 ? 15 : i); }
// The rate tables (s): attack to full (rate 1..31; 0 never starts), a 48 dB
// decay (1..31; 0 holds), a 48 dB release (0..15).
float attackSeconds(int rate);
float decaySeconds(int rate);
float releaseSeconds(int rate);
// The first decay level 0..15 as attenuation (dB, 3 dB steps).
inline float d1lDb(int i) { return 3.0f * float(i < 0 ? 0 : (i > 15 ? 15 : i)); }
// The LFO: speed index 1..8 (Hz; 0 off), PMS 0..7 (cents), AMS 0..3 (dB).
float lfoHz(int i);
float pmsCents(int i);
float amsDb(int i);
// Detune -3..3 at a note: cents.
float dtCents(int dt, float note);

ISynthEngine* engine();

}  // namespace arc
}  // namespace audio
}  // namespace ot
