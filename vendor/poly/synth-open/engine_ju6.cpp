// JU6 parameter metadata for the open PolySynth shim on MK66. JU6 is a Juno-style polysynth voice from OpenTracker 3.x
// (module opentracker-synths/modules/ju6, MIT, synth-open/ot-synths/ju6). The ranges, defaults, labels, enum names and the
// section split follow that module's descriptor (modules/ju6/src/ju6_desc.cpp, MIT, Copyright (c) 2026 Marcin
// Spoczynski, see licenses/LICENSE-OpenTracker-synths-MIT.txt). Edit curves and the default macros are this shim's choice.
//
// The built-in chorus runs once per slot on the voice sum (ISynthEngine::slotPost), see EngineDef::slotFx.
#include "open_engine.h"

#include "PolySynth/config.h"
#include "ot-synths/ju6/ju6.h"

namespace polysynth::open
{
namespace
{
using ot::audio::ju6::Param;

const char* const kPwm[] = { "Manual", "LFO" };
const char* const kHpf[] = { "0 Boost", "1 Flat", "2", "3" };
const char* const kVca[] = { "Env", "Gate" };
const char* const kChorus[] = { "Off", "I", "II" };

using F = Fmt;
using C = CurveKind;

const ParamDef kParams[Param::kParamCount] = {
    { "Saw", 1, 0, 1, F::kOnOff, C::kLinear, nullptr },
    { "Pulse", 0, 0, 1, F::kOnOff, C::kLinear, nullptr },
    { "PW", 0.4f, 0, 1, F::kPct, C::kLinear, nullptr },
    { "PWM", 1, 0, 1, F::kEnum, C::kLinear, kPwm },
    { "Sub", 0.35f, 0, 1, F::kPct, C::kLinear, nullptr },
    { "Noise", 0, 0, 1, F::kPct, C::kLinear, nullptr },
    { "Vibrato", 0, 0, 1, F::kPct, C::kLinear, nullptr },
    { "HPF", 1, 0, 3, F::kEnum, C::kLinear, kHpf },
    { "Cutoff", 1400, 20, 20000, F::kHz, C::kExp, nullptr },
    { "Resonance", 0.15f, 0, 1, F::kPct, C::kLinear, nullptr },
    { "Env", 0.4f, -1, 1, F::kPctMax, C::kLinear, nullptr },
    { "LFO", 0, 0, 1, F::kPct, C::kLinear, nullptr },
    { "Key Follow", 0.5f, 0, 1, F::kPct, C::kLinear, nullptr },
    { "Velocity", 0, 0, 1, F::kPct, C::kLinear, nullptr },
    { "VCA", 0, 0, 1, F::kEnum, C::kLinear, kVca },
    { "Attack", 0.06f, 0, 10, F::kSec, C::kSteep, nullptr },
    { "Decay", 1.0f, 0, 10, F::kSec, C::kSteep, nullptr },
    { "Sustain", 0.65f, 0, 1, F::kPct, C::kLinear, nullptr },
    { "Release", 0.45f, 0, 10, F::kSec, C::kSteep, nullptr },
    { "LFO Rate", 3.5f, 0.1f, 20, F::kLfoHz, C::kExp, nullptr },
    { "LFO Delay", 0.6f, 0, 5, F::kSec, C::kPower, nullptr },
    { "Volume", 1, 0, 2, F::kPct, C::kLinear, nullptr },
    { "Chorus", 0, 0, 2, F::kEnum, C::kLinear, kChorus },
};

const uint8_t kDco[] = { Param::kSaw, Param::kPulse, Param::kPw, Param::kPwMode, Param::kSub, Param::kNoise,
                         Param::kVibrato };
const uint8_t kVcf[] = { Param::kHpf,       Param::kCutoff,    Param::kResonance, Param::kEnvAmt,
                         Param::kVcfLfo,    Param::kKeyFollow, Param::kVelVcf };
const uint8_t kVcaSec[] = { Param::kVcaMode, Param::kVolume };
const uint8_t kEnv[] = { Param::kAttack, Param::kDecay, Param::kSustain, Param::kRelease };
const uint8_t kLfo[] = { Param::kLfoRate, Param::kLfoDelay };
const uint8_t kCho[] = { Param::kChorus };

// The editor picks the section icon from the name ("Oscillator", "Filter", "Amplifier", ...)
const SectionDef kSections[] = {
    { "Oscillator", "DCO", kDco, sizeof(kDco) },
    { "Filter", "VCF", kVcf, sizeof(kVcf) },
    { "Amplifier", "VCA", kVcaSec, sizeof(kVcaSec) },
    { "Envelope", "ENV", kEnv, sizeof(kEnv) },
    { "LFO", "LFO", kLfo, sizeof(kLfo) },
    { "Modulation", "Chorus", kCho, sizeof(kCho) },
};

const MacroDef kMacros[] = {
    { "Cutoff", false, 1, { { Param::kCutoff, 0.4f } } },
    { "Resonance", false, 1, { { Param::kResonance, 1.0f } } },
    { "Env Amount", true, 1, { { Param::kEnvAmt, 1.0f } } },
    { "Decay / Release", false, 2, { { Param::kDecay, 0.3f }, { Param::kRelease, 0.3f } } },
    { "Pulse Width", true, 1, { { Param::kPw, 0.5f } } },
    { "LFO Rate", false, 1, { { Param::kLfoRate, 0.3f } } },
};

} // namespace

const EngineDef kJu6Def = {
    "JU6",
    0x81, // no Polyend id: OpenTracker's engine id, see engine_list.h
    kParams,
    Param::kParamCount,
    kSections,
    static_cast<int>(sizeof(kSections) / sizeof(kSections[0])),
    kMacros,
    static_cast<int>(sizeof(kMacros) / sizeof(kMacros[0])),
    Param::kVolume,
    kMaxVoicesPerInstrument,
    &ot::audio::ju6::engine,
    true, // the chorus
};

} // namespace polysynth::open
