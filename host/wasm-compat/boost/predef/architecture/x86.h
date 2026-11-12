// wasm build only: wasm32 takes the x86 (float) branch of Patch::paramvalue_short_t, like the native host
#include_next <boost/predef/architecture/x86.h>
#if defined(__wasm__)
#undef BOOST_ARCH_X86
#define BOOST_ARCH_X86 1
#endif
