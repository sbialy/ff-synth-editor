// The Cortex-M4F reference of the delay, reverb and limiter graph: host/fx.cpp and the firmware files of vendor/fx compiled for the device (arm-none-eabi-g++ 12.3, the 1.2.0 release
// flags with -ffp-contract=off, the REAL inline assembly of dspinst.h and Polyverb/util.h, KINETISK), run in the Unicorn Cortex-M4F emulator by run.py. The editor's arm64 and
// wasm builds are compared with its output by test/fx-m4.test.ts. No libc startup: run.py calls m4_setup, which runs the constructors, then m4_run.
#include "fx.h"

#include <cmath>
#include <cstddef>
#include <cstdint>

extern "C" {
void __libc_init_array(void);
void _exit(int) { for (;;) {} }
int _kill(int, int) { return -1; }
int _getpid(void) { return 1; }
void _init(void) {}
void _fini(void) {}
// a bump allocator in the SDRAM window for the graph's `new`s
static uint8_t gArena[1 << 20] __attribute__((aligned(8)));
static size_t gBrk = 0;
void* _sbrk(ptrdiff_t n)
{
    if (gBrk + size_t(n) > sizeof(gArena)) return (void*)-1;
    void* p = gArena + gBrk;
    gBrk += size_t(n);
    return p;
}

// run.py fills these: the parameters in fx_tool's order and the per-block changes, the input, then calls m4_run
double gCfg[21];                       // tempo delayFeedback delayTime delayParams delayFilter reverbSize reverbDamp reverbPredelay reverbDiffusion delayVolume reverbVolume delayMute reverbMute delaySend reverbSend mixer limiterOn limiterAttack limiterRelease limiterThreshold limiterMode
int32_t gBlocks;
int32_t gChgN;
double gChg[64][3];                    // block, index into gCfg, value: applied before that block, in order
float gIn[1200 * 128];
int16_t gOut[1200 * 256];

float gExp[fx::kExpfGrid];             // newlib's expf over fx::expfGrid (run.py expf)
void m4_expf(void)
{
    for (int i = 0; i < fx::kExpfGrid; i++) gExp[i] = expf(fx::expfGrid(i));
}

void m4_setup(void) { __libc_init_array(); }

void m4_run(void)
{
    fx::Params p;
    auto load = [&]() {
    p.tempo = float(gCfg[0]);
    p.delayFeedback = uint8_t(gCfg[1]);
    p.delayTime = uint16_t(gCfg[2]);
    p.delayParams = uint8_t(gCfg[3]);
    p.delayFilter = uint16_t(gCfg[4]);
    p.reverbSize = float(gCfg[5]);
    p.reverbDamp = float(gCfg[6]);
    p.reverbPredelay = float(gCfg[7]);
    p.reverbDiffusion = float(gCfg[8]);
    p.delayVolume = uint8_t(gCfg[9]);
    p.reverbVolume = uint8_t(gCfg[10]);
    p.delayMute = gCfg[11] != 0;
    p.reverbMute = gCfg[12] != 0;
    p.delaySend = float(gCfg[13]);
    p.reverbSend = float(gCfg[14]);
    p.mixer = int(gCfg[15]);
    p.limiterOn = gCfg[16] != 0;
    p.limiterAttack = uint16_t(gCfg[17]);
    p.limiterRelease = float(gCfg[18]);
    p.limiterThreshold = uint16_t(gCfg[19]);
    p.limiterMode = uint8_t(gCfg[20]);
    };
    load();
    fx::Graph* g = new fx::Graph;
    g->apply(p);
    int16_t l[fx::kBlock], r[fx::kBlock];
    for (int b = 0; b < gBlocks; b++)
    {
        bool moved = false;
        for (int c = 0; c < gChgN; c++)
        {
            if (int(gChg[c][0]) == b)
            {
                gCfg[int(gChg[c][1])] = gChg[c][2];
                moved = true;
            }
        }
        if (moved)
        {
            load();
            g->apply(p);
        }
        g->process(&gIn[b * fx::kBlock], l, r);
        for (int i = 0; i < fx::kBlock; i++)
        {
            gOut[(b * fx::kBlock + i) * 2] = l[i];
            gOut[(b * fx::kBlock + i) * 2 + 1] = r[i];
        }
    }
}
}
