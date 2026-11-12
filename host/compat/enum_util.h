// Host replacement for util/3rdparty/enum_util.h (found first through -I host/compat, see scripts/build.ts).
//
// The firmware header finds the valid enumerators of an enum from __PRETTY_FUNCTION__ and treats any '(' after "TValue = " as
// "not an enumerator". That is the arm-gcc spelling. Clang prints the namespace of an enum in an anonymous namespace as
// "(anonymous namespace)::", so every value looks invalid and EnumMax<ChipParamId> comes out as 127 instead of 24. Same API,
// but an invalid value is recognised the way both compilers print it: a cast ending in a number, "(Type)25".
#pragma once

#include <algorithm>
#include <climits>
#include <cstdint>
#include <type_traits>
#include <utility>

namespace enumutil
{
template<typename T, T V>
constexpr bool enumValid()
{
    const char* f = __PRETTY_FUNCTION__;
    const char* end = f;
    while (*end)
    {
        ++end;
    }
    while (end > f && end[-1] != ']' && end[-1] != '\0')
    {
        --end; // stop on the closing bracket of "[T = ..., V = ...]" (gcc: "; T = ...]" has it too)
    }
    if (end == f)
    {
        return true;
    }
    const char* p = end - 1; // the ']'
    int digits = 0;
    while (p > f && ((p[-1] >= '0' && p[-1] <= '9') || p[-1] == '-'))
    {
        --p;
        ++digits;
    }
    return !(digits > 0 && p > f && p[-1] == ')');
}

template<typename T, int... I>
constexpr auto enumMax(std::integer_sequence<int, I...>)
{
    int m = INT_MIN;
    ((enumValid<T, static_cast<T>(I - 128)>() ? (m = std::max(m, I - 128)) : 0), ...);
    return static_cast<typename std::underlying_type<T>::type>(m);
}

template<typename T, int... I>
constexpr auto enumMin(std::integer_sequence<int, I...>)
{
    int m = INT_MAX;
    ((enumValid<T, static_cast<T>(I - 128)>() ? (m = std::min(m, I - 128)) : 0), ...);
    return static_cast<typename std::underlying_type<T>::type>(m);
}

template<typename T>
struct EnumMin
{
    static constexpr typename std::underlying_type<T>::type value = enumMin<T>(std::make_integer_sequence<int, 256>{});
};

template<typename T>
struct EnumMax
{
    static constexpr typename std::underlying_type<T>::type value = enumMax<T>(std::make_integer_sequence<int, 256>{});
};
} // namespace enumutil
