// Only on the arm64 A/B builds (POLY_FPCONTRACT, scripts/build.ts): the vendored Patch.h picks paramvalue_short_t by BOOST_ARCH_ARM (__fp16, the
// device) or BOOST_ARCH_X86 (float, the x86_64 host and every golden of this editor). This overlay hides ARM so an arm64 host keeps float and the
// only difference to the x86_64 host is the floating point contraction under test. Nothing else of the vendored tree reads these two macros.
#ifndef BOOST_PREDEF_ARCHITECTURE_ARM_H
#define BOOST_PREDEF_ARCHITECTURE_ARM_H
#include <boost/predef/version_number.h>
#define BOOST_ARCH_ARM BOOST_VERSION_NUMBER_NOT_AVAILABLE
#define BOOST_ARCH_ARM_NAME "ARM (hidden by the editor's arm64 A/B build)"
#endif
