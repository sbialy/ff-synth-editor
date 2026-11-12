// The engine list of the editor, in the order of the UI: OpenTracker 2.x (ACD FAT VAP WTFM PERC, clean-room DSP under the stock engine names), then CHIP (Polyend's own open code from tracker-ce), PHZ, then the OpenTracker 3.x module engines, then Pluck.
// Names are the Patches/<NAME>/ folder names (a 3.x module engine uses its SynthDescriptor name, e.g. DTYPE for "D-Type").
import { firmware, HIDDEN_ENGINES } from "./firmware"
/** engines served by the API but left out of /api/engines and so out of the page (none since tracker-ff 1.2.0) */
export { HIDDEN_ENGINES }

export const POLYEND_ENGINES = ["ACD", "FAT", "VAP", "WTFM", "PERC", "CHIP", "PHZ"] as const
/** engines in no tracker-ff release. None: Pluck (PLK), the last one, is a release engine since tracker-ff 1.2.0 */
export const EXPERIMENTAL_ENGINES: readonly string[] = []
/** engine name -> opentracker-synths module folder */
export const OT3_MODULES: Record<string, string> = {
  FM4: "fm4", JU6: "ju6", DTYPE: "dtype", CSTYPE: "cstype", ATYPE: "atype", TTYPE: "ttype", "8TYPE": "eight", HANDTYPE: "hand", BTYPE: "btype", ARCTYPE: "arc",
}
export const ENGINES: string[] = [...POLYEND_ENGINES, ...Object.keys(OT3_MODULES), "PLK", ...EXPERIMENTAL_ENGINES]

/**
 * The engines of the release image of the pinned firmware (vendor/FIRMWARE.json: the six built in plus the plugin engines that
 * engines/engines.json ships): the engines "on your Tracker". All 18 since tracker-ff 1.2.0.
 */
export const FIRMWARE_ENGINES: readonly string[] = firmware.releaseEngines
export const NOT_IN_RELEASE: readonly string[] = firmware.notInRelease
