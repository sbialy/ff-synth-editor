// Hand-Type parameter metadata for the open PolySynth shim on MK66. Hand-Type is an engine from OpenTracker 3.x (module opentracker-synths/modules/hand,
// MIT, synth-open/ot-synths/hand). The ranges, defaults, labels, value formats, enum names and the section split follow that module's
// descriptor (modules/hand/src/hand_desc.cpp, MIT, Copyright (c) 2026 Marcin Spoczynski, see licenses/LICENSE-OpenTracker-synths-MIT.txt).
// Edit curves and the default macros are this shim's choice (the same rules as the browser editor engine host).
//
// OpenTracker engine id 0x87, see engine_list.h.
#include "open_engine.h"

#include "PolySynth/config.h"
#include "ot-synths/hand/hand.h"

namespace polysynth::open
{
namespace
{
using F = Fmt;
using C = CurveKind;

const char* const kEnum0[] = { "Pulse", "Wave", "Noise", "Drums" };
const char* const kEnum1[] = { "12.5 %", "25 %", "50 %", "75 %" };
const char* const kEnum2[] = { "Off", "Up", "Down" };
const char* const kEnum3[] = { "Sine", "Triangle", "Saw", "Square 50", "Square 25", "Organ", "Bass", "Buzz", "Nasal", "Hollow", "Ramp 2", "User" };
const char* const kEnum4[] = { "4", "16" };
const char* const kEnum5[] = { "15 bit", "7 bit" };
const char* const kEnum6[] = { "Down", "Up" };
const char* const kEnum7[] = { "16 ms", "31 ms", "47 ms", "62 ms", "78 ms", "94 ms", "109 ms" };
const char* const kEnum8[] = { "Cut", "Fade" };
const char* const kEnum9[] = { "Off", "62 ms", "125 ms", "188 ms", "250 ms", "312 ms", "375 ms", "438 ms" };
const char* const kEnum10[] = { "Off", "Oct", "Maj", "Min", "Sus4", "Dom7", "Maj7", "Min7", "Dim", "Aug", "Pow5", "Custom" };
const char* const kEnum11[] = { "50 Hz", "60 Hz", "100 Hz", "120 Hz", "1/32", "1/48", "1/64", "1/96", "1/128" };
const char* const kEnum12[] = { "Always", "Overlap", "Legato", "Legato Overlap" };

const ParamDef kParams[ot::audio::hand::kParamCount] = {
    { "Channel", 0.0f, 0.0f, 3.0f, F::kEnum, C::kLinear, kEnum0 },
    { "Duty", 2.0f, 0.0f, 3.0f, F::kEnum, C::kLinear, kEnum1 },
    { "Sweep", 0.0f, 0.0f, 2.0f, F::kEnum, C::kLinear, kEnum2 },
    { "Sweep Time", 3.0f, 1.0f, 7.0f, F::kInt, C::kLinear, nullptr },
    { "Sweep Shift", 3.0f, 1.0f, 7.0f, F::kInt, C::kLinear, nullptr },
    { "Sweep Cut", 1.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "Pulse 2", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "P2 Detune", 7.0f, -50.0f, 50.0f, F::kCents, C::kLinear, nullptr },
    { "P2 Duty", 1.0f, 0.0f, 3.0f, F::kEnum, C::kLinear, kEnum1 },
    { "Wave", 1.0f, 0.0f, 11.0f, F::kEnum, C::kLinear, kEnum3 },
    { "User 1", 0.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "User 2", 2.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "User 3", 4.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "User 4", 6.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "User 5", 9.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "User 6", 11.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "User 7", 13.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "User 8", 15.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "Levels", 1.0f, 0.0f, 1.0f, F::kEnum, C::kLinear, kEnum4 },
    { "Width", 0.0f, 0.0f, 1.0f, F::kEnum, C::kLinear, kEnum5 },
    { "Shift", 6.0f, 0.0f, 13.0f, F::kInt, C::kLinear, nullptr },
    { "Divider", 0.0f, 0.0f, 7.0f, F::kInt, C::kLinear, nullptr },
    { "Track", 0.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "Init", 15.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "Dir", 0.0f, 0.0f, 1.0f, F::kEnum, C::kLinear, kEnum6 },
    { "Step", 3.0f, 0.0f, 6.0f, F::kEnum, C::kLinear, kEnum7 },
    { "Release", 0.0f, 0.0f, 1.0f, F::kEnum, C::kLinear, kEnum8 },
    { "Length", 0.0f, 0.0f, 7.0f, F::kEnum, C::kLinear, kEnum9 },
    { "Kick Tune", 0.0f, -24.0f, 24.0f, F::kSemi, C::kLinear, nullptr },
    { "Kick Sweep", 5.0f, 1.0f, 7.0f, F::kInt, C::kLinear, nullptr },
    { "Kick Decay", 3.0f, 0.0f, 7.0f, F::kInt, C::kLinear, nullptr },
    { "Snare Width", 0.0f, 0.0f, 1.0f, F::kEnum, C::kLinear, kEnum5 },
    { "Snare Decay", 3.0f, 0.0f, 7.0f, F::kInt, C::kLinear, nullptr },
    { "Hat Shift", 3.0f, 0.0f, 13.0f, F::kInt, C::kLinear, nullptr },
    { "Hat Closed", 1.0f, 0.0f, 7.0f, F::kInt, C::kLinear, nullptr },
    { "Hat Open", 4.0f, 0.0f, 7.0f, F::kInt, C::kLinear, nullptr },
    { "Crash Decay", 6.0f, 0.0f, 7.0f, F::kInt, C::kLinear, nullptr },
    { "Tom Decay", 3.0f, 0.0f, 7.0f, F::kInt, C::kLinear, nullptr },
    { "Blip Decay", 1.0f, 0.0f, 7.0f, F::kInt, C::kLinear, nullptr },
    { "Arp Mode", 0.0f, 0.0f, 11.0f, F::kEnum, C::kLinear, kEnum10 },
    { "Arp Rate", 1.0f, 0.0f, 8.0f, F::kEnum, C::kLinear, kEnum11 },
    { "Arp Note 2", 4.0f, 0.0f, 24.0f, F::kSemi, C::kLinear, nullptr },
    { "Arp Note 3", 7.0f, 0.0f, 24.0f, F::kSemi, C::kLinear, nullptr },
    { "Vib Rate", 5.0f, 0.5f, 15.0f, F::kLfoHz, C::kExp, nullptr },
    { "Vib Depth", 0.0f, 0.0f, 2.0f, F::kSemi, C::kLinear, nullptr },
    { "Vib Delay", 0.2f, 0.0f, 1.0f, F::kSec, C::kSteep, nullptr },
    { "Slide Start", 0.0f, -24.0f, 24.0f, F::kSemi, C::kLinear, nullptr },
    { "Slide Time", 0.05f, 0.0f, 1.0f, F::kSec, C::kSteep, nullptr },
    { "Glide Mode", 0.0f, 0.0f, 3.0f, F::kEnum, C::kLinear, kEnum12 },
    { "Glide Time", 0.0f, 0.0f, 3.0f, F::kSec, C::kSteep, nullptr },
    { "Bits", 4.0f, 4.0f, 8.0f, F::kInt, C::kLinear, nullptr },
    { "Volume", 1.0f, 0.0f, 2.0f, F::kPct, C::kLinear, nullptr },
};

const uint8_t kSec0[] = { 0 };
const uint8_t kSec1[] = { 1, 2, 3, 4, 5, 6, 7, 8 };
const uint8_t kSec2[] = { 9, 10, 11, 12, 13, 14, 15, 16, 17, 18 };
const uint8_t kSec3[] = { 19, 20, 21, 22 };
const uint8_t kSec4[] = { 23, 24, 25, 26, 27 };
const uint8_t kSec5[] = { 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38 };
const uint8_t kSec6[] = { 39, 40, 41, 42, 43, 44, 45, 46, 47 };
const uint8_t kSec7[] = { 48, 49, 50, 51 };

const SectionDef kSections[] = {
    { "Channel", "CHAN", kSec0, sizeof(kSec0) },
    { "Pulse", "PULSE", kSec1, sizeof(kSec1) },
    { "Wave", "WAVE", kSec2, sizeof(kSec2) },
    { "Noise", "NOISE", kSec3, sizeof(kSec3) },
    { "Envelope", "ENV", kSec4, sizeof(kSec4) },
    { "Drums", "DRUMS", kSec5, sizeof(kSec5) },
    { "Chip Tricks", "CHIP", kSec6, sizeof(kSec6) },
    { "Controllers", "CTRL", kSec7, sizeof(kSec7) },
};

const MacroDef kMacros[] = {
    { "Release", false, 1, { { 26, 0.3f } } },
    { "Sweep Time", false, 1, { { 3, 0.3f } } },
    { "User 1", false, 1, { { 10, 0.3f } } },
    { "Shift", false, 1, { { 20, 0.3f } } },
    { "Init", false, 1, { { 23, 0.3f } } },
    { "Kick Tune", true, 1, { { 28, 0.5f } } },
};

} // namespace

const EngineDef kHandDef = {
    "HANDTYPE",
    0x87,
    kParams,
    ot::audio::hand::kParamCount,
    kSections,
    static_cast<int>(sizeof(kSections) / sizeof(kSections[0])),
    kMacros,
    6,
    51,
    kMaxVoicesPerInstrument,
    &ot::audio::hand::engine,
    false,
};

} // namespace polysynth::open
