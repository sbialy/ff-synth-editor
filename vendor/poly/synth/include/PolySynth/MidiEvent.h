#pragma once

#include "Core.h"

#include <cstdint>
#include <cstring>
#include <variant>

namespace polysynth
{
struct MidiEvent
{
    enum class Type : uint8_t
    {
        kClock,            // data: void
        kStart,            // data: void
        kStop,             // data: void
        kContinue,         // data: void
        kNoteOn,           // data: Note
        kNoteOff,          // data: Note
        kControlChange,    // data: ControlChange
        kProgramChange,    // data: ProgramChange
        kPitchBendChange,  // data: PitchBendChange
        kPolyAftertouch,   // data: Note
        kChannelAftertouch // data: ChannelAftertouch
    };

    Type type;
    uint8_t channel;

    static constexpr uint8_t kChannelsPerPort = 16;
    static constexpr uint8_t kChannelOmni = 255;

    union Data
    {
        struct Note
        {
            uint8_t note;
            uint8_t velocity;

            static constexpr uint8_t kMaxVelocity = 127;

            bool operator==(const Note&) const = default;
        } note;

        struct ControlChange
        {
            uint8_t id;
            uint8_t value;

            static constexpr uint8_t kMinId = 0;
            static constexpr uint8_t kMaxId = 127;
            static constexpr uint8_t kMinValue = 0;
            static constexpr uint8_t kMidValue = 63;
            static constexpr uint8_t kMaxValue = 127;
            static constexpr uint8_t kBankChangeCC = 0;
            static constexpr uint8_t kAllNotesOffCC = 123;

            bool operator==(const ControlChange&) const = default;
        } controlChange;

        struct ProgramChange
        {
            uint8_t value;

            bool operator==(const ProgramChange&) const = default;
        } programChange;

        struct PitchBendChange
        {
            int16_t value;

            static constexpr int16_t kMinValue = -8192;
            static constexpr int16_t kMaxValue = 8191;
            bool operator==(const PitchBendChange&) const = default;
        } pitchBendChange;

        struct RawData
        {
            uint8_t value1;
            uint8_t value2;

            bool operator==(const RawData&) const = default;
        } rawData;

        struct ChannelAftertouch
        {
            uint8_t velocity;

            bool operator==(const ChannelAftertouch&) const = default;
        } channelAftertouch;

        bool operator==(const Data& other) const
        {
            // NOLINTNEXTLINE(bugprone-suspicious-memory-comparison)
            return std::memcmp(this, &other, sizeof(other)) == 0;
        };

    } data;

    bool operator==(const MidiEvent&) const = default;
};

// using union in MidiEvent to fit in a register
// to optimize parameter passing and memory use.
static_assert(sizeof(MidiEvent) <= sizeof(int));
}
