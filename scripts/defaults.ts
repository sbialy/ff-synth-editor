// Regenerates the bundled default patches (public/defaults) from the star ratings: every patch rated 4 stars or more in the ratings.json sidecar of a
// rated folder is COPIED into public/defaults/<ENGINE>/, and public/defaults/index.json (the manifest the page and a static build read) is rewritten.
// The patches keep the names of the source folder, so give the patches in the source folders their final names before a regeneration.
// The source folders are only read. Only the engines of the release set are taken (nothing the firmware release lacks).
// Usage: bun scripts/defaults.ts [--min N] <folder> [folder ...]    a folder holds <ENGINE>/ subfolders, each with its ratings.json
// The source folder is required: pass it as an argument or set POLY_RATED_DIRS (colon separated).
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { DEFAULT_MIN_STARS, DEFAULTS_DIR, DEFAULTS_MANIFEST, ratedAtLeast, type DefaultsManifest } from "../server/defaults"
import { ENGINES, FIRMWARE_ENGINES } from "../server/engines"
import { HIDDEN_ENGINES } from "../server/firmware"
import { RATINGS_FILE } from "../server/ratings"

const RELEASE = ENGINES.filter((e) => FIRMWARE_ENGINES.includes(e) && !HIDDEN_ENGINES.includes(e))

/** Collects the rated patches of `folders` and rewrites `out`. Returns the manifest and the files it copied. */
export async function generate(folders: string[], out = DEFAULTS_DIR, min = DEFAULT_MIN_STARS): Promise<{ manifest: DefaultsManifest; sources: Record<string, string> }> {
  const found: Record<string, Map<string, string>> = {} // engine -> name -> source file
  for (const root of folders) {
    for (const engine of RELEASE) {
      const dir = join(root, engine)
      const [sidecar, names] = await Promise.all([readFile(join(dir, RATINGS_FILE), "utf8").catch(() => ""), readdir(dir).catch(() => [] as string[])])
      if (!sidecar) continue
      for (const name of ratedAtLeast(sidecar, names, min)) {
        const m = (found[engine] ??= new Map())
        if (m.has(name)) console.warn(`${engine}/${name}: also in ${root}, keeping ${m.get(name)}`)
        else m.set(name, join(dir, name + ".patch"))
      }
    }
  }
  const manifest: DefaultsManifest = { version: 1, minStars: min, engines: {} }
  const sources: Record<string, string> = {}
  await rm(out, { recursive: true, force: true })
  for (const engine of RELEASE) {
    const m = found[engine]
    if (!m?.size) continue
    manifest.engines[engine] = [...m.keys()].sort((a, b) => a.localeCompare(b))
    await mkdir(join(out, engine), { recursive: true })
    for (const [name, src] of m) { await cp(src, join(out, engine, name + ".patch")); sources[`${engine}/${name}`] = src }
  }
  await mkdir(out, { recursive: true })
  await writeFile(join(out, DEFAULTS_MANIFEST), JSON.stringify(manifest, null, 1) + "\n")
  return { manifest, sources }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  let min = DEFAULT_MIN_STARS
  const i = args.indexOf("--min")
  if (i >= 0) { min = Number(args[i + 1]); args.splice(i, 2) }
  if (!Number.isInteger(min) || min < 1 || min > 5) throw new Error("--min must be 1 to 5")
  const folders = (args.length ? args : (process.env.POLY_RATED_DIRS ?? "").split(":").filter(Boolean)).map((f) => resolve(f))
  if (!folders.length) {
    console.error("usage: bun scripts/defaults.ts [--min N] <folder> [folder ...]\n  a folder holds <ENGINE>/ subfolders, each with a ratings.json\n  or set POLY_RATED_DIRS to the folders, colon separated")
    process.exit(2)
  }
  const { manifest } = await generate(folders, DEFAULTS_DIR, min)
  let total = 0
  for (const [e, n] of Object.entries(manifest.engines)) { total += n.length; console.log(`${e}: ${n.length}`) }
  console.log(`${total} patches rated ${min}+ from ${folders.join(", ")} -> public/defaults`)
}
