#pragma once

#include "Core.h"
#include "Grid.h"
#include "MidiEvent.h"
#include "MidiSource.h"
#include "Musicology.h"
#include "PolySynth/config.h"

#include <boost/container/static_vector.hpp>
#include <optional>

namespace polysynth
{
/**
 * Mapping of grid pad events to Midi events,
 * based on custom configuration.
 *
 * The mapper subscribes to pad events using the Grid API.
 * It feeds Midi events over the MidiSource API.
 */
class GridMapper : public MidiSource
{
  public:
    /**
     * Be careful when passing objects of this class by value or copying it.
     * The objects are large, order of hundreds of bytes, because of
     * the sequence member.
     */
    struct PadConfig
    {
      public:
        static constexpr int kSeqMaxLength = kMaxSequenceLength;
        static constexpr int kDefaultVelocity = 100;
        Musicology::Chord chord{ Musicology::rootNoteChordScheme(), 0 };
        Musicology::Scale scale{ Musicology::kChromaticScale, 0 };
        int instrument = 0;
        bool operator==(const PadConfig&) const = default;
    };

    GridMapper()
      : MidiSource(MidiSource::Type::kInternalKeyboard){};

    virtual void connect(Grid& grid) = 0;
    [[nodiscard]] virtual const std::optional<PadConfig>& getPadConfig(int row,
                                                                       int column) const = 0;
    virtual void setPadConfig(int row, int column, const PadConfig& config) = 0;
    virtual void clearPadConfig(int row, int column) = 0;
    virtual void clearAllPadsConfig() = 0;

    virtual void setScale(const Musicology::Scale& scale_) = 0;
    [[nodiscard]] virtual const Musicology::Scale& getScale() const = 0;
};
}
