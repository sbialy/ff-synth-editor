#pragma once

#include <memory>

#include "Patch.h"

namespace polysynth
{
class PatchStore
{
  public:
    inline static const std::string kFileExtension = ".patch";

    virtual std::unique_ptr<Patch> createPatch(int instrumentTypeId) = 0;

    /**
     * Lists patches.
     *
     * Returns a view to the list of names. It is owned internally so if there's a need for storage
     * or processing, then copy is needed.
     * Subsequent calls to this function invalidate previous results.
     */
    virtual std::vector<std::pair<std::string_view, int>> listPatchesFilter(
      std::function<bool(InstrumentTypeId)> filter) = 0;

    virtual std::vector<std::string_view> listPatchesByType(int typeId) = 0;

    virtual bool loadPatch(const std::string& name, Patch& patch, bool synchronizeAudio) = 0;
    virtual bool savePatch(const std::string& name, const Patch& patch) = 0;
    virtual std::optional<InstrumentTypeId> loadPatchInstrumentType(const std::string& name) = 0;

    virtual ~PatchStore() = default;
};
}
