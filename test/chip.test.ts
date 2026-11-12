// CHIP: tracker-ce's open Chiptune engine through the synth-open shim.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newHost, parseWav } from "./helpers"
import type { HostClient } from "../server/host"

let host: HostClient
let tmp: string
beforeAll(async () => {
  host = await newHost()
  tmp = mkdtempSync(join(tmpdir(), "poly-editor-chip-"))
}, 300_000)
afterAll(() => {
  host.close()
  rmSync(tmp, { recursive: true, force: true })
})

async function render(patch: unknown, name: string, extra: Record<string, unknown> = {}) {
  const out = join(tmp, name + ".wav")
  const r = await host.request({ cmd: "render", engine: "CHIP", patch, note: 60, velocity: 100, seconds: 1, hold: 0.6, out, ...extra })
  return { r, samples: parseWav(readFileSync(out)).samples }
}

test("CHIP is listed with Chiptune's own metadata", async () => {
  const e = await host.request({ cmd: "engines" })
  expect(e.engines.map((x: any) => x.name)).toContain("CHIP")
  const m = await host.request({ cmd: "meta", engine: "CHIP" })
  expect(m.params.map((p: any) => p.name).slice(0, 4)).toEqual(["Model", "Tune", "Fine", "Duty / Shape"])
  expect(m.params[0].names).toEqual(["2A03 Pulse", "SID Saw/Tri", "Noise / LFSR", "FM Bell", "Super Square", "Zap / Laser", "Arp Chord", "Chip Drum"])
  expect(m.sections.map((s: any) => s.name)).toEqual(["Oscillator", "Modulation", "Amplifier", "Filter", "Voice"])
  expect(m.macros[0].name).toBe("Timbre / PWM")
  const d = await host.request({ cmd: "describe", engine: "CHIP", patch: m.init })
  expect(d.texts[0]).toBe("2A03 Pulse")
  expect(d.texts[4]).toBe("2.50 Hz") // PWM Rate default, Chiptune's own formatter
})

test("renders a note with finite, non-silent output", async () => {
  const { r, samples } = await render(undefined, "init")
  expect(r.finite).toBe(true)
  expect(r.nonSilent).toBe(true)
  expect(r.peak).toBeGreaterThan(0.05)
  expect(r.peak).toBeLessThanOrEqual(1)
  expect(samples.every(Number.isFinite)).toBe(true)
  // the note rings and then releases: the tail is quieter than the start
  const rms = (a: number, b: number) => Math.sqrt(samples.slice(a, b).reduce((s, x) => s + x * x, 0) / (b - a))
  expect(rms(0, 4000)).toBeGreaterThan(0.05)
  expect(rms(40000, 44000)).toBeLessThan(rms(0, 4000) * 0.2)
})

test("every model sounds", async () => {
  const m = await host.request({ cmd: "meta", engine: "CHIP" })
  for (let model = 0; model < 8; model++) {
    const patch = structuredClone(m.init)
    patch.values[0] = model
    const { r } = await render(patch, "model" + model)
    expect(r.finite).toBe(true)
    expect(r.nonSilent).toBe(true)
  }
})

test("a parameter change alters the output", async () => {
  const m = await host.request({ cmd: "meta", engine: "CHIP" })
  const a = await render(m.init, "a")
  const fm = structuredClone(m.init)
  fm.values[0] = 3 // Model: FM Bell
  const b = await render(fm, "b")
  const dull = structuredClone(m.init)
  dull.values[m.params.findIndex((p: any) => p.name === "Cutoff")] = 300
  const c = await render(dull, "c")
  const diff = (x: Float32Array, y: Float32Array) => x.reduce((acc, v, i) => Math.max(acc, Math.abs(v - y[i])), 0)
  expect(diff(a.samples, b.samples)).toBeGreaterThan(0.1)
  expect(diff(a.samples, c.samples)).toBeGreaterThan(0.1)
  // the same patch twice is the same sound (no state leaks between renders)
  const a2 = await render(m.init, "a2")
  expect(diff(a.samples, a2.samples)).toBe(0)
})

test("Init patch: encode, save, load and re-save through the codec", async () => {
  const m = await host.request({ cmd: "meta", engine: "CHIP" })
  const patch = structuredClone(m.init)
  patch.values[3] = 0.6 // Duty
  patch.values[17] = 2500 // Cutoff
  const path = join(tmp, "CHIP", "Test.patch")
  const saved = await host.request({ cmd: "save", path, patch })
  expect(saved.size).toBeGreaterThan(50)
  const back = await host.request({ cmd: "load", path, engine: "CHIP" })
  expect(back.warnings).toEqual([])
  expect(back.patch.engine).toBe("CHIP")
  expect(back.patch.values.length).toBe(25)
  expect(back.patch.values[3]).toBeCloseTo(0.6, 5)
  expect(back.patch.values[17]).toBeCloseTo(2500, 2)
  expect(back.patch.macros.map((x: any) => x.name).slice(0, 2)).toEqual(["Timbre / PWM", "Arp / Chord"])
  const rt = await host.request({ cmd: "roundtrip", path })
  expect(rt).toMatchObject({ loaded: true, identical: true, codecIdentical: true, engine: "CHIP" })
  const enc = await host.request({ cmd: "encode", patch: back.patch })
  expect(enc.hex).toBe(readFileSync(path).toString("hex"))
  // a CHIP file is refused where another engine is asked for
  const wrong = await host.tryRequest({ cmd: "load", path, engine: "ACD" })
  expect(wrong.ok).toBe(false)
})

test("CHIP files saved by the editor before the engine id became Polyend's 8 (field 1 = 0x10) still load", async () => {
  const m = await host.request({ cmd: "meta", engine: "CHIP" })
  const enc = await host.request({ cmd: "encode", patch: m.init })
  expect(enc.hex.startsWith("0808")).toBe(true) // the id the shim writes now
  const legacy = Buffer.from("0810" + enc.hex.slice(4), "hex")
  mkdirSync(join(tmp, "CHIP"), { recursive: true })
  const path = join(tmp, "CHIP", "Legacy.patch")
  writeFileSync(path, legacy)
  const back = await host.request({ cmd: "load", path, engine: "CHIP" })
  expect(back.patch.engine).toBe("CHIP")
  expect(back.patch.values).toEqual(m.init.values)
  expect((await host.request({ cmd: "encode", patch: back.patch })).hex).toBe(enc.hex) // saved again with id 8
})
