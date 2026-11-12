// Stand-in for the firmware's product config.h that core/synth/engines/ChiptuneSynthVoice.cpp includes: the file is only
// compiled when FEATURE_SYNTH is set. Everything else comes from vendor/poly/synth/include/PolySynth/config.h.
#pragma once
#define FEATURE_SYNTH 1
