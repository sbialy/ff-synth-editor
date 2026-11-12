// Builds build/poly_host (x86_64, runs under Rosetta on Apple silicon) from host/ and vendor/poly with clang++.
// The native host has no PHZ and no PLK: their source is private (vendor/FIRMWARE.json "private") and is not needed to build the editor. The server
// (server/host.ts) answers for those two from the wasm host with their runtime modules loaded (scripts/build-wasm.ts target "runtime", scripts/modules.ts).
// POLY_FPCONTRACT=fast|off builds an arm64 A/B variant instead, into build/fpc-<mode>/ (see `math` below). Unset, nothing changes.
// Incremental: an object file is rebuilt only when it is older than any source or header it was built from.
// Usage: bun scripts/build.ts [--force]
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs"
import { join, relative } from "node:path"
import { firmware, firmwareFile } from "../server/firmware"

export const root = join(import.meta.dir, "..")
const v = join(root, "vendor/poly")

/**
 * The floating point contraction under test. POLY_FPCONTRACT=fast|off builds the engines as arm64 with -ffp-contract=<mode> into its own
 * directory (build/fpc-fast, build/fpc-off), so two servers can run side by side with different libraries. Unset: the x86_64 host with the
 * compiler default and no FMA at all, exactly as before.
 *  - fast = GCC's default AUTO: multiply-adds are fused across statements (clang's default "on" only fuses inside one expression)
 *  - off  = AUTO-F: no fused multiply-add anywhere (the device is built with -ffp-contract=off)
 * arm64 is used because x86_64 has no FMA without -mfma and this Mac's Rosetta cannot always run fresh x86_64 binaries. It is an
 * approximation of the Cortex-M4 VFMA, not the device.
 */
export type FpContract = "fast" | "off"
export function fpContractOf(v: string | undefined): FpContract | undefined {
  if (v === undefined || v === "") return undefined
  if (v === "fast" || v === "off") return v
  throw new Error(`POLY_FPCONTRACT must be fast or off, got '${v}'`)
}
export const fpContract = fpContractOf(process.env.POLY_FPCONTRACT)
const arch = fpContract ? "arm64" : "x86_64"
export const math = {
  fpContract,
  arch,
  /** What the page badge shows. */
  label: fpContract === "fast" ? "fp-contract fast (AUTO)" : fpContract === "off" ? "fp-contract off (AUTO-F)" : "fp-contract default",
}
const buildDir = fpContract ? join(root, "build", `fpc-${fpContract}`) : join(root, "build")
export const hostBinary = join(buildDir, "poly_host")

// Which sources are compiled is the firmware's own list: scripts/vendor.sh computes it from synth-open/engines.mk at the pinned tag
// and writes it to vendor/FIRMWARE.json (paths relative to vendor/poly). The host and the fmt library are the editor's.
export { firmware }
/** The engines whose code is private and arrives as a runtime module (never compiled into the native host), and the source files they would add. */
export const privateEngines: readonly string[] = firmware.private.engines
const privateFiles = new Set(firmware.private.files)
const sources = [
  join(root, "host/poly_host.cpp"),
  join(v, "util/3rdparty/fmt/format.cc"),
  ...firmware.sources.filter((f) => !privateFiles.has(f)).map((f) => join(v, f)),
]

const flags = [
  "-arch", arch, "-std=c++20", "-O2",
  // arm64 A/B build: the contraction under test, tiny::optional's x64 sentinel (64 bit pointers) and float short params (host/compat-arm64/boost)
  ...(fpContract ? [`-ffp-contract=${fpContract}`, "-DTINY_OPTIONAL_x64", "-I", join(root, "host/compat-arm64")] : []),
  "-I", join(root, "host/compat"), "-I", join(v, "synth/include"), "-I", join(v, "util/include"), "-I", join(v, "util/3rdparty"),
  "-I", join(v, "synth-open"), "-I", join(v, "synth-open/ot"), "-I", join(root, "host"), "-I", join(v, "core/synth"), "-I", join(v, "core/synth/engines"),
  "-D_GLIBCXX_THROW_OR_ABORT(x)=__builtin_abort()", "-DFEATURE_SYNTH_OPEN", "-DOPEN_HOST_TEST",
  // the engine picker of the shim (vendor/poly/synth-open/engine_list.h): every engine of the firmware's release set (the six built in and the OpenTracker module engines of tracker-engines-os)
  // (not the private ones, PHZ and PLK: their entries of engine_list.h stay out of this build)
  ...firmware.engines.filter((n) => !privateEngines.includes(n)).map((n) => `-DSYNTH_ENGINE_${n}`),
]

function newestHeader(dir: string): number {
  let newest = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) newest = Math.max(newest, newestHeader(p))
    else if (/\.(h|hpp)$/.test(e.name)) newest = Math.max(newest, statSync(p).mtimeMs)
  }
  return newest
}

async function run(cmd: string[]): Promise<{ code: number; err: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const [err] = await Promise.all([new Response(p.stderr).text(), new Response(p.stdout).text()])
  return { code: await p.exited, err }
}

export async function build(force = false): Promise<{ rebuilt: number }> {
  mkdirSync(join(buildDir, "obj"), { recursive: true })
  const headers = Math.max(newestHeader(v), newestHeader(join(root, "host")), statSync(firmwareFile).mtimeMs)
  const jobs = sources.map((src) => {
    const obj = join(buildDir, "obj", relative(root, src).replace(/[\/.]/g, "_") + ".o")
    const stale = force || !existsSync(obj) || statSync(obj).mtimeMs < Math.max(statSync(src).mtimeMs, headers)
    return { src, obj, stale }
  })
  const todo = jobs.filter((j) => j.stale)
  const results = await Promise.all(
    todo.map(async (j) => ({ j, r: await run(["clang++", ...flags, "-c", j.src, "-o", j.obj]) })),
  )
  const bad = results.filter((x) => x.r.code !== 0)
  if (bad.length) {
    for (const b of bad) rmSync(b.j.obj, { force: true })
    throw new Error("compile failed:\n" + bad.map((b) => `${b.j.src}\n${b.r.err}`).join("\n"))
  }
  const objs = jobs.map((j) => j.obj)
  const linkStale = todo.length > 0 || !existsSync(hostBinary) || statSync(hostBinary).mtimeMs < Math.max(...objs.map((o) => statSync(o).mtimeMs))
  if (linkStale) {
    const l = await run(["clang++", "-arch", arch, ...objs, "-o", hostBinary])
    if (l.code !== 0) throw new Error("link failed:\n" + l.err)
  }
  return { rebuilt: todo.length }
}

if (import.meta.main) {
  const t = performance.now()
  const { rebuilt } = await build(process.argv.includes("--force"))
  console.log(`poly_host: ${rebuilt} object(s) compiled, ${(performance.now() - t).toFixed(0)} ms -> ${relative(process.cwd(), hostBinary)}`)
}
