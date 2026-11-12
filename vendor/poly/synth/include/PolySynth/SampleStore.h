#pragma once

#include "Core.h"

#include <optional>
#include <string_view>
#include <vector>

namespace polysynth
{
class SampleStore
{
  public:
    virtual ~SampleStore() = default;

    [[nodiscard]] virtual std::optional<Sample> loadSample(const std::string& filePath,
                                                           std::span<sample_store_t> destBuf) = 0;
    [[nodiscard]] virtual tiny_optional<int> getSampleSize(const std::string& filePath) = 0;
    [[nodiscard]] virtual std::vector<std::string_view> listSamples() = 0;
};

}