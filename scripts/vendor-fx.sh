#!/bin/sh
# Copies the firmware sources of the Tracker's master delay, reverb and limiter into vendor/fx, byte for byte (the firmware's core/ files have CRLF line
# endings, they stay: .gitattributes marks vendor/fx as -text). Read with git archive from a commit, never from a working tree.
# Usage: scripts/vendor-fx.sh [commit] [path-to-tracker-ff-checkout]      (default d3e6c73, the release-1.2.0 tip the 1.2.0 images are built from, checkout from POLY_REPO)
# The editor's other firmware pin (vendor/FIRMWARE.json) is the tracker-ff 1.1.0 tag. The delay, the reverb, the mixers and MixerAndFxs are identical
# at both, the differences are AudioStream.cpp (AudioConnection::connect bound, needed by the 13 input send mixers) and dspApplyGain.cpp (Soft Knee),
# so this set comes from the 1.2.0 tip. test/fx.test.ts checks the list and the hashes.
set -eu
COMMIT_IN="${1:-d3e6c73}"
REPO="${2:-${POLY_REPO:?vendor-fx.sh: pass the tracker-ff checkout as the second argument or set POLY_REPO}}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DST="$HERE/vendor/fx"
COMMIT="$(git -C "$REPO" rev-parse --verify -q "$COMMIT_IN^{commit}")" || { echo "vendor-fx.sh: commit $COMMIT_IN not found in $REPO" >&2; exit 1; }
FILES="core/libs/Audio/AudioStream.h core/libs/Audio/AudioStream.cpp core/libs/Audio/mixer.h core/libs/Audio/mixer.cpp core/libs/Audio/amplifier.h core/libs/Audio/amplifier.cpp
core/libs/Audio/dspApplyGain.h core/libs/Audio/dspApplyGain.cpp core/libs/Audio/analyze_rms.h core/libs/Audio/analyze_rms.cpp
core/libs/Audio/effect_shortDelay.h core/libs/Audio/effect_shortDelay.cpp core/libs/Audio/effect_polyverb.h core/libs/Audio/effect_polyverb.cpp
core/libs/Audio/effect_limiter.h core/libs/Audio/effect_limiter.cpp
core/libs/Audio/Polyverb/cosine_oscillator.h core/libs/Audio/Polyverb/fx_engine.h core/libs/Audio/Polyverb/reverb.h
core/source/util_math.h core/source/interruptsControl.h
core/AudioEngine/MixerAndFxs.h core/AudioEngine/MixerAndFxs.cpp core/AudioEngine/ConstantValues/ampLogarythmicValues.h
synth-open/sat_softknee.h"
# the two files with inline Cortex-M4 assembly: kept apart, off every include path of the arm64 and wasm builds (host/fx has their portable stand-ins), used by the
# Cortex-M4 reference build of test/fx-m4 (vendor/fx/arm/util.h and vendor/fx/arm/utility/dspinst.h)
ARM="core/libs/Audio/Polyverb/util.h core/libs/Audio/utility/dspinst.h"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
git -C "$REPO" archive "$COMMIT" $FILES $ARM | tar -x -C "$TMP"
rm -rf "$DST"; mkdir -p "$DST"
(cd "$TMP" && tar -c $FILES) | tar -x -C "$DST"
mkdir -p "$DST/arm/utility"
cp "$TMP/core/libs/Audio/Polyverb/util.h" "$DST/arm/util.h"
cp "$TMP/core/libs/Audio/utility/dspinst.h" "$DST/arm/utility/dspinst.h"
{
  echo "# Vendored firmware sources of the master delay, reverb and limiter"
  echo
  echo "Copied byte for byte (CRLF kept) by scripts/vendor-fx.sh from commit $COMMIT ($(git -C "$REPO" log -1 --format=%cs "$COMMIT")) of the firmware repository, read with git archive."
  echo "Nothing in these files is edited. The editor's own stand-ins for the firmware headers they include (config.h, Audio.h, mtStructs.h, mtSequencer.h, mtAudioEngine.h,"
  echo "mtAudioExport.h) are in host/fx."
  echo
  echo "| file | sha256 |"
  echo "| --- | --- |"
  for f in $FILES; do echo "| $f | $(shasum -a 256 "$DST/$f" | cut -d' ' -f1) |"; done
  echo "| core/libs/Audio/Polyverb/util.h (as vendor/fx/arm/util.h) | $(shasum -a 256 "$DST/arm/util.h" | cut -d' ' -f1) |"
  echo "| core/libs/Audio/utility/dspinst.h (as vendor/fx/arm/utility/dspinst.h) | $(shasum -a 256 "$DST/arm/utility/dspinst.h" | cut -d' ' -f1) |"
  echo 
  echo 'Licences of the files above (the headers are kept as copied, the full texts are in the file headers):'
  echo 
  echo '| files | Copyright line in the header | Licence |'
  echo '| --- | --- | --- |'
  echo '| core/libs/Audio/mixer.h .cpp, amplifier.h .cpp, analyze_rms.h .cpp, arm/utility/dspinst.h | Copyright (c) 2014, Paul Stoffregen, paul@pjrc.com (Audio Library for Teensy 3.X, funded by PJRC.COM, LLC) | MIT, text in each header, with a development funding notice |'
  echo '| core/libs/Audio/AudioStream.h .cpp | Copyright (c) 2017 PJRC.COM, LLC. (Teensyduino Core Library) | MIT with one added condition (item 2 of the header: a build system that lists target devices must list PJRC'\''s), text in each header |'
  echo '| core/libs/Audio/Polyverb/reverb.h, fx_engine.h, cosine_oscillator.h, arm/util.h | Copyright 2014 Emilie Gillet. (Mutable Instruments), adapted for Polyverb by Wojciech Jakóbczyk | MIT, text in each header |'
  echo '| core/libs/Audio/effect_polyverb.h .cpp | Copyright 2020 Wojciech Jakóbczyk (jakobczyk.woj@gmail.com) | no licence text in the file, part of tracker-ce, so the tracker-ce licence (MIT License with Wholesale Commercial Clone Restriction, vendor/poly/LICENSE-tracker-ce-MIT-clone-restriction) |'
  echo '| every other file (effect_shortDelay, effect_limiter, dspApplyGain, MixerAndFxs, util_math.h, interruptsControl.h, ampLogarythmicValues.h, synth-open/sat_softknee.h) | no header | Polyend parts of tracker-ce, the tracker-ce licence as above |'
} > "$DST/PROVENANCE.md"
echo "vendor/fx: $(echo $FILES | wc -w | tr -d ' ') files from $COMMIT"
