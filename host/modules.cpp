// Runtime modules of the wasm host (scripts/build-wasm.ts, target "runtime"): synth engines and master inserts that arrive as .wasm
// files at run time (host/sdk/plug_wasm.h) instead of being linked in. public/ffmod.js loads a module into this host's memory and
// function table and hands its plug_desc to the functions below. Nothing here knows any engine's DSP.
//
// Synth engine: the firmware's PLUG_EXT_SYNTH extension behind an ot::audio::ISynthEngine adapter, its metadata copied into the
// engine definition the shim already has a slot for. The vendored tracker-ff 1.1.0 shim has a static engine list (engine_list.h),
// so an engine that can arrive at run time (PHZ, PLK, JU6, kSpecs below) keeps its list entry and its numbers (public, engine_list.h) and only its definition is
// filled here (host/runtime_def.cpp holds the empty one). tracker-ff 1.2.0 has a run time list (open::engineListAdd): once vendor/
// moves to it, the engine is added there instead and runtime_def.cpp goes away.
//
// Master inserts: two slots on the master bus after the engine, in order (engine -> insert 1 -> insert 2 -> out), with the
// firmware's own block math (synth-open/plug_insert.cpp, AudioEffectPlug::update): the bus is int16 on the device, so the block is
// converted to float as int16 / 32768, every slot runs in place on the stereo float block, and the result goes back to int16 by
// truncation with a clamp. With no insert the block passes untouched (the device: the blocks pass untouched too).
//
// The Mixer stage of the device's Inserts page (Hard Clip, Soft Clip, Soft Knee) sits in front of the inserts: on the device the track
// mixers narrow their int32 sum to int16 with the picked saturation type, and the master inserts read that int16 bus
// (core/AudioEngine/mtAudioEngine.cpp connectMixerToOutput + setSaturationType). So the first float -> int16 step of the chain is the
// mixer, the step after the last insert stays the plain truncation and clamp of the plugin node. Hard Clip with no insert leaves the block
// alone, as before.
//
// The master limiter (the Tracker's AudioEffectLimiter, host/fx.cpp) follows the inserts, as in AudioOutput: tracks and sends mixers -> inserts -> limiters -> final mixer.
// The inserts run inside the firmware's graph (fx::InsertStage), so the limiter sees the block they leave. Off (the editor's default), the limiter is out of the path and the
// signal is what the inserts leave.
#include "modules.h"

#include "fx.h"
#include "open_engine.h"
#include "ot/audio/synth_engine.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <emscripten/emscripten.h>

namespace polysynth::open
{
#define SYNTH_ENGINE(NAME, STORED, TYPE_ID, FACTORY, DEF, ...) extern const EngineDef DEF;
#include "engine_list.h"
#undef SYNTH_ENGINE
} // namespace polysynth::open

namespace
{
using namespace ot::audio;
namespace open = polysynth::open;

// ---- the host table (plug_host): the host's own libm, so a module calls the very functions the linked-in engines call
void* hostAlloc(uint32_t bytes, uint32_t) { return std::calloc(1, bytes ? bytes : 1); }
uint32_t hostCycles() { return 0; }
const void* hostQuery(uint32_t) { return nullptr; }
float fSin(float x) { return sinf(x); }
float fCos(float x) { return cosf(x); }
float fTan(float x) { return tanf(x); }
float fTanh(float x) { return tanhf(x); }
float fExp(float x) { return expf(x); }
float fLog(float x) { return logf(x); }
float fPow(float x, float y) { return powf(x, y); }
float fExp2(float x) { return exp2f(x); }
float fLog2(float x) { return log2f(x); }
void* fMemcpy(void* d, const void* s, size_t n) { return std::memcpy(d, s, n); }
void* fMemset(void* d, int c, size_t n) { return std::memset(d, c, n); }
const plug_host kHost = { sizeof(plug_host), PLUG_HOST_LEVEL, 44117.647f, fSin, fCos, fTan, fTanh, fExp, fLog, fPow, fMemcpy, fMemset,
                          hostAlloc, hostCycles, hostQuery, fExp2, fLog2 };

// ---- synth engines
class Adapter final : public ISynthEngine
{
  public:
    const plug_ext_synth* x = nullptr;
    int32_t id() const override { return x->type_id; }
    const char* name() const override { return x->name; }
    void prepare(SynthSlotScratch& sc, const SynthParams& p) override
    {
        if (x->prepare) x->prepare(&sc, &p);
    }
    void slotReset(SynthSlotScratch& sc) override
    {
        if (x->slot_reset) x->slot_reset(&sc);
    }
    void setTempo(float bpm) override
    {
        if (x->set_tempo) x->set_tempo(bpm);
    }
    bool setSendTap(int slot, float* d, float* r, float gd, float gr) override
    {
        return x->set_send_tap ? x->set_send_tap(slot, d, r, gd, gr) != 0 : false;
    }
    void noteOn(SynthVoice& v, const SynthParams& p, const SynthNote& n) override { x->note_on(&v, &p, &n); }
    void noteOff(SynthVoice& v, const SynthParams& p) override { x->note_off(&v, &p); }
    bool render(SynthVoice& v, const SynthParams& p, float g0, float gInc, float* l, float* r) override
    {
        return x->render(&v, &p, g0, gInc, l, r) != 0;
    }
    bool slotPost(int slot, SynthSlotScratch& sc, const SynthParams& p, float* l, float* r) override
    {
        return x->slot_post ? x->slot_post(slot, &sc, &p, l, r) != 0 : false;
    }
};

struct RuntimeEngine
{
    open::EngineDef* def = nullptr;   // the list entry's definition (runtime_def.cpp, mutable)
    Adapter adapter;
    open::ParamDef params[84];        // kSynthParamMax: the metadata in the shim's own types (the format numbers differ, below)
};

// The engines this host lets arrive at run time, one slot each: the public numbers of engine_list.h (the shim's list keeps their entries)
// and the definition of host/runtime_def.cpp, in the same order. PHZ and PLK are our own (closed source), JU6 is a public
// OpenTracker port: the loader does not tell them apart.
struct RuntimeSpec
{
    const char* name;
    int typeId;
    int stored;
    int patchEngine;
};
constexpr RuntimeSpec kSpecs[] = { { "PHZ", 0x82, 8, 0x82 }, { "PLK", 0x8A, 18, 0x8A }, { "JU6", 0x81, 7, 0x81 } };
constexpr int kRuntimeEngines = sizeof(kSpecs) / sizeof(kSpecs[0]);
RuntimeEngine gEngines[kRuntimeEngines];
bool gListFrozen = false;

// EngineDef::engine is a plain function pointer (no context): one function per slot
template <int I>
ISynthEngine* engineAt()
{
    return gEngines[I].def && gEngines[I].adapter.x ? &gEngines[I].adapter : nullptr;
}
ISynthEngine* (*const kEngineFns[kRuntimeEngines])() = { engineAt<0>, engineAt<1>, engineAt<2> };

// PLUG_FMT_* -> open::Fmt. The numbers are frozen for the plugin ABI (0 .. 14 as the shim's, 15 = PLUG_FMT_UNIT), the shim of
// tracker-ff 1.1.0 puts kUnit after PERC's two formats, so 15 is mapped by name.
bool fmtOf(uint8_t f, open::Fmt& out)
{
    if (f < PLUG_FMT_UNIT)
    {
        out = static_cast<open::Fmt>(f);
        return true;
    }
#ifdef SYNTH_ENGINE_PHZ
    if (f == PLUG_FMT_UNIT)
    {
        out = open::Fmt::kUnit;
        return true;
    }
#endif
    return false;
}

// ---- master inserts
struct Slot
{
    const plug_desc* desc = nullptr;
    void* inst = nullptr;
    bool bypass = false;
};
Slot gSlots[kInsertSlots];
float gBuf[2][128];
int gMixer = kMixerHardClip;

// The master inserts as the graph's AudioEffectPlug node (host/fx.cpp InsertNode): the int16 block in float, every running slot in place, back to int16 by truncation and clamp
// (synth-open/plug_insert.cpp AudioEffectPlug::update)
bool insertsRunning()
{
    for (const Slot& s : gSlots)
    {
        if (s.desc && !s.bypass) return true;
    }
    return false;
}
void insertsRun(int16_t* left, int16_t* right)
{
    int16_t* blk[2] = { left, right };
    float* io[2] = { gBuf[0], gBuf[1] };
    for (int c = 0; c < 2; c++)
        for (int i = 0; i < 128; i++) gBuf[c][i] = float(blk[c][i]) * (1.0f / 32768.0f);
    for (Slot& s : gSlots)
    {
        if (s.desc && !s.bypass) s.desc->process(s.inst, io, 2, 128);
    }
    for (int c = 0; c < 2; c++)
    {
        for (int i = 0; i < 128; i++)
        {
            int32_t v = int32_t(gBuf[c][i] * 32768.0f);
            blk[c][i] = int16_t(v > 32767 ? 32767 : (v < -32768 ? -32768 : v));
        }
    }
}
const fx::InsertStage kInsertStage = { insertsRunning, insertsRun };

// ---- the delay, reverb and limiter graph of host/fx.cpp, built at the first use (1.6 MB of delay lines)
fx::Params gFxParams;
float gFxArr[24];
fx::Graph* gFx = nullptr;
fx::Graph& fxGraph()
{
    if (!gFx)
    {
        gFx = new fx::Graph;
        gFx->setInserts(&kInsertStage);
        gFxParams.mixer = gMixer == kMixerSoftClip ? 1 : (gMixer == kMixerSoftKnee ? 10 : 0);
        gFx->apply(gFxParams);
    }
    return *gFx;
}
void fxMixerChanged()
{
    gFxParams.mixer = gMixer == kMixerSoftClip ? 1 : (gMixer == kMixerSoftKnee ? 10 : 0);
    if (gFx) gFx->apply(gFxParams);
}
// something to hear from the graph: a send above zero, a Mixer other than Hard Clip, the limiter, or a tail still ringing
bool fxEngaged()
{
    if (gFx) return gFx->active();
    return gFxParams.delaySend > 0 || gFxParams.reverbSend > 0 || gMixer != kMixerHardClip || gFxParams.limiterOn;
}

// The mixer's saturate() of the firmware (core/libs/Audio/dspApplyGain.cpp) on one int32 sample in int16 units.
// multiply_32x32_rshift(x, y, z) of core/libs/Audio/utility/dspinst.h is (x * y) >> (31 - z).
inline int32_t mulShift(int32_t x, int32_t y, int z) { return int32_t((int64_t(x) * y) >> (31 - z)); }
inline int16_t clamp16(int32_t v) { return int16_t(v > 32767 ? 32767 : (v < -32768 ? -32768 : v)); }
inline int16_t softClip(int32_t in)
{   // out = in - in^3 / 6.72 (set experimentally in the firmware)
    return clamp16(in - mulShift(mulShift(mulShift(in, in, 16), in, 16), int32_t((1 << 16) / 6.72f), 15));
}
inline int16_t softKnee(int32_t x)
{   // synth-open/sat_softknee.h: passthrough up to K = 23197 (-3 dBFS), K + R - R^2 / (R + |x| - K) above, R = 32767 - K
    constexpr int32_t kKnee = 23197, kRoom = 32767 - kKnee;
    constexpr uint32_t kRoom2 = uint32_t(kRoom) * uint32_t(kRoom);
    const uint32_t a = x < 0 ? 0u - uint32_t(x) : uint32_t(x);
    if (a <= uint32_t(kKnee)) return int16_t(x);
    const int32_t y = kKnee + kRoom - int32_t(kRoom2 / (uint32_t(kRoom) + (a - uint32_t(kKnee))));
    return int16_t(x < 0 ? -y : y);
}
inline int16_t mixerStage(float v)
{   // the engine sample as the mixer's int32 accumulator (truncated like the plugin node's output step), then the picked saturation type
    const float s = v * 32768.0f;
    const int32_t in = s >= 2147483520.0f ? 2147483520 : (s <= -2147483648.0f ? INT32_MIN : int32_t(s));
    switch (gMixer)
    {
        case kMixerSoftClip: return softClip(in);
        case kMixerSoftKnee: return softKnee(in);
        default: return clamp16(in);
    }
}

void freeSlot(Slot& s)
{
    std::free(s.inst);
    s = Slot{};
}
} // namespace

#ifdef FFM_RUNTIME
// The placeholder definitions of runtime_def.cpp, filled by ffm_attach_synth (defined there without const), same order as kSpecs
polysynth::open::EngineDef& runtimeDef(int slot);
#endif

extern "C"
{
EMSCRIPTEN_KEEPALIVE const plug_host* ffm_host() { return &kHost; }
EMSCRIPTEN_KEEPALIVE uint32_t ffm_abi() { return (PLUG_ABI_MAJOR << 16) | PLUG_ABI_MINOR; }
EMSCRIPTEN_KEEPALIVE uint32_t ffm_wasm_abi() { return PLUG_WASM_ABI; }
EMSCRIPTEN_KEEPALIVE uint32_t ffm_host_level() { return PLUG_HOST_LEVEL; }

// 0 ok, else an error code (ffmod.js has the texts): 1 list in use, 2 not a synth, 3 no extension, 4 layout, 5 numbers, 6 too many
// params, 7 a format this host lacks, 8 no slot for the engine, 9 the engine is attached already
EMSCRIPTEN_KEEPALIVE int ffm_attach_synth(const plug_desc* d)
{
#ifndef FFM_RUNTIME
    (void)d;
    (void)kEngineFns;
    return 8;   // the linked target: every engine is linked in, none may arrive
#else
    if (gListFrozen) return 1;
    if (!d || d->struct_size < offsetof(plug_desc, query) + sizeof(d->query) || d->kind != PLUG_KIND_SYNTH) return 2;
    const auto* x = d->query ? static_cast<const plug_ext_synth*>(d->query(PLUG_EXT_SYNTH)) : nullptr;
    if (!x || x->struct_size < sizeof(plug_ext_synth)) return 3;
    if (x->layout != PLUG_SYNTH_LAYOUT(sizeof(SynthVoice), sizeof(SynthParams), sizeof(SynthNote), sizeof(SynthSlotScratch))) return 4;
    int slot = -1;
    for (int i = 0; i < kRuntimeEngines; i++)
    {
        if (x->type_id == kSpecs[i].typeId && std::strcmp(x->name, kSpecs[i].name) == 0) slot = i;
    }
    if (slot < 0) return 8;
    open::EngineDef& def = runtimeDef(slot);
    const RuntimeSpec& sp = kSpecs[slot];
    if (def.typeId != sp.typeId || std::strcmp(def.name, sp.name) != 0) return 8;   // runtime_def.cpp and kSpecs disagree
    if (gEngines[slot].adapter.x) return 9;
    if (x->type_id != sp.typeId || x->patch_engine != sp.patchEngine || x->stored != sp.stored) return 5;   // engine_list.h
    if (x->param_count > 84 || x->section_count > 10 || x->macro_count > 6 || x->max_voices < 1 || x->max_voices > 4) return 6;
    RuntimeEngine& e = gEngines[slot];
    for (uint32_t i = 0; i < x->param_count; i++)
    {
        const plug_synth_param& p = x->params[i];
        open::ParamDef& q = e.params[i];
        q.name = p.name;
        q.def = p.def;
        q.min = p.min;
        q.max = p.max;
        if (!fmtOf(p.fmt, q.fmt)) return 7;
        q.curve = static_cast<open::CurveKind>(p.curve);
        q.enumNames = p.enum_names;
    }
    static_assert(sizeof(open::SectionDef) == sizeof(plug_synth_section), "SectionDef is plug_synth_section");
    static_assert(sizeof(open::MacroDef) == sizeof(plug_synth_macro), "MacroDef is plug_synth_macro");
    e.adapter.x = x;
    e.def = &def;
    def.params = e.params;
    def.paramCount = int(x->param_count);
    def.sections = reinterpret_cast<const open::SectionDef*>(x->sections);
    def.sectionCount = int(x->section_count);
    def.macros = reinterpret_cast<const open::MacroDef*>(x->macros);
    def.macroCount = int(x->macro_count);
    def.volumeParam = x->volume_param;
    def.maxVoices = int(x->max_voices);
    def.slotFx = (x->flags & PLUG_SYNTH_SLOT_FX) != 0;
    def.engine = kEngineFns[slot];
    if (x->work_bytes && x->set_work) x->set_work(std::calloc(1, x->work_bytes), x->work_bytes);
    return 0;
#endif
}

// 0 ok: 1 slot, 2 not a master insert, 3 init failed, 4 too many params. d = NULL empties the slot.
EMSCRIPTEN_KEEPALIVE int ffm_insert_set(int slot, const plug_desc* d)
{
    if (slot < 0 || slot >= kInsertSlots) return 1;
    freeSlot(gSlots[slot]);
    if (!d) return 0;
    if (d->struct_size < offsetof(plug_desc, process) + sizeof(d->process) || d->kind != PLUG_KIND_MASTER_INSERT || !d->process || !d->init) return 2;
    if (d->num_params > 32) return 4;
    void* inst = std::aligned_alloc(8, (d->instance_size + 7u) & ~7u);
    std::memset(inst, 0, d->instance_size);
    if (d->init(inst, &kHost) != 0)
    {
        std::free(inst);
        return 3;
    }
    gSlots[slot] = Slot{ d, inst, false };
    return 0;
}

// Block start, as the device: the host applies the latest value of a parameter before the slot's next process()
EMSCRIPTEN_KEEPALIVE void ffm_insert_param(int slot, uint32_t index, float v)
{
    if (slot < 0 || slot >= kInsertSlots || !gSlots[slot].desc || index >= gSlots[slot].desc->num_params) return;
    if (gSlots[slot].desc->set_param) gSlots[slot].desc->set_param(gSlots[slot].inst, index, v);
}
EMSCRIPTEN_KEEPALIVE void ffm_insert_bypass(int slot, int on)
{
    if (slot >= 0 && slot < kInsertSlots) gSlots[slot].bypass = on != 0;
}
EMSCRIPTEN_KEEPALIVE void ffm_insert_reset(int slot)
{
    if (slot >= 0 && slot < kInsertSlots && gSlots[slot].desc && gSlots[slot].desc->reset) gSlots[slot].desc->reset(gSlots[slot].inst);
}

// The Mixer stage: 0 Hard Clip (default), 1 Soft Clip, 2 Soft Knee. 0 ok, 1 no such type.
EMSCRIPTEN_KEEPALIVE int ffm_mixer_set(int mode)
{
    if (mode < kMixerHardClip || mode > kMixerSoftKnee) return 1;
    gMixer = mode;
    fxMixerChanged();
    return 0;
}

// The master delay, reverb and limiter. The page fills ffm_fx_params() (24 floats) and calls ffm_fx_apply():
//  0 tempo (BPM)  1 delay feedback 0..99  2 delay time ms  3 delay params (pingpong 0x80, sync 0x40, rate 0..18)  4 delay filter Hz  5 reverb size 0..1
//  6 reverb damp 0..1  7 reverb predelay 0..1  8 reverb diffusion 0..0.85  9 delay level 0..100  10 reverb level 0..100  11 delay mute  12 reverb mute
//  13 delay send 0..100  14 reverb send 0..100   (15 unused)
//  16 limiter on (0 or 1)  17 limiter attack 1..1000  18 limiter release 1..1000 (0.512 is the new project's)  19 limiter threshold 0..32767  20 limiter mode (0 Subtle, 1 Extreme)
//  The device's units, audioEngine's setters apply them (host/fx.cpp).
EMSCRIPTEN_KEEPALIVE float* ffm_fx_params() { return gFxArr; }
EMSCRIPTEN_KEEPALIVE void ffm_fx_apply()
{
    fx::Params& p = gFxParams;
    p.tempo = gFxArr[0];
    p.delayFeedback = uint8_t(gFxArr[1]);
    p.delayTime = uint16_t(gFxArr[2]);
    p.delayParams = uint8_t(gFxArr[3]);
    p.delayFilter = uint16_t(gFxArr[4]);
    p.reverbSize = gFxArr[5];
    p.reverbDamp = gFxArr[6];
    p.reverbPredelay = gFxArr[7];
    p.reverbDiffusion = gFxArr[8];
    p.delayVolume = uint8_t(gFxArr[9]);
    p.reverbVolume = uint8_t(gFxArr[10]);
    p.delayMute = gFxArr[11] != 0;
    p.reverbMute = gFxArr[12] != 0;
    p.delaySend = gFxArr[13];
    p.reverbSend = gFxArr[14];
    p.limiterOn = gFxArr[16] != 0;
    // a caller that fills the first 15 values only leaves these at 0 (and the limiter off): an attack of 0 would divide by zero in the limiter, so the device's defaults then
    p.limiterAttack = gFxArr[17] >= 1.0f ? uint16_t(std::min(gFxArr[17], 1000.0f)) : 100;
    p.limiterRelease = gFxArr[18] > 0.0f ? std::min(gFxArr[18], 1000.0f) : 0.512f;
    p.limiterThreshold = uint16_t(std::min(std::max(gFxArr[19], 0.0f), 32767.0f));
    p.limiterMode = uint8_t(gFxArr[20]);
    if (gFx) gFx->apply(p);
}
// Silences the delay lines and the reverb (a new render must not start with the tail of the last one)
EMSCRIPTEN_KEEPALIVE void ffm_fx_reset()
{
    if (gFx) gFx->reset();
}
// 1 when the engine path changes the sound: an insert runs, or the graph is engaged (a send, the Mixer, the limiter, a tail)
EMSCRIPTEN_KEEPALIVE int ffm_engine_active() { return (ffmInsertsActive() || fxEngaged()) ? 1 : 0; }
// One 128 frame engine block (mono) in gBuf[0], the stereo result in gBuf[0] and gBuf[1]
EMSCRIPTEN_KEEPALIVE void ffm_engine_block() { ffmEngineChain(gBuf[0], gBuf[1]); }
// The send level tables of the firmware (ampLogarythmicValues.h): 101 floats each, sends then levels, for the page's dB labels
EMSCRIPTEN_KEEPALIVE const float* ffm_fx_table(int which) { return fx::table(which); }
EMSCRIPTEN_KEEPALIVE int ffm_chain_active() { return ffmChainActive() ? 1 : 0; }

// Scratch for a caller's block (the tests feed a reference input through it)
EMSCRIPTEN_KEEPALIVE float* ffm_buf(int ch) { return gBuf[ch & 1]; }
// One plugin call on gBuf, no conversion: what synth-open/plug/emu_plug.py does with a .plg (the plugin math alone)
EMSCRIPTEN_KEEPALIVE void ffm_insert_process_raw(int slot)
{
    if (slot < 0 || slot >= kInsertSlots || !gSlots[slot].desc) return;
    float* io[2] = { gBuf[0], gBuf[1] };
    gSlots[slot].desc->process(gSlots[slot].inst, io, 2, 128);
}
} // extern "C"

void ffmFreezeList() { gListFrozen = true; }

bool ffmInsertsActive()
{
    for (const Slot& s : gSlots)
    {
        if (s.desc && !s.bypass) return true;
    }
    return false;
}

// something to do: an insert that runs, or a mixer type other than Hard Clip (Hard Clip alone passes the block untouched)
bool ffmChainActive() { return ffmInsertsActive() || gMixer != kMixerHardClip; }

// The master chain on a stereo block in place, synth-open/plug_insert.cpp AudioEffectPlug::update step by step
void ffmChain(float* l, float* r)
{
    if (!ffmChainActive()) return;
    float* ch[2] = { l, r };
    int16_t blk[2][128];
    for (int c = 0; c < 2; c++)
    {   // the bus is int16 on the device: the mixer stage narrows to it (Hard Clip: the plugin node's truncation and clamp)
        for (int i = 0; i < 128; i++) blk[c][i] = mixerStage(ch[c][i]);
    }
    float* io[2] = { gBuf[0], gBuf[1] };
    for (int c = 0; c < 2; c++)
        for (int i = 0; i < 128; i++) gBuf[c][i] = float(blk[c][i]) * (1.0f / 32768.0f);
    for (Slot& s : gSlots)
    {
        if (s.desc && !s.bypass) s.desc->process(s.inst, io, 2, 128);
    }
    for (int c = 0; c < 2; c++)
    {
        for (int i = 0; i < 128; i++)
        {
            int32_t v = int32_t(gBuf[c][i] * 32768.0f);
            ch[c][i] = float(int16_t(v > 32767 ? 32767 : (v < -32768 ? -32768 : v))) * (1.0f / 32768.0f);
        }
    }
}

extern "C" EMSCRIPTEN_KEEPALIVE void ffm_chain_buf() { ffmChain(gBuf[0], gBuf[1]); }

// The engine path: the mono engine block in l (r is overwritten) through the delay and reverb graph and the track mixers (the Mixer stage), then the inserts.
// With no insert and an idle graph the block passes untouched on both sides.
void ffmEngineChain(float* l, float* r)
{
    if (!ffmInsertsActive() && !fxEngaged())
    {
        std::copy(l, l + 128, r);
        return;
    }
    int16_t out[2][128];
    fxGraph().process(l, out[0], out[1]);   // the sends, the delay and reverb, the Mixer stage, the inserts and, when it is on, the limiter
    float* ch[2] = { l, r };
    for (int c = 0; c < 2; c++)
        for (int i = 0; i < 128; i++) ch[c][i] = float(out[c][i]) * (1.0f / 32768.0f);
}
