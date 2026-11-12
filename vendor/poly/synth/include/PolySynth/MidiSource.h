#pragma once

#include "MidiEvent.h"

#include <functional>
#include <memory>

namespace polysynth
{
/**
 * Abstraction of a component that provides Midi events.
 *
 * Clients can subscribe to the events.
 */
class MidiSource
{
  public:
    enum class Type
    {
        kInternalKeyboard,
        kExternalPort,
    };

    static constexpr int kExternalPortSourceIdsStart = 10000;

    /**
     * @sourceId identifier of the source of the event, e.g. grid pad, or sequence track.
     *           makes it possible to associate events triggered by the same source.
     *
     */
    using MidiEventCallback = std::function<void(const MidiEvent& event, int sourceId)>;

    explicit MidiSource(Type type)
      : type(type){};
    virtual ~MidiSource() = default;

    virtual void subscribeMidiEvents(int instrumentId,
                                     std::weak_ptr<MidiEventCallback> callback) = 0;
    [[nodiscard]] Type getType() const { return type; };

  private:
    Type type;
};
}
