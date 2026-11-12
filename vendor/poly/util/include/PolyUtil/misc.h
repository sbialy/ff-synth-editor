#pragma once

#include <algorithm>
#include <cassert>
#include <span>
#include <tiny/optional.h>
#include <type_traits>

/**
 * @brief Optimized alternative to std::optional that does not use additional
 * storage for the valid/nonempty flag.
 *
 * Hence, optional<T> has the same size as T.
 * However, it can be used only on specific types: integers, floats and pointers.
 * In other cases use std::optional.
 *
 * Warning - this optional uses special sentinel values to mark "no value" case,
 * so these can't be used as regular values (asserts guard that):
 * int - INT_MIN
 * unsigned int - UINT_MAX
 * float - quiet NAN 0x7fedcba9
 * pointers: 0xfffffffa
 *
 * For more details see ./3rdparty/tiny/README.md
 */
template<typename T>
using tiny_optional = tiny::optional_aip<T>;

template<class T>
struct SpanEmptiness
{
    static bool IsEmpty(std::span<T> const& span) noexcept
    {
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
        return reinterpret_cast<uintptr_t>(span.data()) == 0xffffffff;
    }

    static void InitializeIsEmptyFlag(std::span<T>& uninitialized) noexcept
    {
        // uninitializedPayloadMemory is a reference to an **uninitialized** payload (i.e.
        // the constructor of PayloadType has not been called, but the memory has been
        // already allocated).
        // This function is called when the optional is constructed in an empty state or
        // once it should become empty. The function must initialize the memory such that
        // the optional is considered empty, i.e. IsEmpty(uninitializedPayloadMemory) must
        // return true afterwards.
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
        ::new (&uninitialized) std::span<T>(reinterpret_cast<T*>(0xffffffff), 0);
    }

    static void PrepareIsEmptyFlagForPayload(std::span<T>& empty) noexcept {
        // This function is called just before a (non-empty) value is stored in the
        // optional. The given "emptyPayload" is currently indicating the empty state,
        // i.e. IsEmpty(emptyPayload) returns true.
        // The function must deconstruct the sentinel value in "emptyPayload" which was
        // previously constructed by InitializeIsEmptyFlag(). After this function returns,
        // the library constructs the payload. After that, IsEmpty() must return false.
        // Note: The memory pointed to by "emptyPayload" must not be freed. It is handled
        // by the library.    }
    };
};

template<typename T>
using optional_span = tiny::optional_inplace<std::span<T>, SpanEmptiness<T>>;

// NOLINTBEGIN
#define UNUSED(x) (void)(x)

#define DELETE_COPY_MOVE(ClassName)                                                                \
    ClassName(const ClassName& other) = delete;                                                    \
    ClassName(ClassName&& other) = delete;                                                         \
    ClassName& operator=(const ClassName& other) = delete;                                         \
    ClassName& operator=(ClassName&& other) = delete;
// NOLINTEND

// Convert enum class value to int with * operator
template<typename T>
constexpr auto operator*(T e) noexcept
  -> std::enable_if_t<std::is_enum<T>::value, std::underlying_type_t<T>>
{
    return static_cast<std::underlying_type_t<T>>(e);
}

template<std::ranges::input_range R, class T>
bool contains(R&& r, const T& value)
{
    return std::ranges::find(r, value) != std::ranges::end(r);
}

// NOLINTBEGIN
template<class T>
uint32_t hash(const T& data)
{
    assert(sizeof(T) % 4 == 0);

    uint32_t value = 0;
    const uint32_t* dataPtr = reinterpret_cast<const uint32_t*>(&data);

    for (std::size_t i = 0; i < sizeof(T) / 4; i++)
    {
        value ^= *dataPtr++ ^ i ^ (i << 16);
    }

    return value;
}
// NOLINTEND

// creates std::array filled with specific value
template<typename T, size_t N>
constexpr auto make_array(T value) -> std::array<T, N>
{
    std::array<T, N> a{};
    for (auto& x : a)
    {
        x = value;
    }
    return a;
}
