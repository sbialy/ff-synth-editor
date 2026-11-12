// T-Type parameter metadata for the open PolySynth shim on MK66. T-Type is an engine from OpenTracker 3.x (module opentracker-synths/modules/ttype,
// MIT, synth-open/ot-synths/ttype). The ranges, defaults, labels, value formats, enum names and the section split follow that module's
// descriptor (modules/ttype/src/ttype_desc.cpp, MIT, Copyright (c) 2026 Marcin Spoczynski, see licenses/LICENSE-OpenTracker-synths-MIT.txt).
// Edit curves and the default macros are this shim's choice (the same rules as the browser editor engine host).
//
// OpenTracker engine id 0x85, see engine_list.h.
#include "open_engine.h"

#include "PolySynth/config.h"
#include "ot-synths/ttype/ttype.h"

namespace polysynth::open
{
namespace
{
using F = Fmt;
using C = CurveKind;

const char* const kEnum0[] = { "Punch", "Boom", "Knock" };
const char* const kEnum1[] = { "Crack", "Soft", "Thin" };
const char* const kEnum2[] = { "Wide", "Dry", "Tight" };
const char* const kEnum3[] = { "Sweep", "Round", "Short" };
const char* const kEnum4[] = { "Stick", "Pop", "Tick" };
const char* const kEnum5[] = { "Clang", "Bright", "Low" };
const char* const kEnum6[] = { "Noisy", "Metal", "Thin" };
const char* const kEnum7[] = { "Crash", "Ring", "Thin" };

const ParamDef kParams[ot::audio::ttype::kParamCount] = {
    { "Level", 0.9f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Tune", 55.0f, 30.0f, 120.0f, F::kHz, C::kExp, nullptr },
    { "Decay", 0.35f, 0.05f, 2.5f, F::kSec, C::kSteep, nullptr },
    { "Attack", 0.4f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Sweep", 0.5f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Drive", 0.2f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Character", 0.0f, 0.0f, 2.0f, F::kEnum, C::kLinear, kEnum0 },
    { "Level", 0.8f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Tune", 185.0f, 120.0f, 400.0f, F::kHz, C::kExp, nullptr },
    { "Decay", 0.2f, 0.05f, 1.0f, F::kSec, C::kSteep, nullptr },
    { "Tone", 0.5f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Snappy", 0.5f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Character", 0.0f, 0.0f, 2.0f, F::kEnum, C::kLinear, kEnum1 },
    { "Level", 0.8f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Tone", 0.5f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Decay", 0.25f, 0.05f, 1.5f, F::kSec, C::kSteep, nullptr },
    { "Tail", 0.5f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Character", 0.0f, 0.0f, 2.0f, F::kEnum, C::kLinear, kEnum2 },
    { "Low Level", 0.8f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Mid Level", 0.8f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "High Level", 0.8f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Low Tune", 90.0f, 40.0f, 200.0f, F::kHz, C::kExp, nullptr },
    { "Mid Tune", 130.0f, 60.0f, 300.0f, F::kHz, C::kExp, nullptr },
    { "High Tune", 190.0f, 80.0f, 400.0f, F::kHz, C::kExp, nullptr },
    { "Low Decay", 0.4f, 0.05f, 2.0f, F::kSec, C::kSteep, nullptr },
    { "Mid Decay", 0.35f, 0.05f, 2.0f, F::kSec, C::kSteep, nullptr },
    { "High Decay", 0.3f, 0.05f, 2.0f, F::kSec, C::kSteep, nullptr },
    { "Tone", 0.3f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Character", 0.0f, 0.0f, 2.0f, F::kEnum, C::kLinear, kEnum3 },
    { "Rim Level", 0.8f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Rim Tune", 1700.0f, 500.0f, 4000.0f, F::kHz, C::kExp, nullptr },
    { "Rim Character", 0.0f, 0.0f, 2.0f, F::kEnum, C::kLinear, kEnum4 },
    { "Bell Level", 0.7f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Bell Tune", 540.0f, 300.0f, 1200.0f, F::kHz, C::kExp, nullptr },
    { "Bell Decay", 0.3f, 0.05f, 1.5f, F::kSec, C::kSteep, nullptr },
    { "Bell Character", 1.0f, 0.0f, 2.0f, F::kEnum, C::kLinear, kEnum5 },
    { "Closed", 0.8f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Open", 0.8f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Tune", 205.0f, 100.0f, 600.0f, F::kHz, C::kExp, nullptr },
    { "Closed Decay", 0.06f, 0.01f, 0.5f, F::kSec, C::kSteep, nullptr },
    { "Open Decay", 0.5f, 0.1f, 3.0f, F::kSec, C::kSteep, nullptr },
    { "Tone", 0.5f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Character", 0.0f, 0.0f, 2.0f, F::kEnum, C::kLinear, kEnum6 },
    { "Level", 0.7f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Tune", 1.0f, 0.5f, 2.0f, F::kVal100, C::kLinear, nullptr },
    { "Decay", 1.5f, 0.2f, 6.0f, F::kSec, C::kSteep, nullptr },
    { "Tone", 0.5f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Character", 0.0f, 0.0f, 2.0f, F::kEnum, C::kLinear, kEnum7 },
    { "Kick Delay", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Kick Reverb", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Snare Delay", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Snare Reverb", 0.3f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Clap Delay", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Clap Reverb", 0.3f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Low Tom Delay", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Low Tom Reverb", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Mid Tom Delay", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Mid Tom Reverb", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "High Tom Delay", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "High Tom Reverb", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Rim Delay", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Rim Reverb", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Bell Delay", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Bell Reverb", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Hat Delay", 0.2f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Hat Reverb", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Crash Delay", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Crash Reverb", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Ride Delay", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Ride Reverb", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Accent", 1.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Drive", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Width", 0.6f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
};

const uint8_t kSec0[] = { 0, 1, 2, 3, 4, 5, 6 };
const uint8_t kSec1[] = { 7, 8, 9, 10, 11, 12 };
const uint8_t kSec2[] = { 13, 14, 15, 16, 17 };
const uint8_t kSec3[] = { 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28 };
const uint8_t kSec4[] = { 29, 30, 31, 32, 33, 34, 35 };
const uint8_t kSec5[] = { 36, 37, 38, 39, 40, 41, 42 };
const uint8_t kSec6[] = { 43, 44, 45, 46, 47 };
const uint8_t kSec7[] = { 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69 };
const uint8_t kSec8[] = { 70, 71, 72 };

const SectionDef kSections[] = {
    { "Kick", "Kick", kSec0, sizeof(kSec0) },
    { "Snare", "Snare", kSec1, sizeof(kSec1) },
    { "Clap", "Clap", kSec2, sizeof(kSec2) },
    { "Toms", "Toms", kSec3, sizeof(kSec3) },
    { "Rim & Bell", "Perc", kSec4, sizeof(kSec4) },
    { "Hi Hats", "Hats", kSec5, sizeof(kSec5) },
    { "Cymbal", "Cymbal", kSec6, sizeof(kSec6) },
    { "Sends", "Sends", kSec7, sizeof(kSec7) },
    { "Global", "Global", kSec8, sizeof(kSec8) },
};

const MacroDef kMacros[] = {
    { "Attack", false, 1, { { 3, 0.3f } } },
    { "Kick Decay", false, 1, { { 2, 0.3f } } },
    { "Kick Drive", false, 1, { { 5, 0.5f } } },
    { "Kick Level", false, 1, { { 0, 0.3f } } },
    { "Snare Level", false, 1, { { 7, 0.3f } } },
    { "Clap Level", false, 1, { { 13, 0.3f } } },
};

} // namespace

const EngineDef kTtypeDef = {
    "TTYPE",
    0x85,
    kParams,
    ot::audio::ttype::kParamCount,
    kSections,
    static_cast<int>(sizeof(kSections) / sizeof(kSections[0])),
    kMacros,
    6,
    -1,
    1,
    &ot::audio::ttype::engine,
    false,
};

} // namespace polysynth::open
