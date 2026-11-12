// The firmware this editor is pinned to: vendor/FIRMWARE.json, written by scripts/vendor.sh from a tracker-ff release tag. This is the
// only place that file is read. The build (scripts/build.ts), the server, the page (through /api/engines) and test/sync.test.ts use it.
import { readFileSync } from "node:fs"
import { join } from "node:path"

export type Firmware = {
  name: string
  /** release tag, e.g. tracker-ff-v1.1.0 */
  tag: string
  /** e.g. 1.1.0 */
  version: string
  commit: string
  tagObject: string
  commitDate: string
  /** "tracker-ff 1.1.0" */
  label: string
  /** every engine of the firmware: built in and plugin (engines.mk SYNTH_ENGINES_ALL and SYNTH_ENGINES_EXT), in the order of engine_list.h */
  engines: string[]
  defaultEngines: string[]
  /** the engines of the release image */
  releaseEngines: string[]
  /** in the firmware tree and the editor, not in the release image */
  notInRelease: string[]
  /** the engines built into the firmware image (engines.mk SYNTH_ENGINES_ALL, the stock six); the rest of `engines` are card plugins */
  builtinEngines: string[]
  /**
   * The public module repository of the OpenTracker 3.x engines (tracker-engines-os), at the tag and commit the firmware tag pins in
   * engines/external.lock.json: their engine tables and DSP are vendored from it and compiled into the native host.
   */
  modules: {
    repo: string
    tag: string
    commit: string
    engines: string[]
    /** relative to vendor/poly */
    files: string[]
  }
  /**
   * The closed source engines: the clean-room PHZ and PLK, our own code. They run as runtime modules built from a release tag of their own repository
   * (the "engines" set that modules.lock.json pins), their source is not in this repository. The native host is built without the files listed here.
   */
  private: {
    repo: string
    tag: string
    commit: string
    /** one engine built from a later commit than the tag (PLK 1.1, the PLK of the tracker-ff 1.2.0 release zip), modules.lock.json "overrides" */
    override: { engine: string; commit: string; version: string; wasm_sha256: string; plg_sha256: string } | null
    /** engine names */
    engines: string[]
    /** relative to vendor/poly */
    files: string[]
  }
  /** the sources the host compiles, relative to vendor/poly */
  sources: string[]
}

export const firmwareFile = join(import.meta.dir, "../vendor/FIRMWARE.json")
export const firmware: Firmware = JSON.parse(readFileSync(firmwareFile, "utf8"))

/**
 * Engines the host builds and the API still serves that the page does not offer. /api/engines leaves them out of the engine list and out of
 * the firmware info too, whatever the Strict toggle says. Empty since tracker-ff 1.2.0: Hand-Type is in the release set.
 */
export const HIDDEN_ENGINES: readonly string[] = []

/** What the page needs: no source list, and no name of a hidden engine. */
export function firmwareInfo(release = false) {
  const { sources: _sources, ...rest } = firmware
  const shown = (names: string[]) => names.filter((n) => !HIDDEN_ENGINES.includes(n))
  if (release) { // the release build names nothing but the tag: no module pins, no engine the release image leaves out
    const { private: _p, modules: _m, notInRelease: _n, ...r } = rest
    return { ...r, engines: shown(r.releaseEngines), defaultEngines: shown(r.defaultEngines).filter((n) => r.releaseEngines.includes(n)), releaseEngines: shown(r.releaseEngines), matches: `matches ${firmware.label}` }
  }
  return { ...rest, engines: shown(rest.engines), defaultEngines: shown(rest.defaultEngines), releaseEngines: shown(rest.releaseEngines), notInRelease: shown(rest.notInRelease), matches: `matches ${firmware.label}` }
}
