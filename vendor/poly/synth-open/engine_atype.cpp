// A-Type parameter metadata for the open PolySynth shim on MK66. A-Type is an engine from OpenTracker 3.x (module opentracker-synths/modules/atype,
// MIT, synth-open/ot-synths/atype). The ranges, defaults, labels, value formats, enum names and the section split follow that module's
// descriptor (modules/atype/src/atype_desc.cpp, MIT, Copyright (c) 2026 Marcin Spoczynski, see licenses/LICENSE-OpenTracker-synths-MIT.txt).
// Edit curves and the default macros are this shim's choice (the same rules as the browser editor engine host).
//
// OpenTracker engine id 0x84, see engine_list.h.
#include "open_engine.h"

#include "PolySynth/config.h"
#include "ot-synths/atype/atype.h"

namespace polysynth::open
{
namespace
{
using F = Fmt;
using C = CurveKind;

const char* const kEnum0[] = { "32'", "16'", "8'", "4'" };
const char* const kEnum1[] = { "Saw", "Pulse" };
const char* const kEnum2[] = { "LFO", "S&H", "ADSR" };
const char* const kEnum3[] = { "Noise", "Ring" };
const char* const kEnum4[] = { "Noise", "VCO1", "VCO2", "Mix" };
const char* const kEnum5[] = { "Rate", "Key" };
const char* const kEnum6[] = { "4-pole", "2-pole" };
const char* const kEnum7[] = { "ADSR", "AR" };
const char* const kEnum8[] = { "Sine", "Tri", "Square", "Saw" };
const char* const kEnum9[] = { "Mono", "Duo" };
const char* const kEnum10[] = { "Last", "Low", "High" };
const char* const kEnum11[] = { "Always", "Overlap", "Legato", "Legato Overlap" };

const ParamDef kParams[ot::audio::atype::kParamCount] = {
    { "Range", 2.0f, 0.0f, 3.0f, F::kEnum, C::kLinear, kEnum0 },
    { "Fine", 0.0f, -100.0f, 100.0f, F::kCents, C::kLinear, nullptr },
    { "Wave", 0.0f, 0.0f, 1.0f, F::kEnum, C::kLinear, kEnum1 },
    { "PW", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "PWM", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "LFO Mod", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Range", 2.0f, 0.0f, 3.0f, F::kEnum, C::kLinear, kEnum0 },
    { "Tune", 0.0f, -24.0f, 24.0f, F::kSemi, C::kLinear, nullptr },
    { "Fine", 7.0f, -100.0f, 100.0f, F::kCents, C::kLinear, nullptr },
    { "Wave", 0.0f, 0.0f, 1.0f, F::kEnum, C::kLinear, kEnum1 },
    { "PW", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "PWM", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Mod", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Mod Src", 0.0f, 0.0f, 2.0f, F::kEnum, C::kLinear, kEnum2 },
    { "Sync", 0.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "VCO1", 0.8f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "VCO2", 0.6f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Source", 0.0f, 0.0f, 1.0f, F::kEnum, C::kLinear, kEnum3 },
    { "Source Lvl", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Input", 0.0f, 0.0f, 3.0f, F::kEnum, C::kLinear, kEnum4 },
    { "Clock", 0.0f, 0.0f, 1.0f, F::kEnum, C::kLinear, kEnum5 },
    { "Rate", 4.0f, 0.1f, 50.0f, F::kLfoHz, C::kExp, nullptr },
    { "Lag", 0.0f, 0.0f, 1.0f, F::kSec, C::kSteep, nullptr },
    { "Cutoff", 1500.0f, 20.0f, 20000.0f, F::kHz, C::kExp, nullptr },
    { "Resonance", 0.2f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Mode", 0.0f, 0.0f, 1.0f, F::kEnum, C::kLinear, kEnum6 },
    { "Key Track", 0.66f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Env Amt", 0.4f, -1.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Env Src", 0.0f, 0.0f, 1.0f, F::kEnum, C::kLinear, kEnum7 },
    { "LFO Amt", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "S&H Amt", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "HPF", 20.0f, 20.0f, 20000.0f, F::kHz, C::kExp, nullptr },
    { "VCA Env", 0.0f, 0.0f, 1.0f, F::kEnum, C::kLinear, kEnum7 },
    { "Attack", 0.005f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Decay", 0.4f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Sustain", 0.6f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Release", 0.3f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "AR Attack", 0.01f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "AR Release", 0.5f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Rate", 5.0f, 0.1f, 30.0f, F::kLfoHz, C::kExp, nullptr },
    { "Shape", 0.0f, 0.0f, 3.0f, F::kEnum, C::kLinear, kEnum8 },
    { "Keyboard", 0.0f, 0.0f, 1.0f, F::kEnum, C::kLinear, kEnum9 },
    { "Priority", 0.0f, 0.0f, 2.0f, F::kEnum, C::kLinear, kEnum10 },
    { "Glide Mode", 0.0f, 0.0f, 3.0f, F::kEnum, C::kLinear, kEnum11 },
    { "Glide Time", 0.0f, 0.0f, 3.0f, F::kSec, C::kSteep, nullptr },
    { "Volume", 1.0f, 0.0f, 2.0f, F::kPct, C::kLinear, nullptr },
};

const uint8_t kSec0[] = { 0, 1, 2, 3, 4, 5 };
const uint8_t kSec1[] = { 6, 7, 8, 9, 10, 11, 12, 13, 14 };
const uint8_t kSec2[] = { 15, 16, 17, 18 };
const uint8_t kSec3[] = { 19, 20, 21, 22 };
const uint8_t kSec4[] = { 23, 24, 25, 26, 27, 28, 29, 30, 31 };
const uint8_t kSec5[] = { 32, 33, 34, 35, 36, 37, 38 };
const uint8_t kSec6[] = { 39, 40 };
const uint8_t kSec7[] = { 41, 42, 43, 44, 45 };

const SectionDef kSections[] = {
    { "Oscillator 1", "VCO1", kSec0, sizeof(kSec0) },
    { "Oscillator 2", "VCO2", kSec1, sizeof(kSec1) },
    { "Mixer", "MIX", kSec2, sizeof(kSec2) },
    { "Sample & Hold", "S&H", kSec3, sizeof(kSec3) },
    { "Filter", "VCF", kSec4, sizeof(kSec4) },
    { "Envelopes", "ENV", kSec5, sizeof(kSec5) },
    { "LFO", "LFO", kSec6, sizeof(kSec6) },
    { "Controllers", "CTRL", kSec7, sizeof(kSec7) },
};

const MacroDef kMacros[] = {
    { "Cutoff", false, 1, { { 23, 0.4f } } },
    { "Resonance", false, 1, { { 24, 1.0f } } },
    { "Attack", false, 1, { { 33, 0.3f } } },
    { "Release", false, 1, { { 36, 0.3f } } },
    { "Decay", false, 1, { { 34, 0.3f } } },
    { "VCO1 Pulse Width", true, 1, { { 3, 0.5f } } },
};

} // namespace

const EngineDef kAtypeDef = {
    "ATYPE",
    0x84,
    kParams,
    ot::audio::atype::kParamCount,
    kSections,
    static_cast<int>(sizeof(kSections) / sizeof(kSections[0])),
    kMacros,
    6,
    45,
    kMaxVoicesPerInstrument,
    &ot::audio::atype::engine,
    false,
    nullptr, // poly-editor overlay: no plugin instance (EngineDef::inst), so the two fields below can follow
    kFlagNotePriority, // poly-editor overlay: held notes decide which note sounds at Poly 1 (Priority parameter), see open_synth.cpp
    ot::audio::atype::kPriority,
};

} // namespace polysynth::open
