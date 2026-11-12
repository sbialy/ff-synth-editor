// Copied from opentracker-synths (https://github.com/opentracker-fw/opentracker-synths, modules/hand/src/hand.h, commit eb150a5f741b),
// Copyright (c) 2026 Marcin Spoczynski, MIT licence, see licenses/LICENSE-OpenTracker-synths-MIT.txt. Not modified, except this notice.
// Hand-Type: a chip-style voice in the spirit of a 4-channel handheld console
// (OpenTracker 3.x module engine, id 0x87, module HND1, Patches/HANDTYPE/,
// "Hand-Type" on the Synth page). Our own design from general knowledge of
// such sound chips: one patch is one channel: Pulse (four duties, a
// frequency sweep that can end the note, a second pulse for the twin-pulse
// lead), Wave (32 steps of 4 bits: twelve built-in tables or a User table of
// 8 points), Noise (a 15- or 7-bit shift register at a divided clock, or
// following the note), or Drums: a kit by note made of those channels (one
// voice per hit, hats choke each other). A 4-bit stepped envelope, a Length
// timer, a small DAC (Bits 4..8) on the voice, the CHIP tricks (arp at a
// fixed tick or a tempo division, stepped vibrato, a pitch slide at the note
// start; audio/chip_dsp.h) and glide. Not a copy of any chip.
//
// Drums note map (Channel Drums): 60 kick (a pulse swept down, cut at the
// bottom), 61 blip, 62 snare (15- or 7-bit noise), 63 and 71 clap (three
// noise bursts), 64..67 hat closed .. open (7-bit noise; a hat cuts the hat
// before it), 68 bell (two pulses a fifth apart), 69 crash, 70 ride, 48..59
// toms (a pulse with a short sweep, chromatic); notes from 72 repeat 60..71,
// notes below 48 play the low tom at their pitch.
// Engine contract (audio/synth_engine.h): Volume (index 51) is never applied
// here; the voice is mono (L = R).
#pragma once

#include "audio/synth_engine.h"

namespace ot {
namespace audio {
namespace hand {

constexpr int32_t kEngineId = 0x87;

// Parameter indices.
enum Param : int {
    kChannel = 0,                                                                       // CHAN
    kDuty, kSweepDir, kSweepTime, kSweepShift, kSweepCut, kP2Level, kP2Detune, kP2Duty,   // PULSE
    kWave, kUser1, kUser2, kUser3, kUser4, kUser5, kUser6, kUser7, kUser8, kLevels,       // WAVE
    kWidth, kNoiseShift, kDivider, kTrack,                                              // NOISE
    kEnvInit, kEnvDir, kEnvStep, kRelease, kLength,                                     // ENV
    kKickTune, kKickSweep, kKickDecay, kSnareWidth, kSnareDecay, kHatShift,             // DRUMS
    kHatClosedDecay, kHatOpenDecay, kCrashDecay, kTomDecay, kBlipDecay,
    kArpMode, kArpRate, kArpNote2, kArpNote3, kVibRate, kVibDepth, kVibDelay,           // CHIP
    kSlideStart, kSlideTime,
    kGlideMode, kGlideTime, kBits, kVolume,                                             // CTRL
    kParamCount,   // 52
};
enum Channel : int { kPulse = 0, kWaveCh, kNoise, kDrums };
enum Duty : int { kDuty12 = 0, kDuty25, kDuty50, kDuty75 };
enum SweepDir : int { kSweepOff = 0, kSweepUp, kSweepDown };
enum Width : int { kWidth15 = 0, kWidth7 };
enum EnvDir : int { kDown = 0, kUp };
enum Release : int { kCut = 0, kFade };
enum Levels : int { kLevels4 = 0, kLevels16 };
enum WaveTable : int {
    kSine = 0, kTriangle, kSaw, kSquare50, kSquare25, kOrgan, kBass, kBuzz, kNasal, kHollow, kRamp2, kUser, kWaveCount
};
enum GlideMode : int { kAlways = 0, kOverlap, kLegato, kLegatoOverlap };
enum Drum : int { kKick = 0, kBlip, kSnare, kClap, kHat, kBell, kCrash, kRide, kTom, kDrumCount };

// The drum a note plays (Channel Drums) and, for hats, 0..3 closed .. open;
// for toms the pitch.
Drum drumForNote(int note, int* hat = nullptr);
// Envelope step and drum decay times: seconds per level.
float envStepSeconds(int step);    // ENV Step 0..6: 1..7 ticks of 1/64 s
float drumStepSeconds(int decay);  // drum Decay 0..7
// The noise clock (Hz) at Shift 0..13 and Divider 0..7 (0 = a half).
float noiseHz(int shift, int divider);
// The built-in wave tables (32 steps, 0..15).
const uint8_t* waveTable(int wave);

ISynthEngine* engine();

}  // namespace hand
}  // namespace audio
}  // namespace ot
