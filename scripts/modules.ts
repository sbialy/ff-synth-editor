// Fetches the runtime modules of modules.lock.json into build/modules/<set>/ and checks them: sha256 of every file against the lock, every manifest
// against this host's plugin SDK (host/sdk: plug_abi.h ABI major and host level, plug_wasm.h module ABI major), every synth engine against the
// firmware this editor is pinned to (vendor/FIRMWARE.json engines, and its numbers against vendor/poly/synth-open/engine_list.h) and the
// manifest's visibility against the set's. Writes build/modules/index.json, which the page and the tests read. Nothing of a module's source is involved.
//
// Four sets, one loader, the module repositories tracker-ff 1.2.0 ships plugins from (its engines/external.lock.json pins the same tags):
// "engines-os" and "effects-os" are public (the OpenTracker ports, ten synth engines and five master inserts) and published as GitHub releases.
// "engines" and "effects" hold the FF modules (PHZ and PLK, Console and Tube): the lock does not name their repository, "repo_env" names the environment
// variable that does (MODULES_ENGINES_REPO, MODULES_EFFECTS_REPO, owner/name), and the download needs a GH_TOKEN that can read it. The editor cannot tell
// the sets apart except by where the lock says they come from.
//
// POLY_MODULES_DIR installs somewhere else than build/modules (the tests use a temp directory, server/modules-dir.ts).
//
// Usage: bun scripts/modules.ts [--from] [--update] [--sets engines,effects] [--optional] [--out dir]
//   --from     copies from each set's from_dir (the local stand-in, modules.local.json, git ignored), without it the release assets of each set's
//              tag are downloaded with gh (gh release download <tag> -R <repo>).
//   (fetchModules' downloadIfStale option, used by the tests: with --from, a set whose local copy is missing or behind the lock is downloaded instead)
//   --sets     only these sets (the main page needs "engines" alone: PHZ and PLK)
//   --optional a set that cannot be fetched (no access, or its repo_env variable is not set) is left out with a warning instead of stopping the run.
//              The editor then starts without the engines and inserts of that set
//   --out      writes the sets and index.json into dir instead of build/modules (the static site build, scripts/pages.ts and .github/workflows/pages.yml,
//              uses its own directory so the tests' build/modules is never touched)
//   --update   rewrites the sha256 table of modules.lock.json from the from_dirs (after rebuilding a set), then checks as usual. A published set is
//              left alone: its GitHub release is the truth, its hashes are the ones of the firmware's engines/external.lock.json.
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { firmware } from "../server/firmware"
import { modulesDir } from "../server/modules-dir"

const root = join(import.meta.dir, "..")
export { modulesDir }
/** overrides: a module of the set that is not the tag's (an engine rebuilt from a later commit), keyed by module id, its wasm pinned twice (files and here) */
type Override = { commit: string; version: string; wasm_sha256: string; plg_sha256?: string }
type Set = { visibility: "public" | "private"; repo?: string; repo_env?: string; tag: string; tag_commit?: string; tag_status?: "published" | "local" | "planned"; from_dir?: string; also_from?: string[]; files: Record<string, string>; overrides?: Record<string, Override> }
type Lock = { _comment?: string; format_version: number; sets: Record<string, Set> }
const lockFile = join(root, "modules.lock.json")
export const lock: Lock = JSON.parse(readFileSync(lockFile, "utf8"))
// local stand-ins for --from (modules.local.json, git ignored): from_dir and also_from per set. Not enumerable, so updateLock never writes them into the lock.
const localFile = join(root, "modules.local.json")
if (existsSync(localFile)) {
  const local: Record<string, { from_dir?: string; also_from?: string[] }> = JSON.parse(readFileSync(localFile, "utf8"))
  for (const [name, l] of Object.entries(local))
    if (lock.sets[name]) for (const k of ["from_dir", "also_from"] as const) if (l[k]) Object.defineProperty(lock.sets[name], k, { value: l[k], enumerable: false, writable: true })
}
/** owner/name of the repository a set is downloaded from: the lock names a public one, a private one comes from the environment variable repo_env names */
export const repoOf = (s: Set): string => {
  const r = s.repo ?? (s.repo_env ? process.env[s.repo_env] : undefined)
  if (!r) throw new Error(`no repository for this set: environment variable ${s.repo_env} is not set`)
  return r
}
/** what a message may say about a set's repository: the name of a public one, nothing of a private one */
const repoLabel = (s: Set) => (s.visibility === "public" && s.repo ? s.repo : "module repository")

const def = (file: string, name: string) => Number(readFileSync(join(root, "host/sdk", file), "utf8").match(new RegExp(`#define\\s+${name}\\s+(\\d+)`))![1])
export const sdk = { abiMajor: def("plug_abi.h", "PLUG_ABI_MAJOR"), hostLevel: def("plug_abi.h", "PLUG_HOST_LEVEL"), wasmAbiMajor: def("plug_wasm.h", "PLUG_WASM_ABI_MAJOR") }
export const fromDir = (s: Set) => (s.from_dir ?? "").replace(/^~/, homedir())
export const setDir = (name: string) => join(modulesDir(), name)

/** The firmware's own numbers of an engine: its engine_list.h line (stored number, type id, .patch engine id). */
export function engineListNumbers(name: string): { stored: number; typeId: number; patchEngine: number } | undefined {
  const t = readFileSync(join(root, "vendor/poly/synth-open/engine_list.h"), "utf8")
  const m = t.match(new RegExp(`SYNTH_ENGINE\\(${name}, (\\d+), (?:static_cast<polysynth::InstrumentTypeId>\\()?([^,)]+)\\)?, \\w+, \\w+, ([0-9xA-Fa-f]+),`))
  if (!m) return undefined
  const typeId = /^0x/i.test(m[2]) ? Number(m[2]) : NaN
  return { stored: Number(m[1]), typeId, patchEngine: Number(m[3]) }
}

/** Every reason this editor refuses the manifest of a module (empty: compatible). setVisibility: what the lock says about the set it came in. */
export function compatProblems(man: any, setVisibility?: string): string[] {
  const p: string[] = []
  const major = (s: string) => Number(String(s).split(".")[0])
  if (man.format !== "ffmod" || man.format_version !== 1) p.push("not an ffmod manifest")
  if (major(man.abi) !== sdk.abiMajor) p.push(`plugin ABI ${man.abi}, this editor has ${sdk.abiMajor}.x`)
  if (major(man.wasm_abi) !== sdk.wasmAbiMajor) p.push(`module ABI ${man.wasm_abi}, this editor loads ${sdk.wasmAbiMajor}.x`)
  if (man.min_host > sdk.hostLevel) p.push(`needs host level ${man.min_host}, this editor is ${sdk.hostLevel}`)
  if (setVisibility && man.visibility !== setVisibility) p.push(`the manifest says ${man.visibility}, the set is ${setVisibility}`)
  if (man.kind === "synth") {
    if (!firmware.engines.includes(man.name)) p.push(`${man.name} is not an engine of ${firmware.label}`)
    const n = engineListNumbers(man.name)
    if (!n) p.push(`${man.name} has no engine_list.h entry in vendor/`)
    else if (n.stored !== man.synth.stored || n.typeId !== man.synth.type_id || n.patchEngine !== man.synth.patch_engine)
      p.push(`${man.name} numbers ${man.synth.stored}/${man.synth.type_id}/${man.synth.patch_engine}, ${firmware.label} has ${n.stored}/${n.typeId}/${n.patchEngine}`)
  } else if (man.kind !== "master") p.push(`unknown kind ${man.kind}`)
  return p
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex")
/** The files of a set directory the editor takes: modules, manifests, notices, LICENSE.md and licence texts (not .plg, SET.json, SHA256SUMS). */
const takes = (f: string) => /\.wasm$/.test(f) || (/\.json$/.test(f) && !["SET.json", "MODULES.json"].includes(f)) || f === "NOTICE.md" || f === "LICENSE.md" || /^LICENSE.*\.txt$/.test(f)

/** Rewrites the sha256 table of every set from its from_dir. */
export function updateLock() {
  for (const set of Object.values(lock.sets)) {
    if (set.tag_status === "published") continue
    const dir = fromDir(set)
    if (!set.from_dir) throw new Error("--update needs from_dir, see modules.local.json")
    set.files = Object.fromEntries(readdirSync(dir).filter(takes).sort().map((f) => [f, sha(join(dir, f))]))
  }
  writeFileSync(lockFile, JSON.stringify(lock, null, 1) + "\n")
}

/** The release assets of a set's tag, downloaded with gh into a fresh temp directory (the published truth, what the lock's hashes are of). */
function downloadSet(set: Set): string {
  const src = mkdtempSync(join(tmpdir(), "poly-modules-"))
  const p = Bun.spawnSync(["gh", "release", "download", set.tag, "-R", repoOf(set), "-D", src, ...Object.keys(set.files).flatMap((f) => ["-p", f])])
  if (p.exitCode !== 0) throw new Error(`gh release download ${set.tag} -R ${repoLabel(set)}: ${p.stderr.toString()}`)
  return src
}

export function fetchModules(from: boolean, opts: { sets?: string[]; optional?: boolean; out?: string; downloadIfStale?: boolean } = {}) {
  const outDir = opts.out ?? modulesDir()
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const index: any[] = []
  const have: string[] = []
  for (const [setName, set] of Object.entries(lock.sets)) {
    if (opts.sets && !opts.sets.includes(setName)) continue
    const install = (src: string) => {
      const before = index.length
      try { fetchSet(setName, set, src, index, join(outDir, setName)) } catch (e) { index.length = before; rmSync(join(outDir, setName), { recursive: true, force: true }); throw e }
    }
    try {
      try {
        if (from && !set.from_dir) throw new Error(`--from needs from_dir of the set in modules.local.json`)
        install(from ? fromDir(set) : downloadSet(set))
      } catch (e) {
        // downloadIfStale: a local stand-in that is missing or behind the lock (a rebuilt notice, a re-pinned manifest) is replaced by the published release
        if (!from || !opts.downloadIfStale) throw e
        console.warn(`modules: set ${setName} is not at a local stand-in as the lock pins it (${String((e as Error).message ?? e).split("\n")[0]}), downloading ${set.tag} of ${repoLabel(set)}`)
        install(downloadSet(set))
      }
      have.push(setName)
    } catch (e) {
      if (!opts.optional) throw e
      rmSync(join(outDir, setName), { recursive: true, force: true })
      for (let i = index.length - 1; i >= 0; i--) if (index[i].set === setName) index.splice(i, 1)
      console.warn(`modules: set ${setName} (${repoLabel(set)} ${set.tag}) left out: ${String((e as Error).message ?? e).split("\n")[0]}`)
    }
  }
  writeFileSync(join(outDir, "index.json"), JSON.stringify({ firmware: firmware.tag, host: { abi: `${sdk.abiMajor}.${def("plug_abi.h", "PLUG_ABI_MINOR")}`, wasmAbi: `${sdk.wasmAbiMajor}.${def("plug_wasm.h", "PLUG_WASM_ABI_MINOR")}`, level: sdk.hostLevel },
    sets: Object.fromEntries(Object.entries(lock.sets).filter(([n]) => have.includes(n)).map(([n, s]) => [n, { ...(s.visibility === "public" ? { repo: s.repo } : {}), tag: s.tag, visibility: s.visibility, notice: s.files["NOTICE.md"] ? `${n}/NOTICE.md` : null }])), modules: index }, null, 1) + "\n")
  return index
}

function fetchSet(setName: string, set: Set, src: string, index: any[], dst = setDir(setName)) {
  for (const [id, o] of Object.entries(set.overrides ?? {}))
    if (set.files[`${id}.wasm`] !== o.wasm_sha256) throw new Error(`${setName}: the override of ${id} pins wasm ${o.wasm_sha256}, the files table ${set.files[`${id}.wasm`]}`)
  {
    mkdirSync(dst, { recursive: true })
    for (const [f, want] of Object.entries(set.files)) {
      // from_dir, then also_from (local stand-ins only, a release download has every file in one place): the first copy with the pinned sha256
      const found = [src, ...(src === fromDir(set) ? (set.also_from ?? []).map((d) => d.replace(/^~/, homedir())) : [])].map((d) => join(d, f)).filter((q) => existsSync(q))
      const p = found.find((q) => sha(q) === want) ?? found[0] ?? join(src, f)
      if (!existsSync(p)) throw new Error(`${setName} ${set.tag}: ${f} missing in ${src}`)
      const got = sha(p)
      if (got !== want) throw new Error(`${setName} ${set.tag}: ${f} sha256 ${got}, modules.lock.json says ${want}`)
      copyFileSync(p, join(dst, f))
    }
    for (const f of Object.keys(set.files).filter((f) => f.endsWith(".json"))) {
      const man = JSON.parse(readFileSync(join(dst, f), "utf8"))
      const probs = compatProblems(man, set.visibility)
      if (probs.length) throw new Error(`${setName} ${f}: ${probs.join(", ")}`)
      if (set.files[man.files.wasm.name] !== man.files.wasm.sha256) throw new Error(`${f}: its wasm sha256 is not the lock's`)
      index.push({ set: setName, tag: set.tag, ...(set.visibility === "public" ? { repo: set.repo } : {}), visibility: set.visibility, manifest: `${setName}/${f}`, wasm: `${setName}/${man.files.wasm.name}`,
        kind: man.kind, name: man.name, id: man.id, version: man.version, licence: man.licence })
    }
  }
}

if (import.meta.main) {
  if (process.argv.includes("--update")) updateLock()
  const si = process.argv.indexOf("--sets")
  const oi = process.argv.indexOf("--out")
  const out = oi > 0 ? resolve(process.argv[oi + 1]!) : undefined
  const idx = fetchModules(process.argv.includes("--from"), { sets: si > 0 ? process.argv[si + 1]!.split(",") : undefined, optional: process.argv.includes("--optional"), out })
  for (const m of idx) console.log(`${m.kind.padEnd(6)} ${m.name.padEnd(8)} ${m.version} (${m.set} ${m.visibility}, ${m.tag}) -> ${relative(process.cwd(), join(out ?? modulesDir(), m.wasm))}`)
}
