// Arc-Type parameter metadata for the open PolySynth shim on MK66. Arc-Type is an engine from OpenTracker 3.x (module opentracker-synths/modules/arc,
// MIT, synth-open/ot-synths/arc). The ranges, defaults, labels, value formats, enum names and the section split follow that module's
// descriptor (modules/arc/src/arc_desc.cpp, MIT, Copyright (c) 2026 Marcin Spoczynski, see licenses/LICENSE-OpenTracker-synths-MIT.txt).
// Edit curves and the default macros are this shim's choice (the same rules as the browser editor engine host).
//
// OpenTracker engine id 0x89, see engine_list.h.
#include "open_engine.h"

#include "PolySynth/config.h"
#include "ot-synths/arc/arc.h"

namespace polysynth::open
{
namespace
{
using F = Fmt;
using C = CurveKind;

const char* const kEnum0[] = { "1>2>3>4", "(1+2)>3>4", "(1+2>3)>4", "(1>2+3)>4", "1>2, 3>4", "1>(2,3,4)", "1>2, 3, 4", "1, 2, 3, 4" };
const char* const kEnum1[] = { "Off", "9-bit", "Ladder" };
const char* const kEnum2[] = { "Always", "Overlap", "Legato", "Legato Overlap" };
const char* const kEnum3[] = { "Off", "4 Hz", "5.5 Hz", "7 Hz", "9 Hz", "12 Hz", "20 Hz", "40 Hz", "72 Hz" };
const char* const kEnum4[] = { "0.5", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15" };
const char* const kEnum5[] = { "Off", "Repeat", "Mirror", "Hold Inv", "Repeat Inv" };
const char* const kEnum6[] = { "Off", "Square", "Noise" };
const char* const kEnum7[] = { "Off", "Oct", "Maj", "Min", "Sus4", "Dom7", "Maj7", "Min7", "Dim", "Aug", "Pow5", "Custom" };
const char* const kEnum8[] = { "50 Hz", "60 Hz", "100 Hz", "120 Hz", "1/32", "1/48", "1/64", "1/96", "1/128" };

const ParamDef kParams[ot::audio::arc::kParamCount] = {
    { "Algorithm", 0.0f, 0.0f, 7.0f, F::kEnum, C::kLinear, kEnum0 },
    { "Feedback", 0.0f, 0.0f, 7.0f, F::kInt, C::kLinear, nullptr },
    { "DAC", 1.0f, 0.0f, 2.0f, F::kEnum, C::kLinear, kEnum1 },
    { "Glide Mode", 0.0f, 0.0f, 3.0f, F::kEnum, C::kLinear, kEnum2 },
    { "Glide Time", 0.0f, 0.0f, 3.0f, F::kSec, C::kSteep, nullptr },
    { "Volume", 1.0f, 0.0f, 2.0f, F::kPct, C::kLinear, nullptr },
    { "LFO Rate", 0.0f, 0.0f, 8.0f, F::kEnum, C::kLinear, kEnum3 },
    { "PMS", 0.0f, 0.0f, 7.0f, F::kInt, C::kLinear, nullptr },
    { "MUL", 1.0f, 0.0f, 15.0f, F::kEnum, C::kLinear, kEnum4 },
    { "DT", 0.0f, -3.0f, 3.0f, F::kInt, C::kLinear, nullptr },
    { "Level", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "RS", 1.0f, 0.0f, 3.0f, F::kInt, C::kLinear, nullptr },
    { "AR", 31.0f, 0.0f, 31.0f, F::kInt, C::kLinear, nullptr },
    { "D1R", 8.0f, 0.0f, 31.0f, F::kInt, C::kLinear, nullptr },
    { "D1L", 4.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "D2R", 0.0f, 0.0f, 31.0f, F::kInt, C::kLinear, nullptr },
    { "RR", 6.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "Loop", 0.0f, 0.0f, 4.0f, F::kEnum, C::kLinear, kEnum5 },
    { "AMS", 0.0f, 0.0f, 3.0f, F::kInt, C::kLinear, nullptr },
    { "MUL", 1.0f, 0.0f, 15.0f, F::kEnum, C::kLinear, kEnum4 },
    { "DT", 0.0f, -3.0f, 3.0f, F::kInt, C::kLinear, nullptr },
    { "Level", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "RS", 1.0f, 0.0f, 3.0f, F::kInt, C::kLinear, nullptr },
    { "AR", 31.0f, 0.0f, 31.0f, F::kInt, C::kLinear, nullptr },
    { "D1R", 8.0f, 0.0f, 31.0f, F::kInt, C::kLinear, nullptr },
    { "D1L", 4.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "D2R", 0.0f, 0.0f, 31.0f, F::kInt, C::kLinear, nullptr },
    { "RR", 6.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "Loop", 0.0f, 0.0f, 4.0f, F::kEnum, C::kLinear, kEnum5 },
    { "AMS", 0.0f, 0.0f, 3.0f, F::kInt, C::kLinear, nullptr },
    { "MUL", 1.0f, 0.0f, 15.0f, F::kEnum, C::kLinear, kEnum4 },
    { "DT", 0.0f, -3.0f, 3.0f, F::kInt, C::kLinear, nullptr },
    { "Level", 0.25f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "RS", 1.0f, 0.0f, 3.0f, F::kInt, C::kLinear, nullptr },
    { "AR", 31.0f, 0.0f, 31.0f, F::kInt, C::kLinear, nullptr },
    { "D1R", 8.0f, 0.0f, 31.0f, F::kInt, C::kLinear, nullptr },
    { "D1L", 4.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "D2R", 0.0f, 0.0f, 31.0f, F::kInt, C::kLinear, nullptr },
    { "RR", 6.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "Loop", 0.0f, 0.0f, 4.0f, F::kEnum, C::kLinear, kEnum5 },
    { "AMS", 0.0f, 0.0f, 3.0f, F::kInt, C::kLinear, nullptr },
    { "MUL", 1.0f, 0.0f, 15.0f, F::kEnum, C::kLinear, kEnum4 },
    { "DT", 0.0f, -3.0f, 3.0f, F::kInt, C::kLinear, nullptr },
    { "Level", 1.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "RS", 1.0f, 0.0f, 3.0f, F::kInt, C::kLinear, nullptr },
    { "AR", 31.0f, 0.0f, 31.0f, F::kInt, C::kLinear, nullptr },
    { "D1R", 8.0f, 0.0f, 31.0f, F::kInt, C::kLinear, nullptr },
    { "D1L", 4.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "D2R", 0.0f, 0.0f, 31.0f, F::kInt, C::kLinear, nullptr },
    { "RR", 6.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "Loop", 0.0f, 0.0f, 4.0f, F::kEnum, C::kLinear, kEnum5 },
    { "AMS", 0.0f, 0.0f, 3.0f, F::kInt, C::kLinear, nullptr },
    { "Aux", 0.0f, 0.0f, 2.0f, F::kEnum, C::kLinear, kEnum6 },
    { "Aux Level", 0.5f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Aux Octave", 0.0f, -2.0f, 2.0f, F::kInt, C::kLinear, nullptr },
    { "Aux Decay", 4.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "Arp Mode", 0.0f, 0.0f, 11.0f, F::kEnum, C::kLinear, kEnum7 },
    { "Arp Rate", 1.0f, 0.0f, 8.0f, F::kEnum, C::kLinear, kEnum8 },
    { "Arp Note 2", 4.0f, 0.0f, 24.0f, F::kSemi, C::kLinear, nullptr },
    { "Arp Note 3", 7.0f, 0.0f, 24.0f, F::kSemi, C::kLinear, nullptr },
    { "Slide Start", 0.0f, -24.0f, 24.0f, F::kSemi, C::kLinear, nullptr },
    { "Slide Time", 0.05f, 0.0f, 1.0f, F::kSec, C::kSteep, nullptr },
};

const uint8_t kSec0[] = { 0, 1, 2, 3, 4, 5 };
const uint8_t kSec1[] = { 6, 7 };
const uint8_t kSec2[] = { 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18 };
const uint8_t kSec3[] = { 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29 };
const uint8_t kSec4[] = { 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40 };
const uint8_t kSec5[] = { 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51 };
const uint8_t kSec6[] = { 52, 53, 54, 55 };
const uint8_t kSec7[] = { 56, 57, 58, 59, 60, 61 };

const SectionDef kSections[] = {
    { "Global", "GLOBAL", kSec0, sizeof(kSec0) },
    { "LFO", "LFO", kSec1, sizeof(kSec1) },
    { "Operator 1", "OP1", kSec2, sizeof(kSec2) },
    { "Operator 2", "OP2", kSec3, sizeof(kSec3) },
    { "Operator 3", "OP3", kSec4, sizeof(kSec4) },
    { "Operator 4", "OP4", kSec5, sizeof(kSec5) },
    { "Aux Voice", "AUX", kSec6, sizeof(kSec6) },
    { "Chip Tricks", "CHIP", kSec7, sizeof(kSec7) },
};

const MacroDef kMacros[] = {
    { "LFO Rate", false, 1, { { 6, 0.3f } } },
    { "Feedback", false, 1, { { 1, 0.5f } } },
    { "Glide Time", false, 1, { { 4, 0.3f } } },
    { "PMS", false, 1, { { 7, 0.3f } } },
    { "OP1 DT", true, 1, { { 9, 0.5f } } },
    { "OP2 DT", true, 1, { { 20, 0.5f } } },
};

} // namespace

const EngineDef kArcDef = {
    "ARCTYPE",
    0x89,
    kParams,
    ot::audio::arc::kParamCount,
    kSections,
    static_cast<int>(sizeof(kSections) / sizeof(kSections[0])),
    kMacros,
    6,
    5,
    kMaxVoicesPerInstrument,
    &ot::audio::arc::engine,
    false,
};

} // namespace polysynth::open
