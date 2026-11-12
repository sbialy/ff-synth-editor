// Builds build/fx-m4/fx_m4.elf: the delay and reverb graph (host/fx.cpp) with the firmware files of vendor/fx for the Cortex-M4F of the device, compiled with the release compiler
// (arm-none-eabi 12.3, the flags of the 1.2.0 images, -ffp-contract=off as AUTO-F) and the firmware's real inline assembly (vendor/fx/arm: dspinst.h, Polyverb/util.h, KINETISK).
// test/fx-m4/run.py runs it in the Unicorn Cortex-M4F emulator, test/fx-m4.test.ts compares it with the arm64 and wasm builds. Never the 10.3 compiler (x86_64, Rosetta).
// TOOLCHAIN=/path/arm-none-eabi- (the GNU Arm Embedded 12.3 toolchain prefix, no default: without it the build and its test are skipped)
import { existsSync, mkdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fxDefs, fxFirmwareSources } from "./fx-sources"

const root = join(import.meta.dir, "..")
const v = join(root, "vendor/poly")
const F = join(root, "vendor/fx")
export const TOOLCHAIN = process.env.TOOLCHAIN ?? "/nonexistent/arm-none-eabi-"
export const m4Elf = join(root, "build/fx-m4/fx_m4.elf")
export const haveToolchain = () => existsSync(TOOLCHAIN + "g++") && !TOOLCHAIN.includes("10.3")

// The SDK header that host/fx.cpp includes (the soft clip) pulls Boost's config, and the vendored copy holds the files clang needs (vendor.sh computes the closure with clang), not the
// ones for gcc: the firmware checkout (POLY_REPO) is on the path behind it, for those headers only.
const polyRepo = process.env.POLY_REPO ?? ""
const inc = [
  // the originals with the assembly first: they win over the portable stand-ins of host/fx
  "-I", join(F, "arm"), "-I", join(F, "arm/utility"),
  "-I", join(root, "host/fx"), "-I", join(F, "core/libs/Audio"), "-I", join(F, "core/libs/Audio/Polyverb"), "-I", join(F, "core/source"),
  "-I", join(F, "core/AudioEngine"), "-I", join(F, "core/AudioEngine/ConstantValues"), "-I", join(F, "synth-open"),
  "-I", join(root, "host"), "-I", join(root, "host/compat"), "-I", join(v, "synth/include"), "-I", join(v, "util/include"), "-I", join(v, "util/3rdparty"),
  ...(polyRepo ? ["-I", join(polyRepo, "util/3rdparty")] : []),
]
const flags = [
  "-std=gnu++20", "-O2", "-mcpu=cortex-m4", "-mfpu=fpv4-sp-d16", "-mfloat-abi=hard", "-mthumb", "-ffunction-sections", "-fdata-sections", "-ffreestanding", "-fno-builtin",
  "-fno-rtti", "-fno-exceptions", "-fno-threadsafe-statics", "-DNDEBUG", "-ffp-contract=off", "-D__MK66FX1M0__", "-DKINETISK", "-DFX_REAL_LIBM", "-mfp16-format=ieee", 
  ...fxDefs.filter((d) => d !== "-Wno-unused-value"),
]

async function run(cmd: string[]): Promise<{ code: number; err: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const [err] = await Promise.all([new Response(p.stderr).text(), new Response(p.stdout).text()])
  return { code: await p.exited, err }
}

export async function buildM4(force = false): Promise<{ rebuilt: boolean; out: string }> {
  if (!haveToolchain()) throw new Error(`no arm-none-eabi toolchain at ${TOOLCHAIN} (set TOOLCHAIN, never a 10.3 one)`)
  const sources = [...fxFirmwareSources, join(root, "host/fx.cpp"), join(root, "test/fx-m4/m4_main.cpp")]
  const stamp = Math.max(...sources.map((s) => statSync(s).mtimeMs), statSync(join(root, "host/fx.h")).mtimeMs, statSync(join(root, "test/fx-m4/link.ld")).mtimeMs)
  if (!force && existsSync(m4Elf) && statSync(m4Elf).mtimeMs > stamp) return { rebuilt: false, out: m4Elf }
  const obj = join(root, "build/fx-m4/obj")
  mkdirSync(obj, { recursive: true })
  const res = await Promise.all(sources.map(async (src) => {
    const o = join(obj, relative(root, src).replace(/[\/.]/g, "_") + ".o")
    return { src, o, r: await run([TOOLCHAIN + "g++", ...flags, ...inc, "-c", src, "-o", o]) }
  }))
  const bad = res.filter((x) => x.r.code !== 0)
  if (bad.length) throw new Error("compile failed:\n" + bad.map((b) => `${b.src}\n${b.r.err}`).join("\n"))
  const l = await run([TOOLCHAIN + "g++", "-mcpu=cortex-m4", "-mfpu=fpv4-sp-d16", "-mfloat-abi=hard", "-mthumb", "-specs=nano.specs", "-nostartfiles", "-Wl,--gc-sections",
    "-Wl,-u,m4_run", "-Wl,-u,m4_setup", "-Wl,-u,m4_expf", "-Wl,-T," + join(root, "test/fx-m4/link.ld"), ...res.map((x) => x.o), "-Wl,--start-group", "-lm", "-lc", "-lgcc", "-lstdc++", "-Wl,--end-group", "-o", m4Elf])
  if (l.code !== 0) throw new Error("link failed:\n" + l.err)
  return { rebuilt: true, out: m4Elf }
}

if (import.meta.main) {
  const r = await buildM4(process.argv.includes("--force"))
  console.log(r.rebuilt ? `built ${relative(process.cwd(), r.out)}` : `${relative(process.cwd(), r.out)} is up to date`)
}
