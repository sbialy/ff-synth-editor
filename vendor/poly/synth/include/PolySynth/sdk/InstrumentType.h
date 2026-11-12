#pragma once

#include <functional>
#include <memory>
#include <string>

#include "PolySynth/Patch.h"

namespace polysynth
{
class InstrumentVoice;

/**
 * Instrument type holds all data relevant internally to handle specific
 * type of instrument (e.g. sample playback, FM synthesizer, Midi out instrument,
 * or custom open-source synthesizer engine).
 *
 * Some of the data is exposed via Metadata API of the Patch class.
 */
struct InstrumentType
{
    std::string name = {};

    std::function<void(Patch& patch, Patch::Metadata& metadata)> createMetadata;
    std::function<std::unique_ptr<InstrumentVoice>(int voiceIdx)> createVoice;
};

} // namespace polysynth
