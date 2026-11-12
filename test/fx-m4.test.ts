// The strongest check of the delay and reverb graph: the very same sources (host/fx.cpp and the firmware files of vendor/fx, with the firmware's real Cortex-M4 inline assembly)
// compiled for the device with the release compiler (arm-none-eabi 12.3, -ffp-contract=off, the AUTO-F flags) and run in the Unicorn Cortex-M4F emulator, against the arm64 native
// build (build/fx/fx_tool). The int16 bus must be identical for every scenario of test/fx-helpers.ts. This also proves the portable stand-ins of host/fx (the DSP instructions and
// Clip16) against the instructions themselves.
// Needs the 12.3 toolchain (TOOLCHAIN=.../arm-none-eabi-, never a 10.3 one) and a Python with unicorn (UNICORN_PYTHON, default /tmp/phzvenv/bin/python): skipped without them.
import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TOOLCHAIN, buildM4, haveToolchain, m4Elf } from "../scripts/build-fx-m4"
import { buildFx, fxToolPath } from "../scripts/build-fx"
import { DEF, RUNS, signal, type P, type Run } from "./fx-helpers"

const PY = process.env.UNICORN_PYTHON ?? "/tmp/phzvenv/bin/python"
const haveUnicorn = existsSync(PY) && Bun.spawnSync([PY, "-I", "-c", "import unicorn"]).exitCode === 0
const tmp = mkdtempSync(join(tmpdir(), "poly-editor-fxm4-"))
const KEYS = Object.keys(DEF) as (keyof P)[] // gCfg order of test/fx-m4/m4_main.cpp

function m4(run: Run, input: string): Int16Array {
  const cfg = { ...DEF, ...run.p }
  const out = join(tmp, `${run.name.replace(/\W+/g, "_")}.m4.s16`)
  const chg = (run.at ?? []).flatMap(([b, p]) => Object.entries(p).map(([k, v]) => `${b}:${KEYS.indexOf(k as keyof P)}:${v}`))
  const r = Bun.spawnSync([PY, "-I", join(import.meta.dir, "fx-m4/run.py"), m4Elf, TOOLCHAIN, input, out, String(run.blocks), ...KEYS.map((k) => String(cfg[k])), ...chg])
  expect(r.stderr.toString()).toBe("")
  return new Int16Array(readFileSync(out).buffer.slice(0))
}
function native(run: Run, input: string): Int16Array {
  const out = join(tmp, `${run.name.replace(/\W+/g, "_")}.nat.s16`)
  const stdin = (run.at ?? []).map(([b, p]) => `@${b} ${Object.entries(p).map(([k, v]) => `${k}=${v}`).join(" ")}`).join("\n") + "\n"
  const r = Bun.spawnSync([fxToolPath, input, out, ...Object.entries(run.p).map(([k, v]) => `${k}=${v}`)], { stdin: new TextEncoder().encode(stdin) })
  expect(r.exitCode).toBe(0)
  return new Int16Array(readFileSync(out).buffer.slice(0))
}
const diff = (a: Int16Array, b: Int16Array) => { let n = a.length === b.length ? 0 : Infinity, d = 0; for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) { n++; d = Math.max(d, Math.abs(a[i] - b[i])) } } return { n, d } }

describe.skipIf(!haveToolchain() || !haveUnicorn)("the delay and reverb graph: the Cortex-M4F build against arm64 native", () => {
  beforeAll(async () => {
    await buildM4()
    await buildFx()
  }, 600_000)

  for (const r of RUNS) {
    test(`${r.name}: the device build (Cortex-M4F, emulated) and the arm64 build give the same int16 bus, bit for bit`, () => {
      const input = join(tmp, `${r.name.replace(/\W+/g, "_")}.f32`)
      writeFileSync(input, signal(r.blocks, r.seed))
      const a = m4(r, input), b = native(r, input)
      let peak = 0
      for (const v of a) peak = Math.max(peak, Math.abs(v))
      expect(peak).toBeGreaterThan(500)
      const d = diff(a, b)
      console.log(`${r.name}: ${a.length / 256} blocks, peak ${peak}, differing samples ${d.n}, max diff ${d.d} LSB`)
      expect(d.n).toBe(0)
    }, 300_000)
  }

  test("the expf the arm64 and wasm builds call (a copy of newlib's) equals newlib's expf in the Cortex-M4F build for every limiter coefficient argument and a grid down to -51", () => {
    const out = join(tmp, "expf.m4.f32"), nat = join(tmp, "expf.nat.f32")
    const r = Bun.spawnSync([PY, "-I", join(import.meta.dir, "fx-m4/run.py"), m4Elf, TOOLCHAIN, "expf", out])
    expect(r.stderr.toString()).toBe("")
    expect(Bun.spawnSync([fxToolPath, "--expf", nat]).exitCode).toBe(0)
    const a = new Uint32Array(readFileSync(out).buffer.slice(0)), b = new Uint32Array(readFileSync(nat).buffer.slice(0))
    expect(a.length).toBe(5097)
    expect(b.length).toBe(5097)
    let n = 0
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++
    expect(n).toBe(0)
    // the libms of the host and of emscripten are not newlib's: the check is not vacuous (the default attack 100 is argument 99)
    expect(a[99]).toBe(0x3f7fdf50)
  }, 120_000)

  test("negative control: a different send gives a different bus, so the comparison can fail", () => {
    const r: Run = { name: "control", p: { delaySend: 70 }, blocks: 300 }
    const input = join(tmp, "control.f32")
    writeFileSync(input, signal(r.blocks))
    expect(diff(m4(r, input), native({ ...r, p: { delaySend: 71 } }, input)).n).toBeGreaterThan(1000)
  }, 120_000)
})
