// PHZ, the firmware's clean-room phase distortion engine (synth-open/phz): metadata from the firmware tables, audio through the
// stream path, patch codec round trip, ids that do not clash with D-Type.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { havePrivate, newHost, stream, pull, rmsMany, testPrivate } from "./helpers"
// PHZ is private: its runtime module is needed (skipped in a build without it)
const priv = testPrivate("PHZ")
import { FIRMWARE_ENGINES } from "../server/engines"
import type { HostClient } from "../server/host"

let host: HostClient
let tmp: string
let m: any
beforeAll(async () => {
  if (!havePrivate("PHZ")) return
  host = await newHost()
  tmp = mkdtempSync(join(tmpdir(), "poly-editor-phz-"))
  m = await host.request({ cmd: "meta", engine: "PHZ" })
}, 300_000)
afterAll(() => {
  host?.close()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

const held = (patch: unknown, extra: object[] = [], voices = 2) =>
  stream([{ cmd: "live.open", engine: "PHZ", patch, voices }, ...extra, { cmd: "live.note", on: true, note: 57, velocity: 100 }, pull(120)])
const allPcm = (fs: { pcm: Float32Array }[]) => fs.flatMap((f) => Array.from(f.pcm))
const maxDiff = (a: number[], b: number[]) => a.reduce((x, v, i) => Math.max(x, Math.abs(v - b[i])), 0)

priv("PHZ comes after PERC and CHIP in the firmware's list, has its own group (phase distortion) and the firmware's own tables", async () => {
  const e = await host.request({ cmd: "engines" })
  const names = e.engines.map((x: any) => x.name)
  expect(names.slice(0, 7)).toEqual(["ACD", "FAT", "VAP", "WTFM", "PERC", "CHIP", "PHZ"])
  expect(e.engines.filter((x: any) => x.group === "phz").map((x: any) => x.name)).toEqual(["PHZ"])
  expect(e.engines.filter((x: any) => x.group === "polyend").map((x: any) => x.name)).toEqual(["ACD", "FAT", "VAP", "WTFM", "PERC"])
  expect(e.engines.filter((x: any) => x.group === "polyend-oss").map((x: any) => x.name)).toEqual(["CHIP"])
  const x = e.engines.find((y: any) => y.name === "PHZ")
  expect(x).toMatchObject({ display: "PHZ", group: "phz", params: 62, sections: 10 })
  expect(x.moduleId).toBeUndefined() // not an OpenTracker 3.x module
  expect(m.params.length).toBe(62)
  expect(m.params.slice(0, 3).map((p: any) => p.name)).toEqual(["Shape 1", "Shape 2", "Mix"])
  expect(m.sections.map((s: any) => s.name)).toEqual(["Oscillator 1", "Oscillator 2", "Voice", "Filter", "Amp Envelope", "Filter Envelope", "Aux Envelope", "LFO 1", "LFO 2", "Modulation"])
  expect(m.params[7].names).toEqual(["OG Saw", "OG Square", "Hermite Smooth", "Squared", "Linear", "Hermite FM"])
  expect(m.params[21].names.length).toBe(15) // filter types
  expect(m.volumeParam).toBe(18)
  expect(m.params[18].name).toBe("Volume")
  expect(m.macros.length).toBeGreaterThanOrEqual(6)
  const d = await host.request({ cmd: "describe", engine: "PHZ", patch: m.init })
  expect(d.texts.length).toBe(62)
  expect(d.texts.every((t: string) => typeof t === "string" && t.length > 0)).toBe(true)
  expect(d.texts[3]).toBe("0.60") // Osc1 XMod uses PHZ's own X / Y format
})

priv("a held note gives finite, non-silent, bounded output", async () => {
  const { frames, err } = await held(m.init)
  const pcm = allPcm(frames)
  expect(pcm.length).toBe(120 * 128)
  expect(pcm.every(Number.isFinite)).toBe(true)
  expect(rmsMany(frames)).toBeGreaterThan(0.01)
  const peak = Math.max(...pcm.map(Math.abs))
  expect(peak).toBeGreaterThan(0.05)
  expect(peak).toBeLessThanOrEqual(1.0001)
  expect(err).not.toMatch(/error|abort/i)
  // a render of the whole note agrees
  const out = join(tmp, "r.wav")
  const r = await host.request({ cmd: "render", engine: "PHZ", patch: m.init, note: 60, velocity: 100, seconds: 1, hold: 0.6, out })
  expect(r.finite).toBe(true)
  expect(r.nonSilent).toBe(true)
})

priv("a parameter change alters the output, the same patch twice does not", async () => {
  const base = await held(m.init)
  for (const [name, value] of [["Cutoff", 600], ["Shape 1", 0.9], ["Model", 3], ["Tune 1", 7]] as const) {
    const id = m.params.findIndex((p: any) => p.name === name)
    const patch = structuredClone(m.init)
    patch.values[id] = value
    const other = await held(patch)
    expect(maxDiff(allPcm(base.frames), allPcm(other.frames))).toBeGreaterThan(0.01)
  }
  const again = await held(m.init)
  expect(maxDiff(allPcm(base.frames), allPcm(again.frames))).toBe(0)
}, 60_000)

priv("a knob moved while the note holds is heard, polyphony 1 to 8 holds the voices", async () => {
  const { frames } = await stream([
    { cmd: "live.open", engine: "PHZ", patch: m.init, voices: 2 },
    { cmd: "live.note", on: true, note: 57, velocity: 100 },
    pull(60),
    { cmd: "live.param", param: 18, value: 0 },
    pull(200),
  ])
  expect(rmsMany(frames.slice(0, 60))).toBeGreaterThan(0.01)
  expect(rmsMany(frames.slice(-40))).toBeLessThan(rmsMany(frames.slice(0, 60)) * 0.1)
  for (const voices of [1, 4, 8]) {
    const notes = [48, 52, 55, 59, 62, 65, 69, 72, 76, 79].map((note) => ({ cmd: "live.note", on: true, note, velocity: 90 }))
    const r = await stream([{ cmd: "live.open", engine: "PHZ", patch: m.init, voices }, ...notes, pull(40)])
    expect(r.frames.at(-1)!.held).toBe(voices)
    expect(allPcm(r.frames).every(Number.isFinite)).toBe(true)
  }
}, 60_000)

priv("MIDI-style control reaches PHZ: pitch bend and sustain", async () => {
  const plain = await held(m.init)
  const bent = await held(m.init, [{ cmd: "live.bend", value: 8000 }])
  expect(maxDiff(allPcm(plain.frames), allPcm(bent.frames))).toBeGreaterThan(0.05)
  const { frames } = await stream([
    { cmd: "live.open", engine: "PHZ", patch: m.init, voices: 4 },
    { cmd: "live.cc", cc: 64, value: 127 },
    { cmd: "live.note", on: true, note: 57, velocity: 100 },
    pull(20),
    { cmd: "live.note", on: false, note: 57 },
    pull(40),
  ])
  expect(frames.at(-1)!.held).toBe(1)
  expect(rmsMany(frames.slice(-10))).toBeGreaterThan(0.005)
})

priv("Init patch and an edited patch: encode, save, load and re-save byte for byte", async () => {
  const patch = structuredClone(m.init)
  for (const id of [0, 2, 7, 11, 19, 21]) {
    const p = m.params[id]
    patch.values[id] = p.stepped ? Math.round(p.min + (p.max - p.min) * 0.4) : p.min + (p.max - p.min) * 0.37
  }
  const path = join(tmp, "PHZ", "Test.patch")
  const saved = await host.request({ cmd: "save", path, patch })
  expect(saved.size).toBeGreaterThan(30)
  const back = await host.request({ cmd: "load", path, engine: "PHZ" })
  expect(back.warnings).toEqual([])
  expect(back.patch.engine).toBe("PHZ")
  expect(back.patch.values.length).toBe(62)
  for (const id of [0, 2, 7, 11, 19, 21]) expect(Math.abs(back.patch.values[id] - patch.values[id])).toBeLessThan(1e-6 * Math.max(1, Math.abs(patch.values[id])))
  const rt = await host.request({ cmd: "roundtrip", path })
  expect(rt).toMatchObject({ loaded: true, identical: true, codecIdentical: true, engine: "PHZ" })
  const enc = await host.request({ cmd: "encode", patch: back.patch })
  expect(enc.hex).toBe(readFileSync(path).toString("hex"))
  const initPath = join(tmp, "PHZ", "Init.patch")
  await host.request({ cmd: "save", path: initPath, patch: m.init })
  expect((await host.request({ cmd: "load", path: initPath, engine: "PHZ" })).patch.values).toEqual(m.init.values)
  expect((await host.tryRequest({ cmd: "load", path, engine: "JU6" })).ok).toBe(false)
  // a saved patch sounds like the one in memory
  const a = await held(patch), b = await held(back.patch)
  expect(maxDiff(allPcm(a.frames), allPcm(b.frames))).toBe(0)
}, 60_000)

priv("PHZ and D-Type no longer share an id: D-Type is stored under 0xA2 in the editor, PHZ keeps the firmware's 0x82", async () => {
  const e = await host.request({ cmd: "engines" })
  expect(e.engines.find((x: any) => x.name === "PHZ").engineId).toBe(0x82)
  expect(e.engines.find((x: any) => x.name === "DTYPE").engineId).toBe(0xa2)
  const dm = await host.request({ cmd: "meta", engine: "DTYPE" })
  const path = join(tmp, "DTYPE", "D.patch")
  await host.request({ cmd: "save", path, patch: dm.init })
  expect((await host.request({ cmd: "load", path, engine: "DTYPE" })).patch.engine).toBe("DTYPE")
  expect((await host.tryRequest({ cmd: "load", path, engine: "PHZ" })).ok).toBe(false)
})

priv("the release image engines of the pinned firmware (tracker-ff 1.2.0: all 18, Hand-Type and Pluck included)", () => {
  expect([...FIRMWARE_ENGINES]).toEqual(["ACD", "FAT", "VAP", "WTFM", "PERC", "CHIP", "JU6", "PHZ", "FM4", "DTYPE", "CSTYPE", "ATYPE", "TTYPE", "8TYPE", "HANDTYPE", "BTYPE", "ARCTYPE", "PLK"])
})
