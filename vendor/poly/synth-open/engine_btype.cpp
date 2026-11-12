// B-Type parameter metadata for the open PolySynth shim on MK66. B-Type is an engine from OpenTracker 3.x (module opentracker-synths/modules/btype,
// MIT, synth-open/ot-synths/btype). The ranges, defaults, labels, value formats, enum names and the section split follow that module's
// descriptor (modules/btype/src/btype_desc.cpp, MIT, Copyright (c) 2026 Marcin Spoczynski, see licenses/LICENSE-OpenTracker-synths-MIT.txt).
// Edit curves and the default macros are this shim's choice (the same rules as the browser editor engine host).
//
// OpenTracker engine id 0x88, see engine_list.h.
#include "open_engine.h"

#include "PolySynth/config.h"
#include "ot-synths/btype/btype.h"

namespace polysynth::open
{
namespace
{
using F = Fmt;
using C = CurveKind;

const char* const kEnum0[] = { "15.6 kHz", "64 kHz", "1.79 MHz" };
const char* const kEnum1[] = { "Pure", "Poly4", "Poly5", "Poly9", "Poly17", "Poly5x4", "Poly5x17", "Poly5x9" };
const char* const kEnum2[] = { "Free", "Coarse", "Fine" };
const char* const kEnum3[] = { "Off", "Oct", "Maj", "Min", "Sus4", "Dom7", "Maj7", "Min7", "Dim", "Aug", "Pow5", "Custom" };
const char* const kEnum4[] = { "50 Hz", "60 Hz", "100 Hz", "120 Hz", "1/32", "1/48", "1/64", "1/96", "1/128" };
const char* const kEnum5[] = { "Always", "Overlap", "Legato", "Legato Overlap" };

const ParamDef kParams[ot::audio::btype::kParamCount] = {
    { "Clock", 1.0f, 0.0f, 2.0f, F::kEnum, C::kLinear, kEnum0 },
    { "Distortion", 0.0f, 0.0f, 7.0f, F::kEnum, C::kLinear, kEnum1 },
    { "Tuning", 0.0f, 0.0f, 2.0f, F::kEnum, C::kLinear, kEnum2 },
    { "Poly Reset", 1.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "Hi-Pass", 0.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "HP Freq", 1000.0f, 50.0f, 8000.0f, F::kHz, C::kExp, nullptr },
    { "Level", 0.0f, 0.0f, 1.0f, F::kPct, C::kLinear, nullptr },
    { "Detune", 1.0f, -8.0f, 8.0f, F::kInt, C::kLinear, nullptr },
    { "Distortion", 0.0f, 0.0f, 7.0f, F::kEnum, C::kLinear, kEnum1 },
    { "Attack", 0.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "Decay", 6.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "Sustain", 10.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "Release", 2.0f, 0.0f, 15.0f, F::kInt, C::kLinear, nullptr },
    { "Bits", 1.0f, 0.0f, 1.0f, F::kOnOff, C::kLinear, nullptr },
    { "Arp Mode", 0.0f, 0.0f, 11.0f, F::kEnum, C::kLinear, kEnum3 },
    { "Arp Rate", 1.0f, 0.0f, 8.0f, F::kEnum, C::kLinear, kEnum4 },
    { "Arp Note 2", 4.0f, 0.0f, 24.0f, F::kSemi, C::kLinear, nullptr },
    { "Arp Note 3", 7.0f, 0.0f, 24.0f, F::kSemi, C::kLinear, nullptr },
    { "Vib Rate", 5.0f, 0.5f, 15.0f, F::kLfoHz, C::kExp, nullptr },
    { "Vib Depth", 0.0f, 0.0f, 2.0f, F::kSemi, C::kLinear, nullptr },
    { "Vib Delay", 0.2f, 0.0f, 1.0f, F::kSec, C::kSteep, nullptr },
    { "Slide Start", 0.0f, -24.0f, 24.0f, F::kSemi, C::kLinear, nullptr },
    { "Slide Time", 0.05f, 0.0f, 1.0f, F::kSec, C::kSteep, nullptr },
    { "Glide Mode", 0.0f, 0.0f, 3.0f, F::kEnum, C::kLinear, kEnum5 },
    { "Glide Time", 0.0f, 0.0f, 3.0f, F::kSec, C::kSteep, nullptr },
    { "DAC Bits", 4.0f, 4.0f, 8.0f, F::kInt, C::kLinear, nullptr },
    { "Volume", 1.0f, 0.0f, 2.0f, F::kPct, C::kLinear, nullptr },
};

const uint8_t kSec0[] = { 0, 1, 2, 3, 4, 5 };
const uint8_t kSec1[] = { 6, 7, 8 };
const uint8_t kSec2[] = { 9, 10, 11, 12, 13 };
const uint8_t kSec3[] = { 14, 15, 16, 17, 18, 19, 20, 21, 22 };
const uint8_t kSec4[] = { 23, 24, 25, 26 };

const SectionDef kSections[] = {
    { "Channel", "CHAN", kSec0, sizeof(kSec0) },
    { "Channel 2", "OSC2", kSec1, sizeof(kSec1) },
    { "Envelope", "ENV", kSec2, sizeof(kSec2) },
    { "Chip Tricks", "CHIP", kSec3, sizeof(kSec3) },
    { "Controllers", "CTRL", kSec4, sizeof(kSec4) },
};

const MacroDef kMacros[] = {
    { "Attack", false, 1, { { 9, 0.3f } } },
    { "Release", false, 1, { { 12, 0.3f } } },
    { "Decay", false, 1, { { 10, 0.3f } } },
    { "Detune", false, 1, { { 7, 0.3f } } },
    { "HP Freq", false, 1, { { 5, 0.3f } } },
    { "Level", false, 1, { { 6, 0.3f } } },
};

} // namespace

const EngineDef kBtypeDef = {
    "BTYPE",
    0x88,
    kParams,
    ot::audio::btype::kParamCount,
    kSections,
    static_cast<int>(sizeof(kSections) / sizeof(kSections[0])),
    kMacros,
    6,
    26,
    kMaxVoicesPerInstrument,
    &ot::audio::btype::engine,
    false,
};

} // namespace polysynth::open
