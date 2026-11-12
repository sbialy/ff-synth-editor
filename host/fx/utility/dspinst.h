// Stand-in for the firmware's libs/Audio/utility/dspinst.h (kept byte for byte in vendor/fx/arm/utility/dspinst.h, which the Cortex-M4 reference build uses).
// The firmware writes these as single Cortex-M4 DSP instructions in inline assembly. This file gives each one in portable C with the instruction's
// definition (ARMv7-M architecture reference manual), for the arm64 and wasm builds of the editor. Only the functions whose assembly has no C
// branch in the firmware's own file are new, the ones with a KINETISL branch use that branch's expression. test/fx.test.ts checks every
// function against the instruction's definition written out in 64 bit integer arithmetic.
#ifndef dspinst_h_
#define dspinst_h_

#include <stdint.h>

namespace fxarm
{
inline int32_t sat(int64_t v, int bits)
{
    const int64_t hi = (int64_t(1) << (bits - 1)) - 1, lo = -(int64_t(1) << (bits - 1));
    return int32_t(v > hi ? hi : (v < lo ? lo : v));
}
inline int16_t lo16(uint32_t v) { return int16_t(v & 0xFFFF); }
inline int16_t hi16(uint32_t v) { return int16_t(v >> 16); }
inline uint32_t pack(int32_t hi, int32_t lo) { return (uint32_t(hi) << 16) | (uint32_t(lo) & 0xFFFF); }
} // namespace fxarm

// ssat Rd, #bits, Rn, asr #rshift
static inline int32_t signed_saturate_rshift(int32_t val, int bits, int rshift) { return fxarm::sat(int64_t(val >> rshift), bits); }
// ssat Rd, #16, Rn
static inline int16_t saturate16(int32_t val) { return int16_t(fxarm::sat(val, 16)); }
// smulwb: (a * b[15:0]) >> 16, smulwt: (a * b[31:16]) >> 16
static inline int32_t signed_multiply_32x16b(int32_t a, uint32_t b) { return int32_t((int64_t(a) * fxarm::lo16(b)) >> 16); }
static inline int32_t signed_multiply_32x16t(int32_t a, uint32_t b) { return int32_t((int64_t(a) * fxarm::hi16(b)) >> 16); }
// smmul, smmulr, smmlar, smmlsr
static inline int32_t multiply_32x32_rshift32(int32_t a, int32_t b) { return int32_t((int64_t(a) * b) >> 32); }
static inline int32_t multiply_32x32_rshift32_rounded(int32_t a, int32_t b) { return int32_t((int64_t(a) * b + 0x80000000LL) >> 32); }
static inline int32_t multiply_accumulate_32x32_rshift32_rounded(int32_t sum, int32_t a, int32_t b)
{
    return int32_t(((int64_t(sum) << 32) + int64_t(a) * b + 0x80000000LL) >> 32);
}
static inline int32_t multiply_subtract_32x32_rshift32_rounded(int32_t sum, int32_t a, int32_t b)
{
    return int32_t(((int64_t(sum) << 32) - int64_t(a) * b + 0x80000000LL) >> 32);
}
// pkhtb ..., asr #16 / pkhtb / pkhbt ..., lsl #16
static inline uint32_t pack_16t_16t(int32_t a, int32_t b) { return (uint32_t(a) & 0xFFFF0000u) | (uint32_t(b) >> 16); }
static inline uint32_t pack_16t_16b(int32_t a, int32_t b) { return (uint32_t(a) & 0xFFFF0000u) | (uint32_t(b) & 0xFFFFu); }
static inline uint32_t pack_16b_16b(int32_t a, int32_t b) { return (uint32_t(a) << 16) | (uint32_t(b) & 0xFFFFu); }
// qadd16, qsub16, shadd16, shsub16
static inline uint32_t signed_add_16_and_16(uint32_t a, uint32_t b)
{
    return fxarm::pack(fxarm::sat(int32_t(fxarm::hi16(a)) + fxarm::hi16(b), 16), fxarm::sat(int32_t(fxarm::lo16(a)) + fxarm::lo16(b), 16));
}
static inline int32_t signed_subtract_16_and_16(int32_t a, int32_t b)
{
    return int32_t(fxarm::pack(fxarm::sat(int32_t(fxarm::hi16(a)) - fxarm::hi16(b), 16), fxarm::sat(int32_t(fxarm::lo16(a)) - fxarm::lo16(b), 16)));
}
static inline int32_t signed_halving_add_16_and_16(int32_t a, int32_t b)
{
    return int32_t(fxarm::pack((int32_t(fxarm::hi16(a)) + fxarm::hi16(b)) >> 1, (int32_t(fxarm::lo16(a)) + fxarm::lo16(b)) >> 1));
}
static inline int32_t signed_halving_subtract_16_and_16(int32_t a, int32_t b)
{
    return int32_t(fxarm::pack((int32_t(fxarm::hi16(a)) - fxarm::hi16(b)) >> 1, (int32_t(fxarm::lo16(a)) - fxarm::lo16(b)) >> 1));
}
// smlawb, smlawt: sum + ((a * b[15:0 or 31:16]) >> 16), wrapping in 32 bit
static inline int32_t signed_multiply_accumulate_32x16b(int32_t sum, int32_t a, uint32_t b) { return int32_t(uint32_t(sum) + uint32_t((int64_t(a) * fxarm::lo16(b)) >> 16)); }
static inline int32_t signed_multiply_accumulate_32x16t(int32_t sum, int32_t a, uint32_t b) { return int32_t(uint32_t(sum) + uint32_t((int64_t(a) * fxarm::hi16(b)) >> 16)); }
static inline uint32_t logical_and(uint32_t a, uint32_t b) { return a & b; }
// smuad, smuadx, smlald, smlaldx
static inline int32_t multiply_16tx16t_add_16bx16b(uint32_t a, uint32_t b)
{
    return int32_t(uint32_t(int32_t(fxarm::lo16(a)) * fxarm::lo16(b)) + uint32_t(int32_t(fxarm::hi16(a)) * fxarm::hi16(b)));
}
static inline int32_t multiply_16tx16b_add_16bx16t(uint32_t a, uint32_t b)
{
    return int32_t(uint32_t(int32_t(fxarm::lo16(a)) * fxarm::hi16(b)) + uint32_t(int32_t(fxarm::hi16(a)) * fxarm::lo16(b)));
}
static inline int64_t multiply_accumulate_16tx16t_add_16bx16b(int64_t sum, uint32_t a, uint32_t b)
{
    return int64_t(uint64_t(sum) + uint64_t(int64_t(fxarm::lo16(a)) * fxarm::lo16(b) + int64_t(fxarm::hi16(a)) * fxarm::hi16(b)));
}
static inline int64_t multiply_accumulate_16tx16b_add_16bx16t(int64_t sum, uint32_t a, uint32_t b)
{
    return int64_t(uint64_t(sum) + uint64_t(int64_t(fxarm::lo16(a)) * fxarm::hi16(b) + int64_t(fxarm::hi16(a)) * fxarm::lo16(b)));
}
// smulbb, smulbt, smultb, smultt
static inline int32_t multiply_16bx16b(uint32_t a, uint32_t b) { return int32_t(fxarm::lo16(a)) * fxarm::lo16(b); }
static inline int32_t multiply_16bx16t(uint32_t a, uint32_t b) { return int32_t(fxarm::lo16(a)) * fxarm::hi16(b); }
static inline int32_t multiply_16tx16b(uint32_t a, uint32_t b) { return int32_t(fxarm::hi16(a)) * fxarm::lo16(b); }
static inline int32_t multiply_16tx16t(uint32_t a, uint32_t b) { return int32_t(fxarm::hi16(a)) * fxarm::hi16(b); }
// qsub
static inline int32_t substract_32_saturate(uint32_t a, uint32_t b) { return fxarm::sat(int64_t(int32_t(a)) - int32_t(b), 32); }
// the sticky Q flag is not modelled (nothing in the editor's graph reads it)
static inline uint32_t get_q_psr(void) { return 0; }
static inline void clr_q_psr(void) {}
// smull + shifts of the firmware's KINETISK branch: bits [62 - z .. 31 - z] of the product, the C branch of the firmware
static inline int32_t multiply_32x32_rshift(int32_t x, int32_t y, int z) { return ((int64_t)x * y) >> (31 - z); }

#endif
