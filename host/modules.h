// Runtime modules of the wasm host (modules.cpp): the master insert chain the live block goes through, and the point after which
// no engine may arrive any more (the engine list is read once, at the first request).
#pragma once
#include "plug_wasm.h"

constexpr int kInsertSlots = 2;   // the device's Inserts page: 2 slots on the master bus
constexpr int kMixerHardClip = 0, kMixerSoftClip = 1, kMixerSoftKnee = 2;   // the Mixer column of the Inserts page
void ffmFreezeList();
bool ffmInsertsActive();
bool ffmChainActive();               // an insert runs or the mixer is not Hard Clip
void ffmChain(float* l, float* r);   // in place, a stereo 128 frame block, no-op with Hard Clip and no insert (the bus level chain, ffm_chain_buf)
void ffmEngineChain(float* l, float* r);   // the mono engine block in l: delay, reverb and track mixers (the Mixer stage), then the inserts; both sides out
