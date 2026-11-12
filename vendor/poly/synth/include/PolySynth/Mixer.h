#pragma once

#include "PImpl.h"

#include <memory>

namespace polysynth
{
class Instrument;
class MixerImpl;

class Mixer : public PImpl<MixerImpl>
{
  public:
    virtual ~Mixer() = default;

    [[nodiscard]] virtual float getChannelGain(int channel) = 0;
    virtual void setChannelGain(int channel, float gainDb) = 0;
    [[nodiscard]] virtual float getChannelPanning(int channel) = 0;
    virtual void setChannelPanning(int channel, float panning) = 0;
    [[nodiscard]] virtual float getChannelSend(int channel, int send) = 0;
    virtual void setChannelSend(int channel, int send, float gainDb) = 0;
    [[nodiscard]] virtual float getReturnChannelSend(int returnChannel, int send) = 0;
    virtual void setReturnChannelSend(int returnChannel, int send, float gainDb) = 0;

    virtual void connectInput(int channel, std::shared_ptr<Instrument> instrument) = 0;
    virtual void disconnectInput(int channel) = 0;
    virtual void connectSend(int send, std::shared_ptr<Instrument> instrument) = 0;
};
}