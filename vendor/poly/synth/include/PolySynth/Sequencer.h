#pragma once

#include "PImpl.h"
#include "PolySynth/Patch.h"
#include "PolyUtil/misc.h"

namespace polysynth
{
using TempoProvider = std::function<tiny::optional<float>()>;

class SequencerEngine;

class Sequencer : public PImpl<SequencerEngine>
{
  public:
    /**
     * Sets tempo in BPMs
     * @param tempo in bpms
     */
    virtual void setTempo(float tempo) = 0;
    [[nodiscard]] virtual TempoProvider getTempoProvider() const = 0;

    virtual void setClockInternal(bool clockInternal) = 0;
    virtual void setTransportInternal(bool transportInternal) = 0;
    virtual void setClockOut(bool sendClock) = 0;
    virtual void setTransportOut(bool sendTransport) = 0;

    /**
     * Sets the sequencer to wait until incoming external start message
     * Effective only when transport set to external.
     */
    virtual void setWaitForExternalStart(bool wait) = 0;

    /**
     * plays a sequence for given instrument on a track with given trackId.
     * @param seqIdx sequence to be played (temporarily unused because we have only 1 sequence)
     * @param instrumentId instrument id for which the sequence shall be played
     * @param trackId id of a track. set arbitrarily by the client to identify the track in further
     * calls
     * @param velocity velocity of the sequence
     */
    virtual void startSequence(int seqIdx, int instrumentId, int trackId, uint8_t velocity) = 0;

    [[nodiscard]] virtual bool isStarted(int trackId) const = 0;

    /**
     * Stops playing a track with given id
     * @param trackId id of the track to be stopped
     */
    virtual void stopSequence(int trackId) = 0;

    virtual ~Sequencer() = default;
};

}
