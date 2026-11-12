#pragma once

#include "PolySynth/GridMapper.h"
#include <string>
#include <vector>

namespace polysynth
{

/**
 * Storage of grid mapper configurations (presets).
 */
class GridMapperStore
{
  public:
    /**
     * Load preset of grid mapper.
     *
     * Do not call in critical section - lengthy file IO operation.
     * Synchronizes internally.
     */
    virtual bool loadPreset(GridMapper& mapper, const std::string& name) = 0;

    /**
     * Save preset of grid mapper.
     *
     * Do not call in critical section - lengthy file IO operation.
     * Synchronizes internally.
     */
    virtual bool savePreset(GridMapper& mapper, const std::string& name) = 0;

    /**
     * Lists presets
     * returns a view to the list of files. It is owned internally so if there's a need for storage
     * or processing, then copy is needed.
     * Subsequent calls to this function invalidate previous results
     */
    virtual std::vector<std::string_view> listPresets() = 0;

    virtual ~GridMapperStore() = default;
};
}
