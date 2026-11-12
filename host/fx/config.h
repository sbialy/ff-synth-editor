// Stand-in for the firmware's core/config/config.h, for the vendored audio library in vendor/fx (the delay, the reverb, the mixers: scripts/vendor-fx.sh).
// The names are the firmware's, the interrupt masks and the memory section attributes are empty here: the editor runs one thread and plain memory.
#pragma once
#include <stdint.h>

#define DISABLE_GLOBAL_INTERRUPTS() ((void)0)
#define ENABLE_GLOBAL_INTERRUPTS()  ((void)0)
#define DMAMEM
#define AUDIO_CORE_FLASH
#define AUDIO_CORE_RAM
#define OCRAM_BSS_SECTION
#define __NOINIT(x)

#ifdef FEATURE_SYNTH
static constexpr int kSynthParts = 3;
#else
static constexpr int kSynthParts = 0;
#endif
