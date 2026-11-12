#pragma once

#include "PolySynth/sdk/InstrumentType.h"
#include <memory>

namespace polysynth
{
std::unique_ptr<InstrumentType> createChiptuneSynth();

#ifdef FEATURE_SYNTH_OPEN
// SYNTH_OPEN (MK66): hooks for synth-open/engine_chip.cpp, which hosts this voice behind the open shim without the
// Patch::Metadata path (createChiptuneSynth stays unused there, so the linker drops its metadata and formatters)
class InstrumentVoice;
namespace open
{
std::unique_ptr<InstrumentVoice> chipVoiceCreate();
void chipVoiceReset(InstrumentVoice& voice);
// The same parameter handling as the handlers in createMetadata, except Volume (the shim applies it as voice gain)
void chipVoiceSetParam(InstrumentVoice& voice, int paramId, float value);
void chipVoiceSetBend(InstrumentVoice& voice, float semitones);
} // namespace open
#endif
} // namespace polysynth
