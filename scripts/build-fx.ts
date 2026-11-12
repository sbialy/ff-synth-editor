// Builds build/fx/fx_tool (arm64, -ffp-contract=off like the device's AUTO-F images): the native reference of the delay and reverb graph, test/fx.test.ts
// compares it with the same graph compiled to wasm. Incremental by mtime of the sources and every header under vendor/fx and host/fx.
// Usage: bun scripts/build-fx.ts [--force]
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fxDefs, fxFirmwareSources, fxIncludes } from "./fx-sources"

const root = join(import.meta.dir, "..")
const v = join(root, "vendor/poly")
export const fxToolPath = join(root, "build/fx/fx_tool")

const flags = [
  "-arch", "arm64", "-std=c++20", "-O2", "-ffp-contract=off", "-DTINY_OPTIONAL_x64", "-D_GLIBCXX_THROW_OR_ABORT(x)=__builtin_abort()",
  "-I", join(root, "host/compat-arm64"), "-I", join(root, "host/compat"), "-I", join(v, "synth/include"), "-I", join(v, "util/include"), "-I", join(v, "util/3rdparty"),
]

function newest(dir: string): number {
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    n = Math.max(n, e.isDirectory() ? newest(p) : statSync(p).mtimeMs)
  }
  return n
}

async function run(cmd: string[]): Promise<{ code: number; err: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const [err] = await Promise.all([new Response(p.stderr).text(), new Response(p.stdout).text()])
  return { code: await p.exited, err }
}

export async function buildFx(force = false): Promise<{ rebuilt: boolean; out: string }> {
  const sources = [...fxFirmwareSources, join(root, "host/fx.cpp"), join(root, "host/fx_tool.cpp")]
  const stamp = Math.max(newest(join(root, "vendor/fx")), newest(join(root, "host/fx")), ...["host/fx.cpp", "host/fx.h", "host/fx_tool.cpp"].map((f) => statSync(join(root, f)).mtimeMs))
  if (!force && existsSync(fxToolPath) && statSync(fxToolPath).mtimeMs > stamp) return { rebuilt: false, out: fxToolPath }
  const obj = join(root, "build/fx/obj")
  mkdirSync(obj, { recursive: true })
  const res = await Promise.all(sources.map(async (src) => {
    const o = join(obj, relative(root, src).replace(/[\/.]/g, "_") + ".o")
    // the firmware files get the device's defines, the glue and the tool the same plus the engine include set (they include the SDK header)
    return { src, o, r: await run(["clang++", ...flags, ...fxIncludes, ...fxDefs, "-c", src, "-o", o]) }
  }))
  const bad = res.filter((x) => x.r.code !== 0)
  if (bad.length) throw new Error("compile failed:\n" + bad.map((b) => `${b.src}\n${b.r.err}`).join("\n"))
  const l = await run(["clang++", "-arch", "arm64", ...res.map((x) => x.o), "-o", fxToolPath])
  if (l.code !== 0) throw new Error("link failed:\n" + l.err)
  return { rebuilt: true, out: fxToolPath }
}

if (import.meta.main) {
  const r = await buildFx(process.argv.includes("--force"))
  console.log(r.rebuilt ? `built ${relative(process.cwd(), r.out)}` : `${relative(process.cwd(), r.out)} is up to date`)
}
