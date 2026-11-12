# The Tracker's master delay and reverb: what the firmware does

Read from the tracker-ff 1.2.0 release branch (`release-1.2.0`, tip d3e6c73, the commit the 1.2.0 image is built from, `core/` is unchanged since by
`ffd3f25`). Paths are in the firmware repository. Nothing here was measured on a device.

## Topology

`core/AudioEngine/MixerAndFxs.{h,cpp}` is the whole wiring of the effects, one instance `MixerAndFxs<8>` (8 sample tracks) in `audioEngine`:

```
tracks, synth parts -> tracksAndSynthMixer  (L, R, AudioMixer<11>) --------> tracksAndSendsMixer input 0 (dry)
tracks, synth parts -> preFxMixer[kDelay]   (AudioMixer<13>, mono) -> AudioEffectShortDelay -> input 1 (left and right of the delay)
tracks, synth parts -> preFxMixer[kReverb]  (AudioMixer<13>, mono) -> AudioEffectPolyverb   -> input 2 (left and right of the reverb)
                                                 tracksAndSendsMixer (L, R, AudioMixer<4>, input 3 = line in) -> master inserts -> limiters -> output
```

- The two pre-fx mixers feed the effect with `receiveReadOnly`, a mono sum (delay) and the same mono sum on both reverb inputs. The returns have gain 1 in the
  tracks and sends mixer (`audioEngine::init` sets inputs 1 to 3 to 1.0). **The delay and reverb are before the mixer stage and before the inserts and the limiter**: their
  returns are summed with the dry signal in `tracksAndSendsMixer`, which narrows to int16 with the project's saturation type, and `connectMixerToOutput`
  then feeds that bus to the master inserts (`FEATURE_PLUG_HOST` / `FEATURE_FF_DIRT`) and to the limiters.
- **The saturation type is applied twice.** `setSaturationType` sets it on `tracksAndSynthMixer` and on `tracksAndSendsMixer` (both sides). The second mixer only
  forwards untouched for Hard Clip with a single contributor (`AudioMixerBase::mix`), so Soft Clip and Soft Knee act on the dry sum and then again on the sum with the
  returns.
- **Update order decides latency.** `AudioStream::update_all` runs the objects in creation order. `audioEngine` creates `mixerAndFxs` (pre-fx mixers, track mixers,
  tracks and sends mixers, delay, reverb) before `synthVoice` (its panning amplifiers, then `PolySynth`), so a block that `PolySynth` transmits is consumed in the next
  pass. The dry signal passes the panning amplifier and meets the track mixers one pass later, the send goes pre-fx mixer, effect, tracks and sends mixer one pass later
  too: dry and effect return reach the sum in the same pass.
- Sample rate: the audio library runs at 44117.647 Hz (`AUDIO_SAMPLE_RATE_EXACT`, 128 sample blocks). The delay converts milliseconds at 44.1 samples per ms and its filter
  uses 44100 Hz, both fixed constants, not the real rate.

## How a synth engine reaches the effects (1.2.0)

`audioEngine::connectSynthToMixer` connects `PolySynth` channels `kSend1Offset + part` and `kSend2Offset + part` to `preFxMixer[kDelay]` and `preFxMixer[kReverb]`, input
`MixerAndFxs::kFirstSynthSendInput + part`. On MK66 with the open synth that constant is `2 + kVoices` = 10 and the pre-fx mixers are 13 wide: fix `4e2288d` (before it the
code used the Tracker+ layout inputs 18 to 20, which `AudioConnection::connect` refused, so the synth sends were silently dead. The 1.2.0 branch also fixes the bound check of
`connect` to `dest_index >= num_inputs`). `PolySynth::update` (`core/libs/Audio/synth_PolySynth.cpp`) transmits for a mono part without aux sends one
block, the engine output through `saturateSoftClip(buf, 0 dB)` and `* INT16_MAX`, as send 1, send 2 and (at a part gain of 0 dB) as the dry output. The send gain is set by
`setSynthDelaySend` / `setSynthReverbSend`:

```
pre-fader:  gain = sendsAmpLogValues[send] * mixAmpLogValues[delayVolume]                       (0 when delayMute)
post-fader: gain = sendsAmpLogValues[send] * mixAmpLogValues[delayVolume] * dbToAmplitude(part volume)   (the project default is post-fader)
```

`send` is the synth part's Delay send or Reverb send, 0 to 100, shown as dB (`20 log10(sendsAmpLogValues[send])`), default 0. **So the part-level sends of a synth engine do
reach the delay and reverb in 1.2.0** (and in the 1.1.0 release, whose tree already has the fix). The editor's README had this the other way round: its sentence
that the sends are inert because "the editor has no send bus, and the firmware ignores them too" holds for the **per-drum** sends of PERC and T-Type (`Kick Delay`,
`Snare Reverb` ...) only. The shim reports no aux sends for those parts (`rendersAuxSends` is false, `setSendTap` is never called, `synth-open/README.md`), so the firmware
ignores them still, and only the part-level knobs act.

Evidence: the code path above, the bench of `synth-open/tools/audio_opt/graph_bench.cpp` (6 of 6 synth send `connect()` calls accepted, scenario 7 has the sends sounding,
it needs the 10.3 compiler and was not run here) and the maintainer's note in `synth-open/README.md` that the reverb and delay tails and the synth sends were checked by ear
on an original Tracker with pre-release builds. The editor's own proof is `test/fx.test.ts`: the same firmware files through the same graph, a send above zero changes the
output, the per-drum parameters do not.

## Parameters (Master Delay, Master Reverb, Mixer pages)

| page | parameter | range, step | default | note |
| --- | --- | --- | --- | --- |
| Delay | PingPong | On, Off | Off | `delayParams` bit 7 |
| Delay | Sync | On, Off | Off | bit 6 |
| Delay | Rate | 19 values, 8 to 1/32 | 8 | bits 0..5, used with Sync |
| Delay | Time | 1 to 3500 ms, step 1 below 100, 10 below 500, 30 above | 500 ms | used without Sync |
| Delay | Feedback | 0 to 99 | 50 | `feedback / 100`, the effect caps it at 0.99 and keeps it in 1/255 steps |
| Delay | Filter | 100 to 20000 Hz, step 100 | 20000 Hz | one pole low pass on the delayed signal |
| Reverb | Size | 0 to 100 (0.00 to 1.00) | 50 | decay time |
| Reverb | Damping | 0 to 100 | 50 | `setDamp(1 - damp)` |
| Reverb | Predelay | 0 to 100 | 50 | fraction of 5000 samples |
| Reverb | Diffusion | 0 to 100 (0 to 0.85) | 80 (0.68) | |
| Mixer | Delay level, Reverb level | 0 to 100 | 86 | shown as `20 log10(mixAmpLogValues[v])` dB, also scales the send gain, plus a mute |

Fixed in the constructor: the reverb input gain 0.1 and wet amount 0.8 (`AudioEffectPolyverb`). Line in sends are not modelled (the editor has no line in).

## Quirks of the firmware that the editor does not copy

- `audioEngine::init` calls `delay->begin(mtProject.values.delayFeedback, ...)` with the percent value (50) for a float parameter that `setFeedback` clamps to 0.99. After a
  project load the delay therefore feeds back at 99 % until the Feedback knob is touched. The editor applies Feedback / 100 from the start, which is what the knob does.
- `init` also passes the Damping value unflipped to `setDamp`, the knob path passes `1 - damp`. The editor uses the knob path.
- `changeDelaySyncEnable` sets the free Time right after switching Sync on, until the next tempo refresh. The editor applies the synced time at once.
- `AudioEffectShortDelay::update` transmits the right output on channel 0 and the left on 1, and `MixerAndFxs` connects channel 0 to the left mixer, so the
  ping-pong sides are swapped on the bus. The editor runs that code, so it is swapped the same way.

## The master limiter

Same release branch and commit. Paths are in the firmware repository.

- **Position.** `core/AudioEngine/AudioOutput.cpp`: the tracks and sends mixers feed the master inserts (`getMasterInsert`: Dirt, then the plugin node), the inserts feed `limiter[kLeft]` and `limiter[kRight]` (input 0), the limiters feed `finalMixer` input 0 and the final mixers the output stream. `AudioOutput` is created after `mixerAndFxs` and `synthVoice` in `audioEngine`, so its objects update later in the same pass: the inserts and the limiters work on the block the tracks and sends mixers just made, no extra block of latency. The limiter itself holds the signal for `LIMITER_DELAY` = 5 samples (`effect_limiter.h`).
- **Final mixer.** `finalMixer[ch]` has input 0 (the stream) at unity, the other inputs (SD preview, test tone, metronome, NES) are not connected here, so with the Hard Clip default it forwards the block. The codec's master volume and the master enhancer (bass, stereo, 5 band EQ) are on the codec after the output stream and are not in this graph.
- **Parameters** (Master -> Limiter screen, `core/interface/masterParams/fMasterParams.cpp`, `gMasterParams.cpp`, limits in `core/source/mtStructs.h`):

| parameter | range, step | new project | note |
| --- | --- | --- | --- |
| Attack | 1 to 1000, step 1 | 100 | shown as `value / 1000` s. Subtle: coefficient `1 - expf(-2.2 * 1000 / (44100 * a))`. Extreme: `a / 1000` |
| Release | 1 to 1000, step 1 | 0.512 | same formulas. The default is below the screen's minimum, the first step goes to 1.512 or clamps to 1 |
| Threshold | 0 to 32767 in steps of 1 % (327 per click) | 30200 | only `value * 100 / 32767` (0 to 100) is used, as an index into `limiterThresholdValues` (`ampLogarythmicValues.h`), shown as `20 log10(table / 32767)` dB. 30200 is index 92, 16422, about -6 dB |
| Sidechain | 0 to 10 (+ synth parts on other platforms) | 0 (Off) | 1 to 8 are the sample tracks (`connectVoiceToOutput` feeds the amplifier of voice n to the sidechain mux). On the MK66 the synth parts are not connected to the mux |
| Limiter mode | Subtle, Extreme | Subtle | config menu (`setLimiterMode`), project value `limiterMode`, read by `setAttack` and `setRelease`. A mode change re-applies Attack and Release |

- **Behaviour.** One peak detector per side: `xpeak` follows `|x|` with the attack coefficient up and the release coefficient down, `f = min(1, threshold / xpeak)`, the gain `g` follows `f` the same way and multiplies the input delayed by 5 samples. Subtle with the default Attack 100 has a time constant of about 2000 samples, so a burst shorter than that is mostly not cut. The limiter has no bypass. The project defaults in `fileManagerProject.cpp` (100, 0.512, 30200, Subtle, sidechain Off) are the ones above. `playerEngine::noteOnWithoutInstrument` (the sample audition from the file browser) sets the engine's limiter to Attack 300, Release 10 and the highest threshold without touching the project values, which the editor does not model, a synth part never takes that path.
- **Detail that matters for bit identity.** `AudioEffectLimiter` leaves several members without an initialiser (`xpeak`, `a`, `coeff`, `f`, the storage buffers, `isBlocked`), they are zero because the audio objects are globals of `audioEngine` on the device. The editor allocates its graph zeroed. The coefficient uses `expf`, whose last bit differs between the Mac's libm, emscripten's and newlib's (see the README), so the arm64 and wasm builds use a copy of newlib's.
