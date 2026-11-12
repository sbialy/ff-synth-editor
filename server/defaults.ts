// The bundled default patches: public/defaults/<ENGINE>/<name>.patch plus public/defaults/index.json (the manifest). The page shows them when no patch
// folder is set, and a static build (GitHub Pages) serves them as plain files, so the manifest is the only index: no API lists them.
// scripts/defaults.ts regenerates the set from the ratings.json sidecars (server/ratings.ts) of the folders the user rated in.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseRatings } from "./ratings"

export const DEFAULTS_DIR = join(import.meta.dir, "../public/defaults")
export const DEFAULTS_MANIFEST = "index.json"
/** the default set takes the patches rated at least this many stars */
export const DEFAULT_MIN_STARS = 4

export type DefaultsManifest = { version: 1; minStars: number; engines: Record<string, string[]> }

/** The names (no .patch) of a sidecar text rated at least `min` stars whose file is in `have`, sorted. */
export function ratedAtLeast(sidecar: string, have: Iterable<string>, min = DEFAULT_MIN_STARS): string[] {
  const files = new Set(have)
  return Object.entries(parseRatings(sidecar))
    .filter(([file, stars]) => stars >= min && files.has(file))
    .map(([file]) => file.slice(0, -6))
    .sort((a, b) => a.localeCompare(b))
}

/** The manifest of a defaults folder, or an empty one when there is none. Anything that is not the expected shape reads as empty. */
export function readManifest(dir = DEFAULTS_DIR): DefaultsManifest {
  const empty: DefaultsManifest = { version: 1, minStars: DEFAULT_MIN_STARS, engines: {} }
  try {
    const raw = JSON.parse(readFileSync(join(dir, DEFAULTS_MANIFEST), "utf8"))
    if (raw?.version !== 1 || !raw.engines || typeof raw.engines !== "object") return empty
    const engines: Record<string, string[]> = {}
    for (const [e, names] of Object.entries(raw.engines)) if (Array.isArray(names)) engines[e] = names.filter((n) => typeof n === "string")
    return { version: 1, minStars: Number(raw.minStars) || DEFAULT_MIN_STARS, engines }
  } catch {
    return empty
  }
}

/** The file of a bundled patch, or null when the manifest does not list it. Only listed names resolve, so no path can leave the folder. */
export function defaultPatchPath(engine: string, name: string, dir = DEFAULTS_DIR): string | null {
  if (!readManifest(dir).engines[engine]?.includes(name)) return null
  const path = join(dir, engine, name + ".patch")
  return existsSync(path) ? path : null
}
