# Vendored firmware sources of the master delay, reverb and limiter

Copied byte for byte (CRLF kept) by scripts/vendor-fx.sh from commit d3e6c73ea10da71675d605a0187c0d4586256705 (2026-11-07) of the firmware repository, read with git archive.
Nothing in these files is edited. The editor's own stand-ins for the firmware headers they include (config.h, Audio.h, mtStructs.h, mtSequencer.h, mtAudioEngine.h,
mtAudioExport.h) are in host/fx.

| file | sha256 |
| --- | --- |
| core/libs/Audio/AudioStream.h | 8da14b57cc56684334ed176fa46879ea089156bcd531dfcd7cc91950d59b5fa6 |
| core/libs/Audio/AudioStream.cpp | 81d02b0361eb96a6de801990ff5dcdd03ee4b958f70e66ebd1311142ac7b3c7a |
| core/libs/Audio/mixer.h | 2e2bb6175e5c14ee615169ae198fde08968542b6c69e58e66c100fe5607dcbae |
| core/libs/Audio/mixer.cpp | 697bc11a16711f6bd7e3217b22b338d73cb3cd3c9875bb101be3a27a1eb50853 |
| core/libs/Audio/amplifier.h | 801aaec45c27ef093d2156c5b333d422b0dc8ac92a45dce37e5eec58e5296d50 |
| core/libs/Audio/amplifier.cpp | 952c1f9c4002bb45b30f8d5b8bd8c3d5b67ec1df61c8a2eff3861207d9234ada |
| core/libs/Audio/dspApplyGain.h | df68e7718f23468d36e1e1a227177aab878006341f19af019d550f134fea436f |
| core/libs/Audio/dspApplyGain.cpp | c801e6715bbfeaaec3f475d8639eb58e5be1dfaa4336cda4101a1346456fbbf8 |
| core/libs/Audio/analyze_rms.h | 7fd3f0616ca4a7e708555056b92011e8b77880ba6f9a36f2613327c8d88d6784 |
| core/libs/Audio/analyze_rms.cpp | 99b4a509216823a1d1e1247a3045a13f841d6f8ac23634db687c9c112ceb4b8a |
| core/libs/Audio/effect_shortDelay.h | 6a69dc75f5d1310f3bbb4d0f5273306f38ba3ccbad2780a79a21e740a0ee6b13 |
| core/libs/Audio/effect_shortDelay.cpp | d8b5b0edb184397b7bc0236b7579d505047d8e51143a34ecb26743ba4235978a |
| core/libs/Audio/effect_polyverb.h | a80b507ccbdd6c7405d4fb069a3cf04e287e59897c9e97a817809de7e0002690 |
| core/libs/Audio/effect_polyverb.cpp | 785c082afe71d8e3f893d0894bf715f74633a420beaca64738646b1390e4f137 |
| core/libs/Audio/effect_limiter.h | f73b43a45a107e70cd6f4b086d40e893d4678a0ddd0b05831c641624860f90ec |
| core/libs/Audio/effect_limiter.cpp | b839025c9293edba4024665d97ccbdf284bc43b1c666265d9fb3a41b6403f248 |
| core/libs/Audio/Polyverb/cosine_oscillator.h | 2bce42d5bc1e58867829d547df48a5d69ffa082f3620a3276eaf972ab1b018f6 |
| core/libs/Audio/Polyverb/fx_engine.h | 07d172635bb3e206f9b1e5cf1ecba5e7f497e893297002323f1d6091d7d8d8d1 |
| core/libs/Audio/Polyverb/reverb.h | ace0e5c5a15746db37927350d624217111cc68ba760924cb4de60308dd8e4858 |
| core/source/util_math.h | ec7d3d4f5f1d0498ec5fc140c835f0f30239b1c338422fdf764abb71d263a144 |
| core/source/interruptsControl.h | 816878a0e1accbb4501960a06fbec0f88f5a810157bda22d24071d742b7d5a0a |
| core/AudioEngine/MixerAndFxs.h | dcdc3a525c7a4593b6e4efa1d667068ae44350eb2a86cc78c37c0296e89f520f |
| core/AudioEngine/MixerAndFxs.cpp | 1b8809bf4267f9c4850a7ebea61766b39140b79c689cdbb31c9c612867acd16d |
| core/AudioEngine/ConstantValues/ampLogarythmicValues.h | 57362cf29480a5811aa0379bf9352d9cb11dc6a98375921d5cf7a6f45547c0bc |
| synth-open/sat_softknee.h | 6768047fdf89db2ee424d6457b718551c5990282cc32ffe3eeb5ccbd33b720c9 |
| core/libs/Audio/Polyverb/util.h (as vendor/fx/arm/util.h) | c5a1539081742eaf9a553ab8f2cd2306cf97842e4bebffbb09bbb357b33fe49e |
| core/libs/Audio/utility/dspinst.h (as vendor/fx/arm/utility/dspinst.h) | b7ee2554ea7438212bdd2e5ffd9eb1910ccce769ba83a16d09e33275f9b92ddf |

Licences of the files above (the headers are kept as copied, the full texts are in the file headers):

| files | Copyright line in the header | Licence |
| --- | --- | --- |
| core/libs/Audio/mixer.h .cpp, amplifier.h .cpp, analyze_rms.h .cpp, arm/utility/dspinst.h | Copyright (c) 2014, Paul Stoffregen, paul@pjrc.com (Audio Library for Teensy 3.X, funded by PJRC.COM, LLC) | MIT, text in each header, with a development funding notice |
| core/libs/Audio/AudioStream.h .cpp | Copyright (c) 2017 PJRC.COM, LLC. (Teensyduino Core Library) | MIT with one added condition (item 2 of the header: a build system that lists target devices must list PJRC's), text in each header |
| core/libs/Audio/Polyverb/reverb.h, fx_engine.h, cosine_oscillator.h, arm/util.h | Copyright 2014 Emilie Gillet. (Mutable Instruments), adapted for Polyverb by Wojciech Jakóbczyk | MIT, text in each header |
| core/libs/Audio/effect_polyverb.h .cpp | Copyright 2020 Wojciech Jakóbczyk (jakobczyk.woj@gmail.com) | no licence text in the file, part of tracker-ce, so the tracker-ce licence (MIT License with Wholesale Commercial Clone Restriction, vendor/poly/LICENSE-tracker-ce-MIT-clone-restriction) |
| every other file (effect_shortDelay, effect_limiter, dspApplyGain, MixerAndFxs, util_math.h, interruptsControl.h, ampLogarythmicValues.h, synth-open/sat_softknee.h) | no header | Polyend parts of tracker-ce, the tracker-ce licence as above |
