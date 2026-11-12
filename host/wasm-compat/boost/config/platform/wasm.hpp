// wasm build only: stand-in for upstream boost/config/platform/wasm.hpp (the vendored boost tree has no wasm platform header)
#define BOOST_PLATFORM "Wasm"
#ifdef __has_include
#if __has_include(<unistd.h>)
#  define BOOST_HAS_UNISTD_H
#endif
#endif
