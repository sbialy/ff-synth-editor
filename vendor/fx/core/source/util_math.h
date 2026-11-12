#ifndef SOURCE_UTIL_MATH_H_
#define SOURCE_UTIL_MATH_H_
#include "stdint.h"

template<class T>
constexpr const T& clamp(const T& v, const T& lo, const T& hi)
{
    return (v < lo) ? lo : (hi < v) ? hi : v;
}

template<class T>
constexpr const T& wrap(const T& v, const T& lo, const T& hi)
{
    return (v < lo) ? hi : (hi < v) ? lo : v;
}

template<class T>
constexpr const T map(const T& v, const T& in_lo, const T& in_hi, const T& out_lo, const T& out_hi)
{
    return (v - in_lo) * (out_hi - out_lo) / (in_hi - in_lo) + out_lo;
}

template<class T>
constexpr const T mapClamped(const T& v,
                             const T& in_lo,
                             const T& in_hi,
                             const T& out_lo,
                             const T& out_hi)
{
    return map(in_lo > in_hi ? clamp(v, in_hi, in_lo) : clamp(v, in_lo, in_hi),
               in_lo,
               in_hi,
               out_lo,
               out_hi);
}

template<typename T>
bool isOutOfRange(const T& value, const T& lowestValue, const T& highestValue)
{
    return value < lowestValue || value > highestValue;
}

namespace utilMathRandom
{
int32_t random(void);
uint32_t random(uint32_t howbig);
int32_t random(int32_t howsmall, int32_t howbig);
void randomSeed(uint32_t newseed);
void srandom(unsigned int newseed);
}
#endif /* SOURCE_UTIL_MATH_H_ */
