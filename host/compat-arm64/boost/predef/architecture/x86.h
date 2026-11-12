// See arm.h next to this file: reports x86 on arm64 so Patch.h keeps paramvalue_short_t = float.
#ifndef BOOST_PREDEF_ARCHITECTURE_X86_H
#define BOOST_PREDEF_ARCHITECTURE_X86_H
#include <boost/predef/version_number.h>
#define BOOST_ARCH_X86 BOOST_VERSION_NUMBER_AVAILABLE
#define BOOST_ARCH_X86_AVAILABLE
#define BOOST_ARCH_X86_NAME "Intel x86 (reported by the editor's arm64 A/B build)"
#endif
