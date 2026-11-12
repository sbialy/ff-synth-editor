// Builds the editor host as WebAssembly (emscripten), into build/wasm/<target>/poly.mjs + poly.wasm. Two targets:
//  - linked:  every engine of vendor/FIRMWARE.json linked in, PHZ and PLK too. DEV ONLY: it needs their unpublished source (POLY_PRIVATE_SOURCE=1 scripts/vendor.sh), the
//             public build never makes it. The reference the runtime target is checked against.
//  - runtime: the same, minus the engines that arrive as runtime modules (RUNTIME_ENGINES: PHZ and PLK from the engines set, JU6 from the public one). Their slots in the
//             firmware's engine list stay (the public numbers of engine_list.h), their code comes from <id>.wasm at run time (public/ffmod.js).
// Both have the two master insert slots (host/modules.cpp), the inserts are always runtime modules.
// The engine module flags of the module repositories (their wasm.json "cxxflags") must equal `common` below.
// Usage: bun scripts/build-wasm.ts [linked|runtime|all] [--force]       EMSDK=/path/to/emsdk (default ~/emsdk)
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative } from "node:path"
import { firmware } from "../server/firmware"
import { fxDefs, fxFirmwareSources, fxGlue, fxIncludes } from "./fx-sources"

const root = join(import.meta.dir, "..")
const v = join(root, "vendor/poly")
// emsdk 6.0.13 (pinned: the module manifests record it). Default: $EMSDK, else ~/emsdk.
export const EMSDK = process.env.EMSDK ?? join(homedir(), "emsdk")
export const EMCC_VERSION = "6.0.13"
const em = (tool: string) => join(EMSDK, "upstream/emscripten", tool)

/** The engines this build leaves to runtime modules, with the sources they would otherwise add (vendor/FIRMWARE.json "sources"). */
export const RUNTIME_ENGINES: Record<string, string[]> = {
  PHZ: ["synth-open/engine_phz.cpp", "synth-open/phz/phz.cpp"], // ours, the engines set
  PLK: ["synth-open/engine_pluck.cpp", "synth-open/pluck/pluck.cpp"], // ours, the engines set
  JU6: ["synth-open/engine_ju6.cpp", "synth-open/ot-synths/ju6/ju6.cpp"], // a public OpenTracker port, built and published by the firmware repository
}

/** The compile flags every engine source gets in the wasm host. A runtime engine module must be built with exactly these. */
export const common = [
  "-std=c++20", "-O2", "-DTINY_OPTIONAL_x86", "-D_GLIBCXX_THROW_OR_ABORT(x)=__builtin_abort()", "-DFEATURE_SYNTH_OPEN", "-DOPEN_HOST_TEST",
]
const includes = [
  "-I", join(root, "host/wasm-compat"), "-include", join(root, "host/wasm-compat/midisink_stub.h"),
  "-I", join(root, "host/compat"), "-I", join(v, "synth/include"), "-I", join(v, "util/include"), "-I", join(v, "util/3rdparty"),
  "-I", join(v, "synth-open"), "-I", join(v, "synth-open/ot"), "-I", join(root, "host"), "-I", join(root, "host/sdk"),
  "-I", join(v, "core/synth"), "-I", join(v, "core/synth/engines"),
]
const engineDefs = firmware.engines.map((n) => `-DSYNTH_ENGINE_${n}`)
const exportsList = ["_ph_request", "_ph_block", "_ph_voices", "_ph_held", "_malloc", "_free", "_ffm_host", "_ffm_abi", "_ffm_wasm_abi", "_ffm_host_level",
  "_ffm_attach_synth", "_ffm_insert_set", "_ffm_insert_param", "_ffm_insert_bypass", "_ffm_insert_reset", "_ffm_buf", "_ffm_insert_process_raw",
  "_ffm_chain_buf", "_ffm_mixer_set", "_ffm_chain_active", "_ffm_fx_params", "_ffm_fx_apply", "_ffm_fx_reset", "_ffm_engine_active", "_ffm_engine_block", "_ffm_fx_table"]
const link = [
  "-O2", "-fwasm-exceptions", "-sMODULARIZE", "-sEXPORT_ES6", "-sALLOW_MEMORY_GROWTH", "-sALLOW_TABLE_GROWTH", "-sENVIRONMENT=web,worker,node",
  `-sEXPORTED_FUNCTIONS=${exportsList.join(",")}`, "-sEXPORTED_RUNTIME_METHODS=ccall,UTF8ToString,FS,HEAPU8,HEAPF32,HEAPU32,wasmTable,wasmMemory",
]

export type Target = "linked" | "runtime"
export const outDir = (t: Target) => join(root, "build/wasm", t)

/** The unpublished source files the "linked" target needs (vendor/FIRMWARE.json "private"), missing unless scripts/vendor.sh was run with POLY_PRIVATE_SOURCE=1. */
export const missingPrivateSource = () => firmware.private.files.filter((f) => !existsSync(join(v, f)))

function sourcesOf(t: Target): { src: string; flags: string[]; includes?: string[] }[] {
  const skip = new Set(t === "runtime" ? Object.values(RUNTIME_ENGINES).flat() : [])
  const fw = firmware.sources.filter((f) => !skip.has(f)).map((f) => ({ src: join(v, f), flags: [] as string[] }))
  const own: { src: string; flags: string[]; includes?: string[] }[] = [
    { src: join(root, "host/poly_host.cpp"), flags: [] },
    { src: join(v, "util/3rdparty/fmt/format.cc"), flags: [] },
    { src: join(root, "host/modules.cpp"), flags: t === "runtime" ? ["-DFFM_RUNTIME"] : [] },
  ]
  // the Tracker's master delay and reverb: the firmware's files as they are (vendor/fx) with the device's defines, and the editor's glue around them (host/fx.cpp). The glue
  // gets the engine include set too (it includes the SDK header of the soft clip), after host/fx so the stand-in config.h wins.
  for (const src of fxFirmwareSources) own.push({ src, flags: fxDefs, includes: fxIncludes })
  own.push({ src: fxGlue, flags: fxDefs, includes: [...fxIncludes, ...includes] })
  // the empty, mutable definition of a runtime engine is not the const one open_engine.h declares with -DSYNTH_ENGINE_<NAME>
  if (t === "runtime") own.push({ src: join(root, "host/runtime_def.cpp"), flags: Object.keys(RUNTIME_ENGINES).map((n) => `-USYNTH_ENGINE_${n}`) })
  return [...own, ...fw]
}

function newestUnder(dir: string): number {
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    n = Math.max(n, e.isDirectory() ? newestUnder(p) : statSync(p).mtimeMs)
  }
  return n
}

async function run(cmd: string[]): Promise<{ code: number; err: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, EM_CACHE: join(EMSDK, "upstream/emscripten/cache") } })
  const [err] = await Promise.all([new Response(p.stderr).text(), new Response(p.stdout).text()])
  return { code: await p.exited, err }
}

export async function buildWasm(t: Target, force = false): Promise<{ rebuilt: number; out: string }> {
  if (!existsSync(em("em++"))) throw new Error(`no emscripten at ${EMSDK} (set EMSDK)`)
  if (t === "linked" && missingPrivateSource().length)
    throw new Error(`the linked target is the dev-only reference with PHZ and PLK compiled in, it needs their unpublished source (${missingPrivateSource().join(" ")}): run POLY_PRIVATE_SOURCE=1 scripts/vendor.sh`)
  const ver = await run([em("emcc"), "--version"])
  const obj = join(root, "build/wasm", `obj-${t}`)
  mkdirSync(obj, { recursive: true })
  mkdirSync(outDir(t), { recursive: true })
  const jobs = sourcesOf(t).map((s) => ({ ...s, obj: join(obj, relative(root, s.src).replace(/[\/.]/g, "_") + ".o") }))
  // an object of an engine that now arrives at run time must not stay behind from an older build (the tests look at the directory)
  const want = new Set(jobs.map((j) => j.obj))
  for (const f of readdirSync(obj)) if (!want.has(join(obj, f))) rmSync(join(obj, f))
  // the master graph's sources include the stand-in headers of host/fx and each other's headers: any of them newer than the object rebuilds it (a header edit would otherwise leave a stale object)
  const fxStamp = Math.max(newestUnder(join(root, "vendor/fx")), newestUnder(join(root, "host/fx")), statSync(join(root, "host/fx.h")).mtimeMs)
  const isFx = (src: string) => src.startsWith(join(root, "vendor/fx")) || src === fxGlue
  const todo = jobs.filter((j) => force || !existsSync(j.obj) || statSync(j.obj).mtimeMs < Math.max(statSync(j.src).mtimeMs, isFx(j.src) ? fxStamp : 0))
  const res = await Promise.all(todo.map(async (j) => ({ j, r: await run([em("em++"), ...common, "-fwasm-exceptions", ...(j.includes ?? includes), ...engineDefs, ...j.flags, "-c", j.src, "-o", j.obj]) })))
  const bad = res.filter((x) => x.r.code !== 0)
  if (bad.length) throw new Error("compile failed:\n" + bad.map((b) => `${b.j.src}\n${b.r.err}`).join("\n"))
  const out = join(outDir(t), "poly.mjs")
  const l = await run([em("em++"), ...link, ...jobs.map((j) => j.obj), "-o", out])
  if (l.code !== 0) throw new Error("link failed:\n" + l.err)
  void ver
  return { rebuilt: todo.length, out }
}

if (import.meta.main) {
  const arg = process.argv.find((a) => ["linked", "runtime", "all"].includes(a)) ?? "all"
  for (const t of (arg === "all" ? ["linked", "runtime"] : [arg]) as Target[]) {
    const t0 = performance.now()
    const r = await buildWasm(t, process.argv.includes("--force"))
    console.log(`${t}: ${r.rebuilt} object(s) compiled, ${(performance.now() - t0).toFixed(0)} ms -> ${relative(process.cwd(), r.out)}`)
  }
}
