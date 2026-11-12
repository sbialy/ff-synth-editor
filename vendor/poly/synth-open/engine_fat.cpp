// FAT (FatAnalog) parameter metadata for the open PolySynth shim on MK66.
// Indices and ranges follow OpenTracker's FAT engine (synth-open/ot/audio/engines/fat.h, Apache-2.0),
// labels and sections follow the Tracker Mini manual naming as used by OpenTracker.
#include "open_engine.h"

#include "audio/engines/fat.h"
#include "PolySynth/config.h"

namespace polysynth::open
{
namespace
{
using ot::audio::fat::Param;

const char* const kFilter[] = { "LP MG 24dB", "LP OB 24dB", "LP OB 12dB" };

using F = Fmt;
using C = CurveKind;

const ParamDef kParams[Param::kParamCount] = {
    { "Fatness", 0.1f, 0, 1, F::kVal100, C::kLinear, nullptr },
    { "Brightness", 1, -1, 1, F::kVal100, C::kLinear, nullptr },
    { "LFO Amt", 0.05f, 0, 1, F::kPct, C::kLinear, nullptr },
    { "Timbre", 0, 0, 1, F::kVal100, C::kLinear, nullptr },
    { "Noise", 0, 0, 1, F::kPct, C::kLinear, nullptr },
    { "Reset", 1, 0, 1, F::kOnOff, C::kLinear, nullptr },
    { "Type", 0, 0, 2, F::kEnum, C::kLinear, kFilter },
    { "Cutoff", 400, 20, 20000, F::kHz, C::kExp, nullptr },
    { "Resonance", 0.5f, 0, 1.5f, F::kPctMax, C::kLinear, nullptr },
    { "LFO Amt", 0, -1, 1, F::kPct, C::kLinear, nullptr },
    { "Env Amt", 0.14f, -1, 1, F::kPct, C::kLinear, nullptr },
    { "Attack", 0, 0, 10, F::kSec, C::kSteep, nullptr },
    { "Decay", 0.5f, 0, 10, F::kSec, C::kSteep, nullptr },
    { "Sustain", 0, 0, 1, F::kPct, C::kLinear, nullptr },
    { "Release", 0.5f, 0, 10, F::kSec, C::kSteep, nullptr },
    { "Attack", 0, 0, 10, F::kSec, C::kSteep, nullptr },
    { "Decay", 0.5f, 0, 10, F::kSec, C::kSteep, nullptr },
    { "Sustain", 0, 0, 1, F::kPct, C::kLinear, nullptr },
    { "Release", 0.5f, 0, 10, F::kSec, C::kSteep, nullptr },
    { "Frequency", 1, 0.1f, 100, F::kLfoHz, C::kExp, nullptr },
    { "Waveform", 1, 0, 5, F::kEnum, C::kLinear, kWaveNames },
    { "Retrigger", 2, 0, 2, F::kEnum, C::kLinear, kRetrigNames },
    { "Glide Mode", 0, 0, 3, F::kEnum, C::kLinear, kGlideNames },
    { "Glide Time", 0, 0, 3, F::kSec, C::kPower, nullptr },
    { "Volume", 1, 0, 2, F::kPct, C::kLinear, nullptr },
};

const uint8_t kOsc[] = { Param::kFatness, Param::kBrightness, Param::kTimbre, Param::kOscLfo, Param::kNoise, Param::kReset };
const uint8_t kFlt[] = { Param::kCutoff, Param::kResonance, Param::kFilterType, Param::kFilterEnv, Param::kFilterLfo };
const uint8_t kAmp[] = { Param::kAmpA, Param::kAmpD, Param::kAmpS, Param::kAmpR };
const uint8_t kEnv[] = { Param::kEnvA, Param::kEnvD, Param::kEnvS, Param::kEnvR };
const uint8_t kLfo[] = { Param::kLfoHz, Param::kLfoWave, Param::kLfoRetrig };
const uint8_t kVoice[] = { Param::kGlideMode, Param::kGlideTime, Param::kVolume };

const SectionDef kSections[] = {
    { "Oscillator", "Osc", kOsc, sizeof(kOsc) },
    { "Filter", "Filter", kFlt, sizeof(kFlt) },
    { "Amp Envelope", "Amp Env", kAmp, sizeof(kAmp) },
    { "Envelope", "Env", kEnv, sizeof(kEnv) },
    { "LFO", "LFO", kLfo, sizeof(kLfo) },
    { "Voice", "Voice", kVoice, sizeof(kVoice) },
};

// Default macros (this shim's own choice)
const MacroDef kMacros[] = {
    { "Cutoff", false, 1, { { Param::kCutoff, 0.4f } } },
    { "Resonance", false, 1, { { Param::kResonance, 1.0f } } },
    { "Env Amount", true, 1, { { Param::kFilterEnv, 1.0f } } },
    { "Decay / Release", false, 2, { { Param::kAmpD, 0.3f }, { Param::kAmpR, 0.3f } } },
    { "Fatness", false, 1, { { Param::kFatness, 1.0f } } },
    { "Brightness", true, 1, { { Param::kBrightness, 0.5f } } },
};

} // namespace

const EngineDef kFatDef = {
    "FAT",
    static_cast<int>(InstrumentTypeId::kFatAnalogSynth),
    kParams,
    Param::kParamCount,
    kSections,
    static_cast<int>(sizeof(kSections) / sizeof(kSections[0])),
    kMacros,
    static_cast<int>(sizeof(kMacros) / sizeof(kMacros[0])),
    Param::kVolume,
    kMaxVoicesPerInstrument,
    &ot::audio::fat::engine,
    false,
};

} // namespace polysynth::open
