// The Tracker's master delay, reverb and limiter with the audio graph of the firmware, for the editor's wasm host (modules.cpp) and the native proof tool (fx_tool.cpp).
//
// What runs is the firmware's own source, vendored byte for byte in vendor/fx (scripts/vendor-fx.sh): AudioStream with its update list, the mixers and the
// amplifier, AudioEffectShortDelay, AudioEffectPolyverb (Polyverb), AudioEffectLimiter, the saturate() of dspApplyGain, and MixerAndFxs<8> itself, the class that wires them.
// Only the wiring around one synth part is written here, line by line after audioEngine::connectSynthToMixer (core/AudioEngine/mtAudioEngine.cpp), and
// the objects are created in the firmware's order, because AudioStream::update_all runs them in that order and the order decides which block of the
// dry signal meets which block of the delay and reverb returns.
//
//   engine block (mono float) -> PolySynth stand-in: soft clip at 0 dB, int16 (core/libs/Audio/synth_PolySynth.cpp, a mono part without aux sends)
//        dry  -> panning amplifier (unity) -> tracks mixer (saturation type) ----------------------------------------\
//        send -> pre-fx mixer, gain = send * delay volume (setSynthDelaySend) -> AudioEffectShortDelay -> input 1 --> tracks and sends mixer (same
//        send -> pre-fx mixer, gain = send * reverb volume (setSynthReverbSend) -> AudioEffectPolyverb -> input 2 --/ saturation type) -> bus (int16 stereo)
//   bus -> master inserts (the hook below, AudioEffectPlug) -> AudioEffectLimiter (left, right) -> final mixer (unity) -> out
//   (AudioOutput of core/AudioEngine: connectMixerToOutput feeds the inserts, they feed the limiters, the limiters the final mixer.) The limiter has no bypass on the device and
//   none here either once it is on: `limiterOn` false leaves the limiters out of the path altogether (they do not run), which keeps the editor's own level when nobody asked for them.
//
// The part volume is 0 dB (the editor has none), so the post-fader send gain of the firmware is the pre-fader one.
#pragma once
#include <stdint.h>

namespace fx
{
constexpr int kBlock = 128;

struct Params
{
    // master delay (the Master Delay page): feedback 0..99, time 1..3500 ms, filter 100..20000 Hz, params = pingpong 0x80 | sync 0x40 | rate 0..18
    uint8_t delayFeedback = 50;
    uint16_t delayTime = 500;
    uint8_t delayParams = 0;
    uint16_t delayFilter = 20000;
    // master reverb (the Master Reverb page): 0..1, diffusion 0..0.85
    float reverbSize = 0.5f;
    float reverbDamp = 0.5f;
    float reverbPredelay = 0.5f;
    float reverbDiffusion = 0.68f;
    // the Mixer page levels of the two returns (0..100, the send gain of the pre-fx mixer is send * volume) and their mutes
    uint8_t delayVolume = 86;
    uint8_t reverbVolume = 86;
    bool delayMute = false;
    bool reverbMute = false;
    // the synth part's sends, 0..100 (SynthPartSettings::delaySend and reverbSend)
    float delaySend = 0.0f;
    float reverbSend = 0.0f;
    float tempo = 130.0f; // BPM, for the delay's tempo sync
    int mixer = 0;        // SaturationType: 0 Hard Clip, 1 Soft Clip, 10 Soft Knee
    // the master limiter (the Limiter screen of Master: strMtProject limiterAttack, limiterRelease, limiterThreshold and the config menu's limiterMode). The sidechain is Off:
    // its sources are the sample tracks, which the editor does not have.
    bool limiterOn = false;
    uint16_t limiterAttack = 100;        // 1..1000, shown as value / 1000 s
    float limiterRelease = 0.512f;       // 1..1000, the new project's default is 0.512
    uint16_t limiterThreshold = 30200;   // 0..32767, only value * 100 / 32767 (0..100) picks the step of limiterThresholdValues
    uint8_t limiterMode = 0;             // 0 Subtle, 1 Extreme
};

/** The master inserts, as the graph sees them (AudioEffectPlug in the firmware): `active` says whether any slot runs (otherwise the blocks pass untouched), `run` processes the
 *  int16 stereo block in place. The functions have no context, the editor's host has one set of slots. */
struct InsertStage
{
    bool (*active)();
    void (*run)(int16_t* left, int16_t* right);
};

class Graph
{
  public:
    Graph();
    ~Graph();
    /** Applies every value the way audioEngine does when the page edits it (setDelayParams, setDelayTime, setReverbDamp (1 - damp) ...). */
    void apply(const Params& p);
    /** Silences both effects (their buffers) and forgets the blocks in flight, as a new project does. */
    void reset();
    /** One 128 frame block: the part's mono engine block in, the int16 master (left, right) out: after the tracks and sends mixer, the inserts and, with limiterOn, the limiter. */
    void process(const float* mono, int16_t* left, int16_t* right);
    /** Puts the master inserts between the bus and the limiter (null: none). */
    void setInserts(const InsertStage* stage);
    /** Is anything to do: a send above zero, the mixer is not Hard Clip, the limiter is on, or a tail still rings. */
    bool active() const;

  private:
    struct Impl;
    Impl* d;
};
/** The firmware's level tables (ampLogarythmicValues.h): 0 = sendsAmpLogValues, 1 = mixAmpLogValues, 101 floats each. */
const float* table(int which);
/** The arguments of the expf check (test/fx-m4.test.ts): the limiter's coefficient arguments for every attack and release 1..1000 and 0.512, then a grid down to -51. */
constexpr int kExpfGrid = 1001 + 4096;
inline float expfGrid(int i)
{
    if (i < 1000) return -2.2f * (1000.0f / (44100.0f * float(i + 1)));
    if (i == 1000) return -2.2f * (1000.0f / (44100.0f * 0.512f));
    return -float(i - 1000) * 0.0125f;
}
} // namespace fx
