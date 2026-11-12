#pragma once

#include <memory>

#include "Patch.h"

namespace polysynth
{

/**
 * Pool of patches accessed using integer index.
 *
 * Other details are implementation-specific, see Synth::createPatchPool.
 */
class PatchPool
{
  public:
    /**
     * Get patch from the pool.
     *
     * Note: this function can be called from both main and audio threads,
     * there is synchronization inside.
     *
     * @param idx slot idx
     * @param patch patch object to fill with the patch from the pool.
     * If nullptr then the patch is only preloaded to the pool (if needed).
     * @param loadFromStore load the patch from store if it's not in the pool, otherwise return
     * false
     */
    virtual bool getPatch(int idx, Patch* patch, bool loadFromStore) = 0;

    /** Get patch name if the slot is occupied */
    virtual std::optional<std::string> getPatchName(int idx) = 0;

    virtual ~PatchPool() = default;
};
}
