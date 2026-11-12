#pragma once

#include <functional>
#include <memory>

#include "MidiEvent.h"

namespace polysynth
{

/**
 * Grid is an abstraction of the grid of input pads.
 *
 * It allows clients to subscribe to input events,
 * and the platform to feed the events.
 * The events are dispatched during updateAudio call stack.
 */
class Grid
{
  public:
    struct PadEvent
    {
        enum class Type : uint8_t
        {
            kPressed,
            kReleased,
            kForceChanged,
        };
        Type type : 6;

        enum class PlayMode : uint8_t
        {
            kUsePadConfig,
            kForceOneShot,
            kForceSequence
        };

        PlayMode playMode : 2;

        uint8_t row;
        uint8_t column;
        uint8_t force;

        static const int kRows;
        static const int kColumns;

        static constexpr uint8_t kMaxForce = 255;

        bool operator==(const PadEvent&) const = default;
    };
    // optimize for parameter passing in a register
    static_assert(sizeof(PadEvent) <= sizeof(int));

    using PadEventCallback = std::function<void(const PadEvent& event)>;

    /**
     * Enqueue an event to be processed in the audio thread.
     */
    virtual void enqueuePadEvent(const PadEvent& event) = 0;

    /**
     * Subscribe to pad events, the callback is called from the audio thread.
     */
    virtual void subscribePadEvents(std::weak_ptr<PadEventCallback> callback) = 0;

    virtual ~Grid() = default;
};

}
