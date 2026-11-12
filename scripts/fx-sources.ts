// The sources and flags of the Tracker's master delay, reverb and limiter (host/fx.cpp around the firmware files of vendor/fx), shared by the wasm build
// (scripts/build-wasm.ts) and the native proof tool (scripts/build-fx.ts). The firmware files are compiled as they are: the only things the editor adds are
// the stand-in headers of host/fx (the firmware's config.h, Audio.h ... and the two files with Cortex-M4 assembly, see vendor/fx/PROVENANCE.md) and these flags,
// which are the device's (-DFEATURE_SYNTH_OPEN selects the synth build's code paths of the delay, the reverb and the mixers, FEATURE_SAT_SOFTKNEE the Soft Knee).
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const F = join(root, "vendor/fx")

/** Include paths of the firmware files and of host/fx.cpp. host/fx comes first: its config.h is the stand-in, the editor's host/config.h is not on this path. */
export const fxIncludes = [
  "-I", join(root, "host/fx"), "-I", join(root, "host/fx/utility"),
  "-I", join(F, "core/libs/Audio"), "-I", join(F, "core/libs/Audio/Polyverb"), "-I", join(F, "core/source"),
  "-I", join(F, "core/AudioEngine"), "-I", join(F, "core/AudioEngine/ConstantValues"), "-I", join(F, "synth-open"),
]
/** Defines of the firmware files (the device build's), and assert.h that the firmware gets with -include. */
export const fxDefs = ["-DFEATURE_SYNTH", "-DFEATURE_SYNTH_OPEN", "-DFEATURE_SAT_SOFTKNEE", "-include", "assert.h", "-Wno-unused-value"]

/** The firmware's own files, unmodified (paths relative to vendor/fx). */
export const fxFirmwareFiles = [
  "core/libs/Audio/AudioStream.cpp", "core/libs/Audio/mixer.cpp", "core/libs/Audio/amplifier.cpp", "core/libs/Audio/analyze_rms.cpp",
  "core/libs/Audio/dspApplyGain.cpp", "core/libs/Audio/effect_shortDelay.cpp", "core/libs/Audio/effect_polyverb.cpp", "core/libs/Audio/effect_limiter.cpp", "core/AudioEngine/MixerAndFxs.cpp",
]
export const fxFirmwareSources = fxFirmwareFiles.map((f) => join(F, f))
/** The glue of the editor, compiled with the engine include set as well (it includes the SDK header of the soft clip). */
export const fxGlue = join(root, "host/fx.cpp")
