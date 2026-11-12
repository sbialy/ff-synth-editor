// D-Type parameter metadata for the open PolySynth shim on MK66. D-Type is an engine from OpenTracker 3.x (module opentracker-synths/modules/dtype,
// MIT, synth-open/ot-synths/dtype). The ranges, defaults, labels, value formats, enum names and the section split follow that module's
// descriptor (modules/dtype/src/dtype_desc.cpp, MIT, Copyright (c) 2026 Marcin Spoczynski, see licenses/LICENSE-OpenTracker-synths-MIT.txt).
// Edit curves and the default macros are this shim's choice (the same rules as the browser editor engine host).
//
// OpenTracker engine id 0x82 (stored as 0xA2 here: PHZ owns 0x82), see engine_list.h.
#include "open_engine.h"

#include "PolySynth/config.h"
#include "ot-synths/dtype/dtype.h"

namespace polysynth::open
{
namespace
{
using F = Fmt;
using C = CurveKind;

const char* const kEnum0[] = { "Lo", "32'", "16'", "8'", "4'", "2'" };
const char* const kEnum1[] = { "Tri", "Tri-Saw", "Saw", "Square", "Wide", "Narrow" };
const char* const kEnum2[] = { "Tri", "Rev Saw", "Saw", "Square", "Wide", "Narrow" };
const char* const kEnum3[] = { "White", "Pink" };
const char* const kEnum4[] = { "Off", "1/3", "2/3", "Full" };
const char* const kEnum5[] = { "Always", "Overlap", "Legato", "Legato Overlap" };

const ParamDef kParams[ot::audio::dtype::kParamCount] = {
    { "Range", 3.0f, 0.0f, 5.0f, F::kEnum, C::kLinear, kEnum0 },
    { "Wave", 2.0f, 0.0f, 5.0f, F::kEnum, C::kLinear, kEnum1 },
    { "Level", 0.8f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Range", 3.0f, 0.0f, 5.0f, F::kEnum, C::kLinear, kEnum0 },
    { "Wave", 2.0f, 0.0f, 5.0f, F::kEnum, C::kLinear, kEnum1 },
    { "Tune", 0.0f, -24.0f, 24.0f, F::kSemi, C::kLinear, nullptr },
    { "Fine", 7.0f, -100.0f, 100.0f, F::kCents, C::kLinear, nullptr },
    { "Level", 0.6f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Range", 0.0f, 0.0f, 5.0f, F::kEnum, C::kLinear, kEnum0 },
    { "Wave", 0.0f, 0.0f, 5.0f, F::kEnum, C::kLinear, kEnum2 },
    { "Tune", 0.0f, -24.0f, 24.0f, F::kSemi, C::kLinear, nullptr },
    { "Fine", 0.0f, -100.0f, 100.0f, F::kCents, C::kLinear, nullptr },
    { "Level", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Keyboard", 0.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "Noise", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Colour", 0.0f, 0.0f, 1.0f, F::kEnum, C::kLinear, kEnum3 },
    { "Feedback", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Cutoff", 1200.0f, 20.0f, 20000.0f, F::kHz, C::kExp, nullptr },
    { "Emphasis", 0.3f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Contour", 0.4f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Key Track", 2.0f, 0.0f, 3.0f, F::kEnum, C::kLinear, kEnum4 },
    { "Attack", 0.005f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Decay", 0.5f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Sustain", 0.3f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Attack", 0.005f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Decay", 0.6f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Sustain", 0.8f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Mod Mix", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Osc Mod", 0.15f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Filter Mod", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Wheel", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Glide Mode", 0.0f, 0.0f, 3.0f, F::kEnum, C::kLinear, kEnum5 },
    { "Glide Time", 0.0f, 0.0f, 3.0f, F::kSec, C::kSteep, nullptr },
    { "Decay Sw", 1.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "Volume", 1.0f, 0.0f, 2.0f, F::kPct, C::kLinear, nullptr },
};

const uint8_t kSec0[] = { 0, 1, 2 };
const uint8_t kSec1[] = { 3, 4, 5, 6, 7 };
const uint8_t kSec2[] = { 8, 9, 10, 11, 12, 13 };
const uint8_t kSec3[] = { 14, 15, 16 };
const uint8_t kSec4[] = { 17, 18, 19, 20 };
const uint8_t kSec5[] = { 21, 22, 23 };
const uint8_t kSec6[] = { 24, 25, 26 };
const uint8_t kSec7[] = { 27, 28, 29, 30 };
const uint8_t kSec8[] = { 31, 32, 33, 34 };

const SectionDef kSections[] = {
    { "Oscillator 1", "VCO1", kSec0, sizeof(kSec0) },
    { "Oscillator 2", "VCO2", kSec1, sizeof(kSec1) },
    { "Oscillator 3", "VCO3", kSec2, sizeof(kSec2) },
    { "Mixer", "MIX", kSec3, sizeof(kSec3) },
    { "Filter", "VCF", kSec4, sizeof(kSec4) },
    { "Filter Contour", "F.Env", kSec5, sizeof(kSec5) },
    { "Loudness Contour", "L.Env", kSec6, sizeof(kSec6) },
    { "Modulation", "MOD", kSec7, sizeof(kSec7) },
    { "Controllers", "CTRL", kSec8, sizeof(kSec8) },
};

const MacroDef kMacros[] = {
    { "Cutoff", false, 1, { { 17, 0.4f } } },
    { "F.Env Attack", false, 1, { { 21, 0.3f } } },
    { "F.Env Decay", false, 1, { { 22, 0.3f } } },
    { "Feedback", false, 1, { { 16, 0.5f } } },
    { "VCO1 Level", false, 1, { { 2, 0.3f } } },
    { "VCO2 Tune", true, 1, { { 5, 0.5f } } },
};

} // namespace

const EngineDef kDtypeDef = {
    "DTYPE",
    0xA2,
    kParams,
    ot::audio::dtype::kParamCount,
    kSections,
    static_cast<int>(sizeof(kSections) / sizeof(kSections[0])),
    kMacros,
    6,
    34,
    kMaxVoicesPerInstrument,
    &ot::audio::dtype::engine,
    false,
};

} // namespace polysynth::open
