// PERC (Drum) parameter metadata for the open PolySynth shim on MK66.
// Indices and ranges follow OpenTracker's PERC engine (synth-open/ot/audio/engines/perc.h, Apache-2.0),
// labels and sections follow the Tracker Mini manual naming as used by OpenTracker.
// PERC has no Volume parameter: the framework gain is the note velocity (see open_synth.cpp).
#include "open_engine.h"

#include "audio/engines/perc.h"
#include "PolySynth/config.h"

namespace polysynth::open
{
namespace
{
using ot::audio::perc::Param;

const char* const kKickModel[] = { "Classic8", "Synced8", "Classic9" };
const char* const kTomModel[] = { "Classic", "Classic+", "Resonant" };
const char* const kSnareModel[] = { "Classic8", "Classic9", "Classic9+", "Modern", "Modern+" };
const char* const kTwoModel[] = { "Classic", "FM" };
const char* const kPercModel[] = { "Clap", "Clap+", "Maracas", "Shaker", "Cowbell" };
const char* const kOutput[] = { "Main", "Post Overdrive", "Post EQ" };
const char* const kShaper[] = { "Saturate", "Overdrive", "Overdrive+", "Bitcrush", "Bitcrush+" };
const char* const kBodyWave[] = { "Sat-Sin", "Triangle", "Square",   "Square FM", "FM1",      "FM3",
                                  "FM7",     "FM11",     "tzFM1",    "tzFM3",     "tzFM7",    "tzFM11",
                                  "Glitch 1", "Glitch 2", "Glitch 3", "Glitch 4" };

using F = Fmt;
using C = CurveKind;

#define MIXROW(d, level, pan, delay) \
    { d " Level", level, 0, 2, F::kPct, C::kLinear, nullptr }, { d " Pan", pan, -1, 1, F::kPan, C::kLinear, nullptr }, \
      { d " Delay", delay, 0, 1, F::kVal100, C::kLinear, nullptr }, \
      { d " Reverb", 0, 0, 1, F::kVal100, C::kLinear, nullptr }, \
      { d " Output", 0, 0, 2, F::kEnum, C::kLinear, kOutput }

const ParamDef kParams[ot::audio::perc::kParamCount] = {
    // Kick 0-8
    { "Body Wave", 0, 0, 175, F::kBodyWave, C::kLinear, kBodyWave },
    { "Pitch", 31, 12, 119, F::kNote, C::kLinear, nullptr },
    { "Body Attack", 1.8f, 0, 100, F::kMs10, C::kLinear, nullptr },
    { "Body Decay", 0.26f, 0, 10, F::kSec, C::kSteep, nullptr },
    { "Trans Timbre", 0.32f, -1, 1, F::kVal100, C::kLinear, nullptr },
    { "Trans Level", 0.5f, 0, 1, F::kPct, C::kLinear, nullptr },
    { "Mod Decay", 0.13f, 0, 10, F::kSec, C::kSteep, nullptr },
    { "Mod Amount", 0.2f, -1, 1, F::kVal100, C::kLinear, nullptr },
    { "Model", 2, 0, 2, F::kEnum, C::kLinear, kKickModel },
    // Tom 9-17
    { "Body Wave", 0, 0, 175, F::kBodyWave, C::kLinear, kBodyWave },
    { "Body Attack", 1.4f, 0, 100, F::kMs10, C::kLinear, nullptr },
    { "Body Decay", 0.41f, 0, 10, F::kSec, C::kSteep, nullptr },
    { "Trans Level", 0.58f, 0, 1, F::kPct, C::kLinear, nullptr },
    { "Trans Timbre", 1, 0, 2, F::kVal100, C::kLinear, nullptr },
    { "Mod Decay", 0.05f, 0, 10, F::kSec, C::kSteep, nullptr },
    { "Pitch Mod", 1.65f, -10, 10, F::kVal100, C::kLinear, nullptr },
    { "Wave Mod", 0.4f, -1, 1, F::kVal100, C::kLinear, nullptr },
    { "Model", 1, 0, 2, F::kEnum, C::kLinear, kTomModel },
    // Snare 18-26
    { "Body Wave", 0, 0, 175, F::kBodyWave, C::kLinear, kBodyWave },
    { "Pitch", 50, 12, 119, F::kNote, C::kLinear, nullptr },
    { "Tone", 0.5f, 0, 1, F::kPct, C::kLinear, nullptr },
    { "Model", 1, 0, 4, F::kEnum, C::kLinear, kSnareModel },
    { "Body Decay", 0.17f, 0, 10, F::kSec, C::kSteep, nullptr },
    { "Snap Attack", 0.8f, 0, 100, F::kMs10, C::kLinear, nullptr },
    { "Snap Decay", 0.26f, 0, 10, F::kSec, C::kSteep, nullptr },
    { "Body/Snap Mix", -0.39f, -1, 1, F::kVal100, C::kLinear, nullptr },
    { "Snap Timbre", 0.13f, 0, 1, F::kPct, C::kLinear, nullptr },
    // Hi-hat 27-35
    { "Decay Shape", 0.12f, 0, 1, F::kPct, C::kLinear, nullptr },
    { "Closed Decay", 0.16f, 0, 10, F::kSec, C::kSteep, nullptr },
    { "Open Decay", 0.81f, 0, 10, F::kSec, C::kSteep, nullptr },
    { "HPF Cutoff", 5080, 10, 20000, F::kHz, C::kExp, nullptr },
    { "LPF Cutoff", 9040, 10, 20000, F::kHz, C::kExp, nullptr },
    { "Tone Pitch", 209, 100, 880, F::kHz, C::kExp, nullptr },
    { "Tone/Noise Mix", -0.09f, -1, 1, F::kVal100, C::kLinear, nullptr },
    { "Timbre", 0, 0, 24, F::kInt, C::kLinear, nullptr },
    { "Model", 0, 0, 1, F::kEnum, C::kLinear, kTwoModel },
    // Cymbal 36-44
    { "Body Filter", 3000, 500, 10000, F::kHz, C::kExp, nullptr },
    { "Impact Filter", 7000, 500, 10000, F::kHz, C::kExp, nullptr },
    { "Body Decay", 1.5f, 0, 10, F::kSec, C::kSteep, nullptr },
    { "Impact Decay", 0.25f, 0, 10, F::kSec, C::kSteep, nullptr },
    { "Tone Pitch", 204, 80, 880, F::kHz, C::kExp, nullptr },
    { "Tone/Noise Mix", -0.39f, -1, 1, F::kVal100, C::kLinear, nullptr },
    { "Impact/Body Mix", 0.29f, -1, 1, F::kVal100, C::kLinear, nullptr },
    { "Model", 0, 0, 1, F::kEnum, C::kLinear, kTwoModel },
    { "Timbre", 0, 0, 24, F::kInt, C::kLinear, nullptr },
    // Perc 45-48
    { "Model", 0, 0, 4, F::kEnum, C::kLinear, kPercModel },
    { "Variation", 0.07f, 0, 1, F::kVal100, C::kLinear, nullptr },
    { "Timbre", 0.62f, 0, 1, F::kVal100, C::kLinear, nullptr },
    { "Decay", 0.14f, 0, 2, F::kSec, C::kSteep, nullptr },
    // Mixer 49-78
    MIXROW("Kick", 1, 0, 0), MIXROW("Tom", 0.8f, 0.2f, 0), MIXROW("Snare", 1, -0.1f, 0.5f),
    MIXROW("Hi Hat", 1, 0.3f, 0.5f), MIXROW("Cymbal", 1, -0.3f, 0.5f), MIXROW("Perc", 1, 0.1f, 0.5f),
    // FX 79-83
    { "Waveshaper Level", 0, 0, 1, F::kVal100, C::kLinear, nullptr },
    { "Waveshaper Type", 0, 0, 4, F::kEnum, C::kLinear, kShaper },
    { "EQ Low 80Hz", 0, -18, 18, F::kDb, C::kLinear, nullptr },
    { "EQ Mid 2.5kHz", 0, -18, 18, F::kDb, C::kLinear, nullptr },
    { "EQ High 12kHz", 0, -18, 18, F::kDb, C::kLinear, nullptr },
};
#undef MIXROW

const uint8_t kKick[] = { 8, 1, 0, 2, 3, 6, 7, 4, 5 };
const uint8_t kTom[] = { 17, 9, 10, 11, 14, 15, 16, 13, 12 };
const uint8_t kSnare[] = { 21, 19, 20, 18, 22, 23, 24, 26, 25 };
const uint8_t kHat[] = { 35, 34, 28, 29, 27, 30, 31, 32, 33 };
const uint8_t kCym[] = { 43, 44, 36, 37, 38, 39, 40, 41, 42 };
const uint8_t kPerc[] = { 45, 46, 47, 48 };
const uint8_t kMix[] = { 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63,
                         64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78 };
const uint8_t kFx[] = { 80, 79, 81, 82, 83 };

// The editor picks section icons from these names ("Hihat" is its spelling)
const SectionDef kSections[] = {
    { "Kick", "Kick", kKick, sizeof(kKick) },
    { "Toms", "Tom", kTom, sizeof(kTom) },
    { "Snare", "Snare", kSnare, sizeof(kSnare) },
    { "Hihat", "Hihat", kHat, sizeof(kHat) },
    { "Cymbal", "Cymbal", kCym, sizeof(kCym) },
    { "Percussion", "Perc", kPerc, sizeof(kPerc) },
    { "Mixer", "Mixer", kMix, sizeof(kMix) },
    { "FX", "FX", kFx, sizeof(kFx) },
};

// Default macros (this shim's own choice). PERC has no Volume: velocity is applied by the engine per hit.
const MacroDef kMacros[] = {
    { "Kick Decay", false, 1, { { Param::kKickDecay, 0.1f } } },
    { "Snare Decay", false, 1, { { Param::kSnareDecay, 0.1f } } },
    { "Hat Closed Decay", false, 1, { { Param::kHatClosed, 0.1f } } },
    { "Kick Pitch", true, 1, { { Param::kKickPitch, 0.1f } } },
    { "Waveshaper", false, 1, { { Param::kWsLevel, 1.0f } } },
    { "EQ High", true, 1, { { Param::kEqHigh, 0.5f } } },
};

} // namespace

const EngineDef kPercDef = {
    "PERC",
    static_cast<int>(InstrumentTypeId::kDrumSynth),
    kParams,
    ot::audio::perc::kParamCount,
    kSections,
    static_cast<int>(sizeof(kSections) / sizeof(kSections[0])),
    kMacros,
    static_cast<int>(sizeof(kMacros) / sizeof(kMacros[0])),
    -1, // no Volume parameter
    1,  // one voice: the kit lives in the slot scratch
    &ot::audio::percEngine,
    false, // no slot effect
};

} // namespace polysynth::open
