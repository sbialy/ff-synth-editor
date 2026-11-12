#pragma once

namespace polysynth
{
/**
 * Utility for PImpl design pattern.
 */
template<class Implementation>
class PImpl
{
  public:
    /**
     * Pointer to internal base implementation class, for internal use only.
     *
     * It's public for convenience, API clients will not make use of it anyway,
     * lacking access to the class declaration.
     */
    Implementation* impl = nullptr;
};

}
