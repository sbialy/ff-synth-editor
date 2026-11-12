// Stand-in for the firmware's libs/Audio/Audio.h (it pulls in every audio object, the editor links the delay, the reverb, the mixers and the amplifier only).
#pragma once
#include <vector>
#include "AudioStream.h"
#include "interruptsControl.h"
#define AudioNoInterrupts() DISABLE_AUDIO_INTERRUPTS()
#define AudioInterrupts()   ENABLE_AUDIO_INTERRUPTS()
#include "mixer.h"
#include "amplifier.h"
#include "analyze_rms.h"
#include "effect_shortDelay.h"
#include "effect_polyverb.h"
