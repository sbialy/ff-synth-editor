#pragma once

#include <memory>

#include "MidiEvent.h"
#include "PImpl.h"

namespace polysynth
{
class Patch;
class MidiSource;
class InstrumentImpl;

/**
 * Abstraction of an instrument, as a sound generator.
 */
class Instrument : public PImpl<InstrumentImpl>
{
  public:
    enum class LocalMode
    {
        kOff, // Do not play events directly from pads, only from midi input
        kOn,  // Play events directly from pads as well as from midi input
    };

    virtual void assignPatch(std::shared_ptr<Patch> patch) = 0;
    virtual void connect(MidiSource& midiSource) = 0;
    virtual void setMidiChannel(int channel) = 0;
    [[nodiscard]] virtual int getMidiChannel() const = 0;
    virtual void setLocalMode(LocalMode mode) = 0;
    [[nodiscard]] virtual LocalMode getLocalMode() const = 0;
    [[nodiscard]] virtual int getVoiceCount() const = 0;
    virtual void setVoiceCount(int voiceCount) = 0;

    virtual ~Instrument() = default;
};
}
