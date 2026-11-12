// Stand-in for the firmware's core/source/mtStructs.h: the one type the mixers need, in the firmware's numbering (SaturationType; the Dirt values 5..9 of the FF
// builds are holes here, Soft Knee is 10 in every build, see the comment at the enum in the firmware).
#pragma once
#include <stdint.h>

// The limiter's attack and release coefficients call expf(). The device's is newlib's (the fdlibm float exp), the host libm's and emscripten's differ from it in the last bit for some
// arguments (the default attack of 100 is one), so the arm64 and wasm builds call host/fx.cpp's copy of newlib's algorithm instead. The Cortex-M4F reference build
// (FX_REAL_LIBM) keeps newlib itself, test/fx-m4.test.ts compares the copy with it over a grid of arguments.
#include <cmath> // first: the macro below must not rename libm's own declaration
#ifndef FX_REAL_LIBM
float fx_expf(float x);
#define expf fx_expf
#endif

enum SaturationType
{
    kSaturationMin,
    kHardClip = kSaturationMin,
    kSoftClip,
    kSaturate,
    kOverdrive,
    kOverdrive2,
    kSoftKnee = 10,
    kSaturationTypeEnd
};

// The limiter's part of strMtProject (core/source/mtStructs.h): AudioEffectLimiter reads its settings from mtProject.values in begin(), setAttack() and setRelease().
// Same names and types as the firmware's struct. The limiter mode is a project value of the config menu (Subtle, Extreme).
const int16_t MAX_SIGNED_16BIT = 32767;

enum limiterMode
{
    limiterModeSubtle,
    limiterModeHard
};

struct strMtProject
{
    struct strValues
    {
        uint16_t limiterAttack = 100;
        float limiterRelease = 0.512;
        uint16_t limiterThreshold = 30200;
        uint8_t limiterMode = limiterModeSubtle;
        uint8_t limiterSidechain = 0;
    } values;
};
extern strMtProject mtProject;
