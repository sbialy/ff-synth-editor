// 8-Type parameter metadata for the open PolySynth shim on MK66. 8-Type is an engine from OpenTracker 3.x (module opentracker-synths/modules/eight,
// MIT, synth-open/ot-synths/eight). The ranges, defaults, labels, value formats, enum names and the section split follow that module's
// descriptor (modules/eight/src/eight_desc.cpp, MIT, Copyright (c) 2026 Marcin Spoczynski, see licenses/LICENSE-OpenTracker-synths-MIT.txt).
// Edit curves and the default macros are this shim's choice (the same rules as the browser editor engine host).
//
// OpenTracker engine id 0x86, see engine_list.h.
#include "open_engine.h"

#include "PolySynth/config.h"
#include "ot-synths/eight/eight.h"

namespace polysynth::open
{
namespace
{
using F = Fmt;
using C = CurveKind;

const char* const kEnum0[] = { "Tri", "Saw", "Pulse", "Noise", "Tri+Pulse", "Saw+Pulse", "Tri+Saw", "Off" };
const char* const kEnum1[] = { "LP", "BP", "HP", "LP+BP", "Notch", "BP+HP", "All" };
const char* const kEnum2[] = { "Bright", "Dark" };
const char* const kEnum3[] = { "2 ms", "8 ms", "13 ms", "22 ms", "35 ms", "58 ms", "94 ms", "155 ms", "253 ms", "414 ms", "679 ms", "1.1 s", "1.8 s", "3.0 s", "4.9 s", "8 s" };
const char* const kEnum4[] = { "6 ms", "24 ms", "39 ms", "64 ms", "106 ms", "173 ms", "283 ms", "463 ms", "759 ms", "1.2 s", "2.0 s", "3.3 s", "5.5 s", "8.9 s", "15 s", "24 s" };
const char* const kEnum5[] = { "Always", "Overlap", "Legato", "Legato Overlap" };
const char* const kEnum6[] = { "Off", "Oct", "Maj", "Min", "Sus4", "Dom7", "Maj7", "Min7", "Dim", "Aug", "Pow5", "Custom" };
const char* const kEnum7[] = { "50 Hz", "60 Hz", "100 Hz", "120 Hz", "1/32", "1/48", "1/64", "1/96", "1/128" };

const ParamDef kParams[ot::audio::eight::kParamCount] = {
    { "Wave", 2.0f, 0.0f, 7.0f, F::kEnum, C::kLinear, kEnum0 },
    { "PW", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "PWM Depth", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Level", 0.8f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Semi", 0.0f, -24.0f, 24.0f, F::kSemi, C::kLinear, nullptr },
    { "Fine", 0.0f, -100.0f, 100.0f, F::kCents, C::kLinear, nullptr },
    { "Ring", 0.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "Sync", 0.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "Filt", 1.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "Clean", 0.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "Wave", 7.0f, 0.0f, 7.0f, F::kEnum, C::kLinear, kEnum0 },
    { "PW", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "PWM Depth", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Level", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Semi", 0.0f, -24.0f, 24.0f, F::kSemi, C::kLinear, nullptr },
    { "Fine", 0.0f, -100.0f, 100.0f, F::kCents, C::kLinear, nullptr },
    { "Ring", 0.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "Sync", 0.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "Filt", 1.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "Clean", 0.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "Wave", 7.0f, 0.0f, 7.0f, F::kEnum, C::kLinear, kEnum0 },
    { "PW", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "PWM Depth", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Level", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Semi", 0.0f, -24.0f, 24.0f, F::kSemi, C::kLinear, nullptr },
    { "Fine", 0.0f, -100.0f, 100.0f, F::kCents, C::kLinear, nullptr },
    { "Ring", 0.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "Sync", 0.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "Filt", 1.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "Clean", 0.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "Cutoff", 1200.0f, 30.0f, 12000.0f, F::kHz, C::kExp, nullptr },
    { "Resonance", 2.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "Mode", 0.0f, 0.0f, 6.0f, F::kEnum, C::kLinear, kEnum1 },
    { "Curve", 0.0f, 0.0f, 1.0f, F::kEnum, C::kLinear, kEnum2 },
    { "Dirt", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Key Track", 0.5f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Env Amt", 0.3f, -1.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Env Decay", 0.25f, 0.01f, 5.0f, F::kSec, C::kSteep, nullptr },
    { "Attack", 1.0f, 0.0f, 15.0f, F::kEnum, C::kLinear, kEnum3 },
    { "Decay", 6.0f, 0.0f, 15.0f, F::kEnum, C::kLinear, kEnum4 },
    { "Sustain", 10.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "Release", 5.0f, 0.0f, 15.0f, F::kEnum, C::kLinear, kEnum4 },
    { "PWM Rate", 0.5f, 0.05f, 20.0f, F::kLfoHz, C::kExp, nullptr },
    { "Grit", 12.0f, 4.0f, 12.0f, F::kInt, C::kLinear, nullptr },
    { "Glide Mode", 0.0f, 0.0f, 3.0f, F::kEnum, C::kLinear, kEnum5 },
    { "Glide Time", 0.0f, 0.0f, 3.0f, F::kSec, C::kSteep, nullptr },
    { "Volume", 1.0f, 0.0f, 2.0f, F::kPct, C::kLinear, nullptr },
    { "Arp Mode", 0.0f, 0.0f, 11.0f, F::kEnum, C::kLinear, kEnum6 },
    { "Arp Rate", 1.0f, 0.0f, 8.0f, F::kEnum, C::kLinear, kEnum7 },
    { "Arp Note 2", 4.0f, 0.0f, 24.0f, F::kSemi, C::kLinear, nullptr },
    { "Arp Note 3", 7.0f, 0.0f, 24.0f, F::kSemi, C::kLinear, nullptr },
    { "Vib Rate", 5.0f, 0.5f, 15.0f, F::kLfoHz, C::kExp, nullptr },
    { "Vib Depth", 0.0f, 0.0f, 2.0f, F::kSemi, C::kLinear, nullptr },
    { "Vib Delay", 0.2f, 0.0f, 1.0f, F::kSec, C::kSteep, nullptr },
    { "Slide Start", 0.0f, -24.0f, 24.0f, F::kSemi, C::kLinear, nullptr },
    { "Slide Time", 0.05f, 0.0f, 1.0f, F::kSec, C::kSteep, nullptr },
};

const uint8_t kSec0[] = { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9 };
const uint8_t kSec1[] = { 10, 11, 12, 13, 14, 15, 16, 17, 18, 19 };
const uint8_t kSec2[] = { 20, 21, 22, 23, 24, 25, 26, 27, 28, 29 };
const uint8_t kSec3[] = { 30, 31, 32, 33, 34, 35, 36, 37 };
const uint8_t kSec4[] = { 38, 39, 40, 41 };
const uint8_t kSec5[] = { 42, 43, 44, 45, 46 };
const uint8_t kSec6[] = { 47, 48, 49, 50, 51, 52, 53, 54, 55 };

const SectionDef kSections[] = {
    { "Oscillator 1", "OSC1", kSec0, sizeof(kSec0) },
    { "Oscillator 2", "OSC2", kSec1, sizeof(kSec1) },
    { "Oscillator 3", "OSC3", kSec2, sizeof(kSec2) },
    { "Filter", "FILTER", kSec3, sizeof(kSec3) },
    { "Envelope", "ENV", kSec4, sizeof(kSec4) },
    { "Voice", "VOICE", kSec5, sizeof(kSec5) },
    { "Chip Tricks", "CHIP", kSec6, sizeof(kSec6) },
};

const MacroDef kMacros[] = {
    { "Cutoff", false, 1, { { 30, 0.4f } } },
    { "Resonance", false, 1, { { 31, 1.0f } } },
    { "Attack", false, 1, { { 38, 0.3f } } },
    { "Release", false, 1, { { 41, 0.3f } } },
    { "Decay", false, 1, { { 39, 0.3f } } },
    { "OSC1 Pulse Width", true, 1, { { 1, 0.5f } } },
};

} // namespace

const EngineDef kEightDef = {
    "8TYPE",
    0x86,
    kParams,
    ot::audio::eight::kParamCount,
    kSections,
    static_cast<int>(sizeof(kSections) / sizeof(kSections[0])),
    kMacros,
    6,
    46,
    kMaxVoicesPerInstrument,
    &ot::audio::eight::engine,
    false,
};

} // namespace polysynth::open
