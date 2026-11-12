// CS-Type parameter metadata for the open PolySynth shim on MK66. CS-Type is an engine from OpenTracker 3.x (module opentracker-synths/modules/cstype,
// MIT, synth-open/ot-synths/cstype). The ranges, defaults, labels, value formats, enum names and the section split follow that module's
// descriptor (modules/cstype/src/cstype_desc.cpp, MIT, Copyright (c) 2026 Marcin Spoczynski, see licenses/LICENSE-OpenTracker-synths-MIT.txt).
// Edit curves and the default macros are this shim's choice (the same rules as the browser editor engine host).
//
// OpenTracker engine id 0x83, see engine_list.h.
#include "open_engine.h"

#include "PolySynth/config.h"
#include "ot-synths/cstype/cstype.h"

namespace polysynth::open
{
namespace
{
using F = Fmt;
using C = CurveKind;

const char* const kEnum0[] = { "16'", "8'", "4'", "2'" };
const char* const kEnum1[] = { "Sine", "Saw", "Ramp", "Square", "Noise" };
const char* const kEnum2[] = { "Always", "Overlap", "Legato", "Legato Overlap" };

const ParamDef kParams[ot::audio::cstype::kParamCount] = {
    { "Feet", 1.0f, 0.0f, 3.0f, F::kEnum, C::kLinear, kEnum0 },
    { "Saw", 1.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "Pulse", 0.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "PW", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "PWM", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "PWM Speed", 4.0f, 0.1f, 20.0f, F::kLfoHz, C::kExp, nullptr },
    { "Sine", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Noise", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "HPF", 20.0f, 20.0f, 20000.0f, F::kHz, C::kExp, nullptr },
    { "HPF Res", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "LPF", 2000.0f, 20.0f, 20000.0f, F::kHz, C::kExp, nullptr },
    { "LPF Res", 0.2f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Initial Lvl", 0.0f, -1.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Attack Lvl", 0.5f, -1.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "F Attack", 0.03f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "F Decay", 0.6f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "F Release", 0.4f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Attack", 0.01f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Decay", 0.6f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Sustain", 0.8f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Release", 0.4f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Level", 0.8f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Feet", 1.0f, 0.0f, 3.0f, F::kEnum, C::kLinear, kEnum0 },
    { "Saw", 1.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "Pulse", 0.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "PW", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "PWM", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "PWM Speed", 4.0f, 0.1f, 20.0f, F::kLfoHz, C::kExp, nullptr },
    { "Sine", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Noise", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "HPF", 20.0f, 20.0f, 20000.0f, F::kHz, C::kExp, nullptr },
    { "HPF Res", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "LPF", 1500.0f, 20.0f, 20000.0f, F::kHz, C::kExp, nullptr },
    { "LPF Res", 0.2f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Initial Lvl", 0.0f, -1.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Attack Lvl", 0.5f, -1.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "F Attack", 0.1f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "F Decay", 0.6f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "F Release", 0.4f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Attack", 0.1f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Decay", 0.6f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Sustain", 0.8f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Release", 0.4f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Level", 0.6f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Brilliance", 0.0f, -1.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Resonance", 0.0f, -1.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "II Detune", 6.0f, -50.0f, 50.0f, F::kCents, C::kLinear, nullptr },
    { "RM Depth", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "RM Speed", 100.0f, 0.1f, 2000.0f, F::kLfoHz, C::kExp, nullptr },
    { "RM Sweep", 0.0f, -1.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "RM Decay", 1.0f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Function", 0.0f, 0.0f, 4.0f, F::kEnum, C::kLinear, kEnum1 },
    { "Speed", 5.0f, 0.1f, 20.0f, F::kLfoHz, C::kExp, nullptr },
    { "-> VCO", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "-> VCF", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "-> VCA", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Touch", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Init->Bril", 0.3f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Init->Level", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "After->VCO", 0.5f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "After->VCF", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "After->VCA", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Ribbon", 0.0f, -1.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Ribbon Rng", 2.0f, 0.0f, 24.0f, F::kSemi, C::kLinear, nullptr },
    { "Glide Mode", 0.0f, 0.0f, 3.0f, F::kEnum, C::kLinear, kEnum2 },
    { "Glide Time", 0.0f, 0.0f, 3.0f, F::kSec, C::kSteep, nullptr },
    { "Volume", 1.0f, 0.0f, 2.0f, F::kPct, C::kLinear, nullptr },
};

const uint8_t kSec0[] = { 0, 1, 2, 3, 4, 5, 6, 7 };
const uint8_t kSec1[] = { 8, 9, 10, 11, 12, 13, 14, 15, 16 };
const uint8_t kSec2[] = { 17, 18, 19, 20, 21 };
const uint8_t kSec3[] = { 22, 23, 24, 25, 26, 27, 28, 29 };
const uint8_t kSec4[] = { 30, 31, 32, 33, 34, 35, 36, 37, 38 };
const uint8_t kSec5[] = { 39, 40, 41, 42, 43 };
const uint8_t kSec6[] = { 44, 45, 46, 47, 48, 49, 50 };
const uint8_t kSec7[] = { 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61 };
const uint8_t kSec8[] = { 62, 63, 64, 65, 66 };

const SectionDef kSections[] = {
    { "Layer I Oscillator", "I.OSC", kSec0, sizeof(kSec0) },
    { "Layer I Filters", "I.VCF", kSec1, sizeof(kSec1) },
    { "Layer I Amplifier", "I.VCA", kSec2, sizeof(kSec2) },
    { "Layer II Oscillator", "II.OSC", kSec3, sizeof(kSec3) },
    { "Layer II Filters", "II.VCF", kSec4, sizeof(kSec4) },
    { "Layer II Amplifier", "II.VCA", kSec5, sizeof(kSec5) },
    { "Mix and Ring Mod", "MIX", kSec6, sizeof(kSec6) },
    { "Modulation and Touch", "MOD", kSec7, sizeof(kSec7) },
    { "Controllers", "CTRL", kSec8, sizeof(kSec8) },
};

const MacroDef kMacros[] = {
    { "Resonance", false, 1, { { 45, 1.0f } } },
    { "I.VCA Attack", false, 1, { { 17, 0.3f } } },
    { "I.VCA Release", false, 1, { { 20, 0.3f } } },
    { "I.VCA Decay", false, 1, { { 18, 0.3f } } },
    { "Brilliance", false, 1, { { 44, 0.5f } } },
    { "I.OSC Pulse Width", true, 1, { { 3, 0.5f } } },
};

} // namespace

const EngineDef kCstypeDef = {
    "CSTYPE",
    0x83,
    kParams,
    ot::audio::cstype::kParamCount,
    kSections,
    static_cast<int>(sizeof(kSections) / sizeof(kSections[0])),
    kMacros,
    6,
    66,
    kMaxVoicesPerInstrument,
    &ot::audio::cstype::engine,
    false,
};

} // namespace polysynth::open
