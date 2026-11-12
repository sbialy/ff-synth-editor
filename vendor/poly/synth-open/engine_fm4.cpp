// FM4 parameter metadata for the open PolySynth shim on MK66. FM4 is an engine from OpenTracker 3.x (module opentracker-synths/modules/fm4,
// MIT, synth-open/ot-synths/fm4). The ranges, defaults, labels, value formats, enum names and the section split follow that module's
// descriptor (modules/fm4/src/fm4_desc.cpp, MIT, Copyright (c) 2026 Marcin Spoczynski, see licenses/LICENSE-OpenTracker-synths-MIT.txt).
// Edit curves and the default macros are this shim's choice (the same rules as the browser editor engine host).
//
// OpenTracker engine id 0x80, see engine_list.h.
#include "open_engine.h"

#include "PolySynth/config.h"
#include "ot-synths/fm4/fm4.h"

namespace polysynth::open
{
namespace
{
using F = Fmt;
using C = CurveKind;

const char* const kEnum0[] = { "1>2>3>4", "(1+2)>3>4", "(1+2>3)>4", "(1>2+3)>4", "1>2 + 3>4", "1>(2,3,4)", "1>2 + 3 + 4", "1 + 2 + 3 + 4" };
const char* const kEnum1[] = { "0.5", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15" };

const ParamDef kParams[ot::audio::fm4::kParamCount] = {
    { "Algorithm", 0.0f, 0.0f, 7.0f, F::kEnum, C::kLinear, kEnum0 },
    { "Feedback", 0.0f, 0.0f, 7.0f, F::kInt, C::kLinear, nullptr },
    { "LFO Rate", 5.0f, 0.0f, 20.0f, F::kLfoHz, C::kExp, nullptr },
    { "Vibrato", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Tremolo", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Glide Time", 0.0f, 0.0f, 3.0f, F::kSec, C::kSteep, nullptr },
    { "Volume", 1.0f, 0.0f, 2.0f, F::kPct, C::kLinear, nullptr },
    { "Mult", 1.0f, 0.0f, 15.0f, F::kEnum, C::kLinear, kEnum1 },
    { "Detune", 0.0f, -3.0f, 3.0f, F::kInt, C::kLinear, nullptr },
    { "Level", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Attack", 0.0f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Decay", 0.5f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Sustain", 1.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Sus Rate", 0.0f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Release", 0.3f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Tremolo", 0.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "Mult", 1.0f, 0.0f, 15.0f, F::kEnum, C::kLinear, kEnum1 },
    { "Detune", 0.0f, -3.0f, 3.0f, F::kInt, C::kLinear, nullptr },
    { "Level", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Attack", 0.0f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Decay", 0.5f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Sustain", 1.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Sus Rate", 0.0f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Release", 0.3f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Tremolo", 0.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "Mult", 1.0f, 0.0f, 15.0f, F::kEnum, C::kLinear, kEnum1 },
    { "Detune", 0.0f, -3.0f, 3.0f, F::kInt, C::kLinear, nullptr },
    { "Level", 0.25f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Attack", 0.0f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Decay", 0.5f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Sustain", 0.6f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Sus Rate", 0.0f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Release", 0.3f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Tremolo", 0.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "Mult", 1.0f, 0.0f, 15.0f, F::kEnum, C::kLinear, kEnum1 },
    { "Detune", 0.0f, -3.0f, 3.0f, F::kInt, C::kLinear, nullptr },
    { "Level", 1.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Attack", 0.0f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Decay", 0.5f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Sustain", 1.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Sus Rate", 0.0f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Release", 0.3f, 0.0f, 10.0f, F::kSec, C::kSteep, nullptr },
    { "Tremolo", 0.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
};

const uint8_t kSec0[] = { 0, 1, 6, 5 };
const uint8_t kSec1[] = { 2, 3, 4 };
const uint8_t kSec2[] = { 7, 8, 9, 10, 11, 12, 13, 14, 15 };
const uint8_t kSec3[] = { 16, 17, 18, 19, 20, 21, 22, 23, 24 };
const uint8_t kSec4[] = { 25, 26, 27, 28, 29, 30, 31, 32, 33 };
const uint8_t kSec5[] = { 34, 35, 36, 37, 38, 39, 40, 41, 42 };

const SectionDef kSections[] = {
    { "Global", "Global", kSec0, sizeof(kSec0) },
    { "LFO", "LFO", kSec1, sizeof(kSec1) },
    { "Operator 1", "Op 1", kSec2, sizeof(kSec2) },
    { "Operator 2", "Op 2", kSec3, sizeof(kSec3) },
    { "Operator 3", "Op 3", kSec4, sizeof(kSec4) },
    { "Operator 4", "Op 4", kSec5, sizeof(kSec5) },
};

const MacroDef kMacros[] = {
    { "Op 1 Attack", false, 1, { { 10, 0.3f } } },
    { "Op 1 Release", false, 1, { { 14, 0.3f } } },
    { "Op 1 Decay", false, 1, { { 11, 0.3f } } },
    { "LFO Rate", false, 1, { { 2, 0.3f } } },
    { "Op 1 Detune", false, 1, { { 8, 0.3f } } },
    { "Feedback", false, 1, { { 1, 0.5f } } },
};

} // namespace

const EngineDef kFm4Def = {
    "FM4",
    0x80,
    kParams,
    ot::audio::fm4::kParamCount,
    kSections,
    static_cast<int>(sizeof(kSections) / sizeof(kSections[0])),
    kMacros,
    6,
    6,
    kMaxVoicesPerInstrument,
    &ot::audio::fm4::engine,
    false,
};

} // namespace polysynth::open
