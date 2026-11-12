// Pluck (PLK), the Karplus-Strong plucked string engine, a release engine of tracker-ff since 1.2.0 (stored 18, id 0x8A, a card plugin built from
// its own repository, a runtime module here). The metadata is checked against the tag and that repository in test/sync.test.ts. This file is what the
// other engines have in test/phz.test.ts: audio through the stream path, a parameter change, polyphony and MIDI, the randomizer, recipes and the
// byte for byte .patch round trip. The golden vectors (test/fixtures/golden-algo2.json) cover the engines that existed when they were frozen and
// do not list Pluck, test/randomize-stability.test.ts and test/randomize-coverage.test.ts do.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { havePrivate, newHost, stream, pull, rmsMany, testPrivate } from "./helpers"
// PLK is private: its runtime module is needed (skipped in a build without it)
const priv = testPrivate("PLK")
import { randomize, applyPlan } from "../public/randomize.js"
import { rollSettings, buildRecipe, encodeRecipe, decodeCode, replaySteps } from "../public/recipe.js"
import type { HostClient } from "../server/host"

let host: HostClient
let tmp: string
let m: any
beforeAll(async () => {
  if (!havePrivate("PLK")) return
  host = await newHost()
  tmp = mkdtempSync(join(tmpdir(), "poly-editor-pluck-"))
  m = await host.request({ cmd: "meta", engine: "PLK" })
}, 300_000)
afterAll(() => {
  host?.close()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

const on = (note: number, velocity = 100) => ({ cmd: "live.note", on: true, note, velocity })
const off = (note: number) => ({ cmd: "live.note", on: false, note })
const held = (patch: unknown, extra: object[] = [], voices = 2) =>
  stream([{ cmd: "live.open", engine: "PLK", patch, voices }, ...extra, on(57), pull(120)])
const allPcm = (fs: { pcm: Float32Array }[]) => fs.flatMap((f) => Array.from(f.pcm))
const maxDiff = (a: number[], b: number[]) => a.reduce((x, v, i) => Math.max(x, Math.abs(v - b[i])), 0)
const id = (name: string) => m.params.findIndex((p: any) => p.name === name)

priv("Pluck is in the host's list in its own group, stored 18, id 0x8A, 11 parameters in 3 sections, no clash", async () => {
  const e = await host.request({ cmd: "engines" })
  const x = e.engines.find((y: any) => y.name === "PLK")
  expect(x).toMatchObject({ display: "Pluck", group: "plk", typeId: 0x8a, engineId: 0x8a, stored: 18, params: 11, sections: 3, maxVoices: 4, editorMaxVoices: 8, volumeParam: 8 })
  expect(e.engines.at(-1).name).not.toBe("PLK") // listed before the OpenTracker group, the page groups it itself
  for (const k of ["typeId", "engineId", "stored"]) expect(new Set(e.engines.map((y: any) => y[k])).size).toBe(e.engines.length)
  expect(m.params.map((p: any) => p.name)).toEqual(["Exciter", "Brightness", "Damping", "Pick Pos", "Stretch", "Release", "Tune", "Fine", "Volume", "Vel Bright", "Body"])
  expect(m.params[0].names).toEqual(["Noise", "Click", "Saw", "Mallet"])
  expect(m.sections.map((s: any) => s.name)).toEqual(["Oscillator", "Filter", "Voice"])
  expect(m.macros.slice(0, 6).map((x: any) => x.name)).toEqual(["Brightness", "Damping", "Stretch", "Pick Pos", "Release", "Fine"])
  const d = await host.request({ cmd: "describe", engine: "PLK", patch: m.init })
  expect(d.texts.length).toBe(11)
  expect(d.texts.every((t: string) => typeof t === "string" && t.length > 0)).toBe(true)
})

priv("a held note gives finite, non-silent, bounded output, and a render of the whole note agrees", async () => {
  const { frames, err } = await held(m.init)
  const pcm = allPcm(frames)
  expect(pcm.length).toBe(120 * 128)
  expect(pcm.every(Number.isFinite)).toBe(true)
  expect(rmsMany(frames)).toBeGreaterThan(0.005)
  const peak = Math.max(...pcm.map(Math.abs))
  expect(peak).toBeGreaterThan(0.03)
  expect(peak).toBeLessThanOrEqual(1.0001)
  expect(err).not.toMatch(/error|abort/i)
  const out = join(tmp, "r.wav")
  const r = await host.request({ cmd: "render", engine: "PLK", patch: m.init, note: 60, velocity: 100, seconds: 1, hold: 0.6, out })
  expect(r.finite).toBe(true)
  expect(r.nonSilent).toBe(true)
})

priv("a parameter change alters the output, the same patch twice does not", async () => {
  const base = await held(m.init)
  for (const [name, value] of [["Exciter", 2], ["Brightness", 0.1], ["Damping", 0.9], ["Pick Pos", 0.9], ["Stretch", 0.8], ["Tune", 7], ["Fine", 60]] as const) {
    const patch = structuredClone(m.init)
    patch.values[id(name)] = value
    const other = await held(patch)
    expect(maxDiff(allPcm(base.frames), allPcm(other.frames))).toBeGreaterThan(0.005)
    expect(allPcm(other.frames).every(Number.isFinite)).toBe(true)
  }
  const again = await held(m.init)
  expect(maxDiff(allPcm(base.frames), allPcm(again.frames))).toBe(0)
}, 60_000)

priv("the string rings, a note off damps it, and Damping shortens the ring", async () => {
  const ring = async (patch: any, release: boolean) => (await stream([{ cmd: "live.open", engine: "PLK", patch, voices: 2 }, on(57), pull(20), ...(release ? [off(57)] : []), pull(150)])).frames
  const a = await ring(m.init, false)
  expect(rmsMany(a.slice(-40))).toBeGreaterThan(0.001) // still ringing 0.5 s later at the default Damping
  const rel = await ring(m.init, true)
  expect(rmsMany(rel.slice(-40))).toBeLessThan(rmsMany(a.slice(-40)))
  const dry = structuredClone(m.init); dry.values[id("Damping")] = 1
  expect(rmsMany((await ring(dry, false)).slice(-40))).toBeLessThan(rmsMany(a.slice(-40)) * 0.5)
}, 60_000)

priv("a knob moved while the note holds is heard, polyphony 1 to 8 holds the voices, a ninth key steals the oldest", async () => {
  const { frames } = await stream([
    { cmd: "live.open", engine: "PLK", patch: m.init, voices: 2 },
    on(57), pull(20),
    { cmd: "live.param", param: 8, value: 0 }, // Volume
    pull(100),
  ])
  expect(rmsMany(frames.slice(0, 20))).toBeGreaterThan(0.003)
  expect(rmsMany(frames.slice(-40))).toBeLessThan(rmsMany(frames.slice(0, 20)) * 0.1)
  for (const voices of [1, 4, 8]) {
    const notes = [48, 52, 55, 59, 62, 65, 69, 72, 76, 79].map((n) => on(n, 90))
    const r = await stream([{ cmd: "live.open", engine: "PLK", patch: m.init, voices }, ...notes, pull(40)])
    expect(r.err).toBe("")
    expect(r.frames.at(-1)!.held).toBe(voices)
    expect(allPcm(r.frames).every(Number.isFinite)).toBe(true)
  }
  const notes = [48, 50, 52, 53, 55, 57, 59, 60]
  const r = await stream([{ cmd: "live.open", engine: "PLK", voices: 8 }, ...notes.flatMap((n) => [on(n), pull(4)]), pull(4), on(62), pull(8), off(62), pull(4)])
  expect(r.err).toBe("")
  expect(r.frames[4 * 8 + 3]).toMatchObject({ voices: 8, held: 8 })
  expect(r.frames.at(-1)!.held).toBe(7)
}, 60_000)

priv("MIDI-style control reaches Pluck: pitch bend, sustain pedal, the macro CCs and a new patch under a held note", async () => {
  const plain = await held(m.init)
  const bent = await held(m.init, [{ cmd: "live.bend", value: 8000 }])
  expect(maxDiff(allPcm(plain.frames), allPcm(bent.frames))).toBeGreaterThan(0.01)
  const s = await stream([
    { cmd: "live.open", engine: "PLK", patch: m.init, voices: 4 },
    { cmd: "live.cc", cc: 64, value: 127 },
    on(57), pull(20), off(57), pull(40),
  ])
  expect(s.frames.at(-1)!.held).toBe(1) // the pedal holds the released key
  // M2 is Damping: CC103 at full damps the string
  const cc = (v: number) => stream([{ cmd: "live.open", engine: "PLK", patch: m.init, voices: 2 }, { cmd: "live.cc", cc: 103, value: v }, on(57), pull(150)])
  expect(rmsMany((await cc(127)).frames.slice(-40))).toBeLessThan(rmsMany((await cc(0)).frames.slice(-40)) * 0.6)
  const bright = structuredClone(m.init); bright.values[id("Exciter")] = 2
  const swap = await stream([{ cmd: "live.open", engine: "PLK", patch: m.init, voices: 2 }, on(57), pull(20), { cmd: "live.patch", patch: bright }, pull(20), on(64), pull(40)])
  expect(swap.err).toBe("")
  expect(allPcm(swap.frames).every(Number.isFinite)).toBe(true)
  expect(rmsMany(swap.frames.slice(-40))).toBeGreaterThan(0.002)
}, 60_000)

priv("every key from E1 to C8 gives finite sound at Init, at the extremes of every parameter and with eight voices", async () => {
  for (const note of [28, 40, 52, 69, 84, 96, 108]) {
    const r = await stream([{ cmd: "live.open", engine: "PLK", patch: m.init, voices: 8 }, on(note), on(note + 7), pull(60)])
    expect(allPcm(r.frames).every(Number.isFinite)).toBe(true)
    expect(rmsMany(r.frames)).toBeGreaterThan(0.0005)
  }
  for (const extreme of ["min", "max"] as const) {
    const patch = structuredClone(m.init)
    m.params.forEach((p: any, i: number) => { if (i !== 8) patch.values[i] = p[extreme] })
    const r = await stream([{ cmd: "live.open", engine: "PLK", patch, voices: 4 }, on(40), on(64), pull(80)])
    expect(allPcm(r.frames).every(Number.isFinite)).toBe(true)
    expect(Math.max(...allPcm(r.frames).map(Math.abs))).toBeLessThanOrEqual(1.0001)
  }
}, 60_000)

priv("Init patch and an edited patch: encode, save, load and re-save byte for byte, with engine id 0x8A in the file", async () => {
  const patch = structuredClone(m.init)
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const p = m.params[i]
    patch.values[i] = p.stepped ? Math.round(p.min + (p.max - p.min) * 0.6) : p.min + (p.max - p.min) * 0.37
  }
  const path = join(tmp, "PLK", "Test.patch")
  const saved = await host.request({ cmd: "save", path, patch })
  expect(saved.size).toBeGreaterThan(30)
  const bytes = readFileSync(path)
  expect(bytes.includes(Buffer.from([0x8a]))).toBe(true)
  const back = await host.request({ cmd: "load", path, engine: "PLK" })
  expect(back.warnings).toEqual([])
  expect(back.patch.engine).toBe("PLK")
  expect(back.patch.values.length).toBe(11)
  for (let i = 0; i < 8; i++) expect(Math.abs(back.patch.values[i] - patch.values[i])).toBeLessThan(1e-6 * Math.max(1, Math.abs(patch.values[i])))
  const rt = await host.request({ cmd: "roundtrip", path })
  expect(rt).toMatchObject({ loaded: true, identical: true, codecIdentical: true, engine: "PLK" })
  const enc = await host.request({ cmd: "encode", patch: back.patch })
  expect(enc.hex).toBe(bytes.toString("hex"))
  const initPath = join(tmp, "PLK", "Init.patch")
  await host.request({ cmd: "save", path: initPath, patch: m.init })
  expect((await host.request({ cmd: "load", path: initPath, engine: "PLK" })).patch.values).toEqual(m.init.values)
  // a Pluck file is not another engine's, and the other way round
  expect((await host.tryRequest({ cmd: "load", path, engine: "PHZ" })).ok).toBe(false)
  const phz = await host.request({ cmd: "meta", engine: "PHZ" })
  const phzPath = join(tmp, "PHZ", "P.patch")
  await host.request({ cmd: "save", path: phzPath, patch: phz.init })
  expect((await host.tryRequest({ cmd: "load", path: phzPath, engine: "PLK" })).ok).toBe(false)
  const a = await held(patch), b = await held(back.patch)
  expect(maxDiff(allPcm(a.frames), allPcm(b.frames))).toBe(0)
}, 60_000)

priv("the randomizer rolls Pluck: algo 2 is keyed by engine id 0x8A and the slot, the same seed gives the same patch, every roll sounds", async () => {
  const a = randomize(m, m.init, { amount: 1, seed: 12345 }), again = randomize(m, m.init, { amount: 1, seed: 12345 })
  expect(applyPlan(m.init, a).values).toEqual(applyPlan(m.init, again).values)
  expect(applyPlan(m.init, a).values).not.toEqual(m.init.values)
  const other = randomize(m, m.init, { amount: 1, seed: 12346 })
  expect(applyPlan(m.init, other).values).not.toEqual(applyPlan(m.init, a).values)
  const twin = structuredClone(m); twin.engineId = 0x99 // the engine id is part of the key
  expect(applyPlan(twin.init, randomize(twin, twin.init, { amount: 1, seed: 12345 })).values).not.toEqual(applyPlan(m.init, a).values)
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const patch = applyPlan(m.init, randomize(m, m.init, { amount: 1, seed }))
    m.params.forEach((p: any, i: number) => { if (p.max > p.min) { expect(patch.values[i]).toBeGreaterThanOrEqual(p.min - 1e-6); expect(patch.values[i]).toBeLessThanOrEqual(p.max + 1e-6) } })
    const r = await host.request({ cmd: "render", engine: "PLK", patch, note: 57, velocity: 100, seconds: 1, hold: 0.6 })
    expect(r.finite).toBe(true)
  }
}, 60_000)

priv("a recipe of a Pluck roll replays to the same patch bytes, and survives encode and decode", async () => {
  const settings = rollSettings(m, { seed: 99n, algo: 2, amount: 80, sections: null, locks: [], macros: false })
  const patch = applyPlan(m.init, randomize(m, m.init, { algo: 2, percent: 80, seed: 99n }))
  const recipe = buildRecipe(m, "PLK", { kind: "init" }, [{ kind: "base" }, { kind: "roll", settings }], 1, null, "tracker-ff-v1.1.0")
  const code = decodeCode(encodeRecipe(recipe))
  expect(code.engine).toBe("PLK")
  const replay = replaySteps(m, m.init, code.steps)
  expect(replay.patch.values).toEqual(patch.values)
  const a = (await host.request({ cmd: "encode", patch: replay.patch })).hex, b = (await host.request({ cmd: "encode", patch })).hex
  expect(a).toBe(b)
})
