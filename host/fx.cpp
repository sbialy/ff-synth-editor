// See fx.h. Everything the firmware computes is the vendored firmware code, this file only builds the graph around one synth part.
#include "fx.h"

#include "AudioStream.h"
#include "effect_limiter.h"
#include "mtStructs.h"
#include "MixerAndFxs.h"
#include "ampLogarythmicValues.h"
#include "mtSequencer.h"
#include "PolySynth/sdk/SynthVoiceSDK.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <new>

// ---- what the firmware's source expects from its platform
EditorSequencer sequencer;
strMtProject mtProject; // the limiter reads its settings here (host/fx/mtStructs.h)
void enableAudioInterrupt() {}
void disableAudioInterrupt() {}
// Tracker.cpp: the delay lines (3 x 262144 int16) and the second reverb buffer (the first one is a static of effect_polyverb.cpp)
alignas(8) int16_t externalRamDelayBuff[3 * 262144];
alignas(8) uint16_t externalRamReverbBuff[16384];

#ifndef FX_REAL_LIBM
// newlib's expf (newlib/libm/math/ef_exp.c, the fdlibm float exp, Copyright (C) 1993 by Sun Microsystems, Inc., free to use with this notice kept): see host/fx/mtStructs.h
// The libm.a of the 12.3 toolchain (thumb/v7e-m+fp/hard) is built with fused multiply-adds: the reduction's k, hi and the polynomial are VFMA/VFMS there (read from its
// disassembly), so they are fmaf() here, which the host rounds the same way. test/fx-m4.test.ts compares this with the real one.
float fx_expf(float x)
{
    static const float one = 1.0f, halF[2] = { 0.5f, -0.5f }, huge = 1.0e+30f, twom100 = 7.8886090522e-31f, o_threshold = 8.8721679688e+01f, u_threshold = -1.0397208405e+02f,
                       ln2HI[2] = { 6.9313812256e-01f, -6.9313812256e-01f }, ln2LO[2] = { 9.0580006145e-06f, -9.0580006145e-06f }, invln2 = 1.4426950216e+00f,
                       P1 = 1.6666667163e-01f, P2 = -2.7777778450e-03f, P3 = 6.6137559770e-05f, P4 = -1.6533901999e-06f, P5 = 4.1381369442e-08f;
    float y, hi = 0.0f, lo = 0.0f, c, t;
    int32_t k = 0, xsb, hx;
    std::memcpy(&hx, &x, 4);
    xsb = (hx >> 31) & 1;
    hx &= 0x7fffffff;
    if (hx >= 0x42b17218)
    {
        if (hx > 0x7f800000) return x + x;
        if (hx == 0x7f800000) return (xsb == 0) ? x : 0.0f;
        if (x > o_threshold) return huge * huge;
        if (x < u_threshold) return twom100 * twom100;
    }
    if (hx > 0x3eb17218)
    {
        if (hx < 0x3F851592)
        {
            hi = x - ln2HI[xsb];
            lo = ln2LO[xsb];
            k = 1 - xsb - xsb;
        }
        else
        {
            k = int32_t(std::fmaf(x, invln2, halF[xsb]));
            t = float(k);
            hi = std::fmaf(-t, ln2HI[0], x);
            lo = t * ln2LO[0];
        }
        x = hi - lo;
    }
    else if (hx < 0x31800000)
    {
        if (huge + x > one) return one + x;
    }
    else
    {
        k = 0;
    }
    t = x * x;
    float poly = std::fmaf(t, P5, P4);
    poly = std::fmaf(poly, t, P3);
    poly = std::fmaf(poly, t, P2);
    poly = std::fmaf(poly, t, P1);
    c = std::fmaf(-poly, t, x);
    if (k == 0) return one - ((x * c) / (c - 2.0f) - x);
    y = one - ((lo - (x * c) / (2.0f - c)) - hi);
    uint32_t hy;
    std::memcpy(&hy, &y, 4);
    if (k >= -125)
    {
        hy += uint32_t(k) << 23;
        std::memcpy(&y, &hy, 4);
        return y;
    }
    hy += uint32_t(k + 100) << 23;
    std::memcpy(&y, &hy, 4);
    return y * twom100;
}
#endif

namespace
{
constexpr int kVoices = 8;      // audioEngine::kVoices
constexpr int kPart = 0;        // the editor plays one engine: synth part 0
constexpr float kAmpMuted = 0.0f;

using Mixer = MixerAndFxs<kVoices>;

// PolySynth::update (core/libs/Audio/synth_PolySynth.cpp) for a mono part that renders no aux sends, at a part gain of 0 dB (reuseUnmodifiedMono): the engine block
// goes through saturateSoftClip(0 dB) and to int16 (* INT16_MAX, truncated), and that one block is the pre-fader send tap of both sends and the dry output of
// both sides. A block of zeros is not transmitted (a part with nothing sounding transmits nothing), which every consumer reads as silence.
class PartSource : public AudioStream
{
  public:
    PartSource()
      : AudioStream(0, nullptr)
    {
    }
    void set(const float* mono)
    {
        float tmp[fx::kBlock];
        std::memcpy(tmp, mono, sizeof(tmp));
        polysynth::sdk::saturateSoftClip(std::span<polysynth::sample_t>(tmp, fx::kBlock), 0.0f);
        int32_t any = 0;
        for (int i = 0; i < fx::kBlock; i++)
        {
            data[i] = static_cast<int16_t>(tmp[i] * INT16_MAX);
            any |= data[i];
        }
        pending = any != 0;
    }
    void update() override
    {
        if (!pending)
        {
            return;
        }
        audio_block_t* send = allocate();
        audio_block_t* dryLeft = allocate();
        if (send == nullptr || dryLeft == nullptr)
        {
            if (send) release(send);
            if (dryLeft) release(dryLeft);
            return;
        }
        std::memcpy(send->data, data, sizeof(data));
        std::memcpy(dryLeft->data, data, sizeof(data));
        // the firmware's channel numbers: post fader left = part, right = kSynthParts + part, send 1 = 2 * kSynthParts + part, send 2 = 3 * kSynthParts + part
        transmit(send, 2 * kSynthParts + kPart);
        transmit(send, 3 * kSynthParts + kPart);
        release(send);
        transmit(dryLeft, kPart);
        transmit(dryLeft, kSynthParts + kPart);
        release(dryLeft);
    }

  private:
    int16_t data[fx::kBlock] = {};
    bool pending = false;
};

// The master inserts of AudioOutput (the FEATURE_PLUG_HOST node, synth-open/plug_insert.cpp AudioEffectPlug::update): with no slot running the blocks pass untouched, else the
// block is run through the slots in int16. The editor's inserts are plugins that arrive at run time (host/modules.cpp), they come in as a hook. The editor has always run
// them on a silent bus too (a missing block is a block of zeros), which this keeps. The last block it transmitted is kept as the tap for a graph with the limiter out.
class InsertNode : public AudioStream
{
  public:
    InsertNode()
      : AudioStream(2, queue)
    {
    }
    const fx::InsertStage* stage = nullptr;
    int16_t tap[2][fx::kBlock] = {};
    void update() override
    {
        if (stage == nullptr || !stage->active())
        {
            for (unsigned c = 0; c < 2; c++)
            {
                audio_block_t* b = receiveReadOnly(c);
                if (b)
                {
                    std::memcpy(tap[c], b->data, sizeof(tap[c]));
                    transmit(b, c);
                    release(b);
                }
                else
                {
                    std::memset(tap[c], 0, sizeof(tap[c]));
                }
            }
            return;
        }
        audio_block_t* blk[2] = { receiveWritable(0), receiveWritable(1) };
        for (int c = 0; c < 2; c++)
        {
            if (blk[c]) continue;
            blk[c] = allocate();
            if (!blk[c])
            {
                if (blk[c ^ 1]) release(blk[c ^ 1]);
                return;
            }
            std::memset(blk[c]->data, 0, sizeof(blk[c]->data));
        }
        stage->run(blk[0]->data, blk[1]->data);
        for (int c = 0; c < 2; c++)
        {
            std::memcpy(tap[c], blk[c]->data, sizeof(tap[c]));
            transmit(blk[c], c);
            release(blk[c]);
        }
    }

  private:
    audio_block_t* queue[2] = {};
};

// The end of the graph: what leaves the final mixer (the audio output stream of the device), or with the limiter out of the path the inserts' tap. A missing block is silence.
class Out : public AudioStream
{
  public:
    Out()
      : AudioStream(2, queue)
    {
    }
    const InsertNode* node = nullptr;
    bool limited = false;
    void update() override
    {
        for (int c = 0; c < 2; c++)
        {
            audio_block_t* b = receiveReadOnly(c);
            if (b)
            {
                if (limited) std::memcpy(out[c], b->data, sizeof(out[c]));
                release(b);
            }
            else if (limited)
            {
                std::memset(out[c], 0, sizeof(out[c]));
            }
            if (!limited) std::memcpy(out[c], node->tap[c], sizeof(out[c]));
        }
    }
    int16_t out[2][fx::kBlock] = {};

  private:
    audio_block_t* queue[2] = {};
};

// AudioMemory(70) of audioEngine::init
audio_block_t gPool[70];
bool gPoolReady = false;
} // namespace

namespace fx
{
struct Graph::Impl
{
    // creation order = update order (AudioStream::update_all): mixerAndFxs, then SynthVoice (its panning amplifiers, then the PolySynth), then the output side
    Mixer mixerAndFxs;
    AudioAmplifier panning[kSynthParts][2];
    PartSource polySynth;
    // AudioOutput: the master inserts, the limiters, the final mixer, the output
    InsertNode inserts;
    AudioEffectLimiter limiter[2];
    AudioMixer<7> finalMixer[2]; // AudioOutput::kFinalMixerSize: the stream at unity, the other inputs (preview, test tone, metronome, NES) are not connected
    Out out;
    std::vector<AudioConnection*> connections;
    Params p;
    float lastTempoRefresh = 0.0f;
    bool begun = false;
    uint32_t silentBlocks = 1u << 30;
    float silentInput[kBlock] = {};

    Impl()
    {
        // audioEngine::connectSynthToMixer
        constexpr int first = Mixer::kFirstSynthSendInput;
        for (int ch = 0; ch < kSynthParts; ch++)
        {
            connections.push_back(new AudioConnection(&polySynth, 2 * kSynthParts + ch, mixerAndFxs.getPreFxMixer(Mixer::FxType::kDelay), first + ch));
            connections.push_back(new AudioConnection(&polySynth, 3 * kSynthParts + ch, mixerAndFxs.getPreFxMixer(Mixer::FxType::kReverb), first + ch));
            connections.push_back(new AudioConnection(&polySynth, ch, &panning[ch][0], 0));
            connections.push_back(new AudioConnection(&polySynth, kSynthParts + ch, &panning[ch][1], 0));
            connections.push_back(new AudioConnection(&panning[ch][0], 0, mixerAndFxs.getTracksMixer(MixerAndFxChannelType::kLeft), kVoices + ch));
            connections.push_back(new AudioConnection(&panning[ch][1], 0, mixerAndFxs.getTracksMixer(MixerAndFxChannelType::kRight), kVoices + ch));
        }
        // audioEngine::connectMixerToOutput: the tracks and sends mixers feed the master inserts (getMasterInsert), AudioOutput::AudioOutput connects the inserts to the limiters
        // (the sidechain input 1 stays unconnected: sidechain Off), the limiters to the final mixers (kStreamInputIdx 0) and those to the output stream
        connections.push_back(new AudioConnection(mixerAndFxs.getTracksAndSendsMixer(MixerAndFxChannelType::kLeft), 0, &inserts, 0));
        connections.push_back(new AudioConnection(mixerAndFxs.getTracksAndSendsMixer(MixerAndFxChannelType::kRight), 0, &inserts, 1));
        for (int c = 0; c < 2; c++)
        {
            connections.push_back(new AudioConnection(&inserts, c, &limiter[c], 0));
            connections.push_back(new AudioConnection(&limiter[c], 0, &finalMixer[c], 0));
            connections.push_back(new AudioConnection(&finalMixer[c], 0, &out, c));
        }
        out.node = &inserts;
        // audioEngine::init: the final mixer's stream input at unity
        finalMixer[0].gain(0, 1.0f);
        finalMixer[1].gain(0, 1.0f);
        // audioEngine::init: the track mixers at unity, the reverb and delay started
        for (int ch = 0; ch < kVoices + kSynthParts; ch++)
        {
            mixerAndFxs.getTracksMixer(MixerAndFxChannelType::kLeft)->gain(ch, 1.0f);
            mixerAndFxs.getTracksMixer(MixerAndFxChannelType::kRight)->gain(ch, 1.0f);
        }
        for (int i = 1; i < 4; i++)
        {
            mixerAndFxs.getTracksAndSendsMixer(MixerAndFxChannelType::kLeft)->gain(i, 1.0f);
            mixerAndFxs.getTracksAndSendsMixer(MixerAndFxChannelType::kRight)->gain(i, 1.0f);
        }
        mixerAndFxs.getPolyverb()->reset();
        mixerAndFxs.getPolyverb()->unblockUpdate();
    }
    ~Impl()
    {
        for (auto* c : connections) delete c;
    }

    // audioEngine::setDelayParams
    void delayParams(uint8_t v)
    {
        auto* delay = mixerAndFxs.getDelay();
        delay->setPingpongEnable(v & 0b10000000);
        delay->setSyncEnable(v & 0b01000000);
        delay->setRate(v & 0b00111111);
    }
    // audioEngine::setSynthDelaySend and setSynthReverbSend at a part gain of 0 dB
    void sends()
    {
        const float d = p.delayMute ? kAmpMuted : sendsAmpLogValues[(int)p.delaySend] * mixAmpLogValues[p.delayVolume] * polysynth::sdk::dbToAmplitude(0.0f);
        const float r = p.reverbMute ? kAmpMuted : sendsAmpLogValues[(int)p.reverbSend] * mixAmpLogValues[p.reverbVolume] * polysynth::sdk::dbToAmplitude(0.0f);
        mixerAndFxs.getPreFxMixer(Mixer::FxType::kDelay)->gain(Mixer::kFirstSynthSendInput + kPart, d);
        mixerAndFxs.getPreFxMixer(Mixer::FxType::kReverb)->gain(Mixer::kFirstSynthSendInput + kPart, r);
    }
};

Graph::Graph()
{
    if (!gPoolReady)
    {
        AudioStream::initialize_memory(gPool, 70);
        gPoolReady = true;
    }
    // The audio objects live in static storage on the device (the global audioEngine), so the members their constructors leave alone (AudioEffectLimiter has several) start as
    // zero there. Zeroed memory here, so every build (arm64, wasm, Cortex-M4F) starts from the same state.
    d = new (std::calloc(1, sizeof(Impl))) Impl;
}
Graph::~Graph()
{
    d->~Impl();
    std::free(d);
}

void Graph::setInserts(const InsertStage* stage) { d->inserts.stage = stage; }

void Graph::apply(const Params& n)
{
    Impl& g = *d;
    auto* delay = g.mixerAndFxs.getDelay();
    auto* verb = g.mixerAndFxs.getPolyverb();
    const Params o = g.p;
    const bool first = !g.begun;
    g.p = n;
    sequencer.tempo = n.tempo;
    if (first)
    {
        // audioEngine::init -> AudioEffectShortDelay::begin. The firmware hands it the feedback in percent (a float parameter it clamps to 0.99), the page's
        // path is setDelayFeedback (value / 100), which is what this does.
        delay->begin(n.delayFeedback / 100.0f, n.delayTime, n.delayParams & 0b10000000, n.delayParams & 0b01000000, n.delayParams & 0b00111111, n.delayFilter);
        g.lastTempoRefresh = n.tempo;
        g.begun = true;
    }
    else
    {
        if (n.delayFeedback != o.delayFeedback) delay->setFeedback(n.delayFeedback / 100.0);
        if (n.delayTime != o.delayTime) delay->setTime(n.delayTime);
        if (n.delayFilter != o.delayFilter) delay->setFilterFrequency(n.delayFilter);
        if (n.delayParams != o.delayParams) g.delayParams(n.delayParams);
        // mtAudioEngine.cpp: a tempo change of more than 1 BPM refreshes the synced time
        if (std::fabs(n.tempo - g.lastTempoRefresh) > 1.0f)
        {
            g.lastTempoRefresh = n.tempo;
            g.delayParams(n.delayParams);
        }
    }
    if (first || n.reverbSize != o.reverbSize) verb->setTime(n.reverbSize);
    if (first || n.reverbDamp != o.reverbDamp) verb->setDamp(1.0f - n.reverbDamp);
    if (first || n.reverbPredelay != o.reverbPredelay) verb->SetPredelayLength(n.reverbPredelay);
    if (first || n.reverbDiffusion != o.reverbDiffusion) verb->SetDiffusion(n.reverbDiffusion);
    if (first || n.delaySend != o.delaySend || n.reverbSend != o.reverbSend || n.delayVolume != o.delayVolume || n.reverbVolume != o.reverbVolume ||
        n.delayMute != o.delayMute || n.reverbMute != o.reverbMute)
        g.sends();
    // audioEngine::setLimiterAttack / Release / Threshold and the config menu's setLimiterMode (the mode is read by setAttack and setRelease from mtProject), begin() at init
    // and resetLimiter() where the limiter comes in
    mtProject.values.limiterMode = n.limiterMode;
    mtProject.values.limiterAttack = n.limiterAttack;
    mtProject.values.limiterRelease = n.limiterRelease;
    mtProject.values.limiterThreshold = n.limiterThreshold;
    mtProject.values.limiterSidechain = 0;
    if (first || (n.limiterOn && !o.limiterOn))
    {
        for (auto& l : g.limiter) l.begin();
    }
    else
    {
        for (auto& l : g.limiter)
        {
            if (n.limiterAttack != o.limiterAttack || n.limiterMode != o.limiterMode) l.setAttack(n.limiterAttack);
            if (n.limiterRelease != o.limiterRelease || n.limiterMode != o.limiterMode) l.setRelease(n.limiterRelease);
            if (n.limiterThreshold != o.limiterThreshold) l.setThreshold(n.limiterThreshold);
        }
    }
    g.out.limited = n.limiterOn;
    if (first || n.mixer != o.mixer)
    {
        const auto t = static_cast<SaturationType>(n.mixer);
        g.mixerAndFxs.getTracksMixer(MixerAndFxChannelType::kLeft)->setSaturationType(t);
        g.mixerAndFxs.getTracksMixer(MixerAndFxChannelType::kRight)->setSaturationType(t);
        g.mixerAndFxs.getTracksAndSendsMixer(MixerAndFxChannelType::kLeft)->setSaturationType(t);
        g.mixerAndFxs.getTracksAndSendsMixer(MixerAndFxChannelType::kRight)->setSaturationType(t);
    }
}

void Graph::reset()
{
    Impl& g = *d;
    g.mixerAndFxs.getDelay()->clear();
    g.mixerAndFxs.getPolyverb()->reset();
    g.mixerAndFxs.getPolyverb()->unblockUpdate();
    // the blocks in flight (the update order holds a block for two passes) leave through the output unheard, and the mixers' gain ramps end on silence. The master inserts are not
    // run on this silence: the caller resets them itself and they must keep that state.
    const InsertStage* stage = g.inserts.stage;
    g.inserts.stage = nullptr;
    std::memset(g.silentInput, 0, sizeof(g.silentInput));
    for (int i = 0; i < 4; i++)
    {
        g.polySynth.set(g.silentInput);
        AudioStream::update_all();
    }
    // The limiter keeps its gain reduction and its peak detector after a loud passage and lets go of them with the release time: silence until the gain is back at 1, so a render
    // does not depend on the one before it. (A limiter that never reduced is there after the first block.)
    for (int i = 0; i < 4000; i++)
    {
        g.polySynth.set(g.silentInput);
        AudioStream::update_all();
        const bool a = g.limiter[0].isAvailableGainToGet() && g.limiter[0].getAverageGainChange() == 1.0f;
        const bool b = g.limiter[1].isAvailableGainToGet() && g.limiter[1].getAverageGainChange() == 1.0f;
        if (a && b) break;
    }
    g.inserts.stage = stage;
    g.silentBlocks = 1u << 30;
}

void Graph::process(const float* mono, int16_t* left, int16_t* right)
{
    Impl& g = *d;
    g.polySynth.set(mono);
    AudioStream::update_all();
    std::memcpy(left, g.out.out[0], sizeof(g.out.out[0]));
    std::memcpy(right, g.out.out[1], sizeof(g.out.out[1]));
    bool silent = true;
    for (int i = 0; i < kBlock; i++) silent = silent && left[i] == 0 && right[i] == 0;
    g.silentBlocks = silent ? std::min<uint32_t>(g.silentBlocks + 1, 1u << 30) : 0;
}

const float* table(int which) { return which == 0 ? sendsAmpLogValues : mixAmpLogValues; }

bool Graph::active() const
{
    const Impl& g = *d;
    // sounding now, or the last blocks were not silent (a tail), or a send / the mixer asks for the graph
    return g.p.delaySend > 0 || g.p.reverbSend > 0 || g.p.mixer != 0 || g.p.limiterOn || g.silentBlocks < 4096;
}
} // namespace fx
