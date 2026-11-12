#pragma once

#include "PolySynth/Synth.h"
#include "PolySynth/sdk/InstrumentType.h"

#include <map>
#include <unordered_map>

// FW_TRIM (make original SYNTH_OPEN=1 TRIM=1): std::map instead of unordered_map. The registry holds a handful of
// entries and is only looked up by id, and unordered_map drags the libstdc++ hashtable and long double math in (-856 B)
#ifdef FW_TRIM
#define POLYSYNTH_REGISTRY_MAP std::map
#else
#define POLYSYNTH_REGISTRY_MAP std::unordered_map
#endif

namespace polysynth
{

/**
 * Registry of InstrumentType instances accessed by id.
 *
 * The registry is configured in Tracker/synth/registry.cpp.
 */
class InstrumentTypeRegistry
{
  public:
    [[nodiscard]] std::shared_ptr<const InstrumentType> getInstrumentType(int typeId) const;
    void addInstrumentType(int typeId, std::unique_ptr<InstrumentType> instrumentType);

    static void registerInstrumentTypes(InstrumentTypeRegistry& registry,
                                        const Synth::Allocator& largeBuffersAlloc);

    const POLYSYNTH_REGISTRY_MAP<int, std::shared_ptr<InstrumentType>>& getInstrumentTypes() const
    {
        return instrumentTypes;
    }

  private:
    POLYSYNTH_REGISTRY_MAP<int, std::shared_ptr<InstrumentType>> instrumentTypes;
};

} // namespace polysynth
