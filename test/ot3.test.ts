// The OpenTracker 3.x module engines (opentracker-synths, vendor/ot3): metadata from each module's SynthDescriptor, audio through the
// real-time stream path, patch codec round trip, Poly 1 note priority.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PHZ_ONLY, PLK_ONLY, OT3_ENGINES, OT3_PARAM_COUNTS, OT3_DISPLAY, newHost, stream, pull, rmsMany } from "./helpers"
import { FIRMWARE_ENGINES, OT3_MODULES } from "../server/engines"
import type { HostClient } from "../server/host"

let host: HostClient
let tmp: string
const metas: Record<string, any> = {}
beforeAll(async () => {
  host = await newHost()
  tmp = mkdtempSync(join(tmpdir(), "poly-editor-ot3-"))
  for (const e of OT3_ENGINES) metas[e] = await host.request({ cmd: "meta", engine: e })
}, 300_000)
afterAll(() => {
  host.close()
  rmSync(tmp, { recursive: true, force: true })
})

const held = (engine: string, patch: unknown, extra: object[] = [], opts: { note?: number; voices?: number; blocks?: number } = {}) =>
  stream([
    { cmd: "live.open", engine, patch, voices: opts.voices ?? 4 },
    ...extra,
    { cmd: "live.note", on: true, note: opts.note ?? 57, velocity: 100 },
    pull(opts.blocks ?? 120),
  ])
const allPcm = (fs: { pcm: Float32Array }[]) => fs.flatMap((f) => Array.from(f.pcm))
const maxDiff = (a: number[], b: number[]) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0)

test("the host lists the ten engines with the firmware voice caps, grouped as OpenTracker 3.x", async () => {
  const e = await host.request({ cmd: "engines" })
  const ot3 = e.engines.filter((x: any) => x.group === "ot3")
  expect(ot3.map((x: any) => x.name)).toEqual([...OT3_ENGINES])
  expect(e.engines.filter((x: any) => x.group === "polyend").map((x: any) => x.name)).toEqual(["ACD", "FAT", "VAP", "WTFM", "PERC"])
  expect(e.engines.filter((x: any) => x.group === "polyend-oss").map((x: any) => x.name)).toEqual(["CHIP"])
  expect(e.engines.filter((x: any) => x.group === "phz").map((x: any) => x.name)).toEqual(PHZ_ONLY)
  expect(e.engines.filter((x: any) => x.group === "plk").map((x: any) => x.name)).toEqual(PLK_ONLY)
  expect(e.engines.filter((x: any) => x.group === "experimental").map((x: any) => x.name)).toEqual([])
  for (const x of ot3) {
    expect(x.display).toBe(OT3_DISPLAY[x.name])
    expect(x.params).toBe(OT3_PARAM_COUNTS[x.name])
    expect(x.engineId).toBeGreaterThanOrEqual(0x80)
    expect(x.maxVoices).toBe(x.name === "TTYPE" ? 1 : 4) // the firmware's cap (EngineDef::maxVoices)
    expect(x.editorMaxVoices).toBe(x.name === "TTYPE" ? 1 : 8)
  }
})

test("every engine shows its own params, sections, enum names and value text", async () => {
  for (const name of OT3_ENGINES) {
    const m = metas[name]
    expect(m.params.length).toBe(OT3_PARAM_COUNTS[name])
    expect(m.sections.length).toBeGreaterThanOrEqual(5)
    const inSection = new Set(m.sections.flatMap((s: any) => s.params))
    expect(inSection.size).toBeGreaterThan(m.params.length * 0.8)
    for (const p of m.params) {
      expect(p.name.length).toBeGreaterThan(0)
      expect(p.max).toBeGreaterThanOrEqual(p.min)
      expect(p.def).toBeGreaterThanOrEqual(p.min)
      expect(p.def).toBeLessThanOrEqual(p.max)
      if (p.isEnum) expect(p.names.length).toBe(p.max - p.min + 1)
    }
    const d = await host.request({ cmd: "describe", engine: name, patch: m.init })
    expect(d.texts.length).toBe(m.params.length)
    expect(d.texts.every((t: string) => typeof t === "string" && t.length > 0)).toBe(true)
  }
  // spot checks against the module descriptors
  expect(metas.JU6.params.map((p: any) => p.name).slice(0, 4)).toEqual(["Saw", "Pulse", "PW", "PWM"])
  expect(metas.JU6.sections.map((s: any) => s.shortName)).toEqual(["DCO", "VCF", "VCA", "ENV", "LFO", "Chorus"]) // the firmware engine_ju6.cpp, not the module descriptor ("CHO")
  expect(metas.FM4.params[0].name).toBe("Algorithm")
  expect(metas.FM4.sections.map((s: any) => s.name)).toEqual(["Global", "LFO", "Operator 1", "Operator 2", "Operator 3", "Operator 4"])
  expect(metas.ATYPE.params[0].names).toEqual(["32'", "16'", "8'", "4'"])
  expect(metas.TTYPE.volumeParam).toBe(-1) // T-Type has no Volume, velocity applies per hit
  expect(metas.TTYPE.sections.map((s: any) => s.name).slice(0, 3)).toEqual(["Kick", "Snare", "Clap"])
})

test("each engine renders a held note through the stream path: finite, non-silent, bounded", async () => {
  for (const name of OT3_ENGINES) {
    const { frames, err } = await held(name, metas[name].init)
    const pcm = allPcm(frames)
    expect(pcm.length).toBe(120 * 128)
    expect(pcm.every(Number.isFinite)).toBe(true)
    const rms = rmsMany(frames)
    const peak = Math.max(...pcm.map(Math.abs))
    expect(rms).toBeGreaterThan(0.01)
    expect(peak).toBeGreaterThan(0.05)
    expect(peak).toBeLessThanOrEqual(1.0001)
    expect(err).not.toMatch(/error|abort/i)
  }
}, 120_000)

test("a held key shows in the frame header and the note dies away after the release", async () => {
  for (const name of OT3_ENGINES) {
    if (name === "TTYPE") continue // drums are one shots
    const { frames } = await stream([
      { cmd: "live.open", engine: name, patch: metas[name].init, voices: 4 },
      { cmd: "live.note", on: true, note: 57, velocity: 100 },
      pull(60),
      { cmd: "live.note", on: false, note: 57 },
      pull(1500),
    ])
    expect(frames[59]!.held).toBe(1)
    expect(frames[59]!.voices).toBe(1)
    expect(frames.at(-1)!.held).toBe(0)
    expect(frames.at(-1)!.voices).toBe(0) // the release ended, the voice was freed
    expect(rmsMany(frames.slice(-20))).toBeLessThan(1e-4)
  }
}, 120_000)

test("a parameter change alters the output", async () => {
  for (const name of OT3_ENGINES) {
    const m = metas[name]
    const vol = m.volumeParam >= 0 ? m.volumeParam : 0 // T-Type: the kick's Level, the kick is note 60
    const base = await held(name, m.init, [], { note: name === "TTYPE" ? 60 : 57 })
    const patch = structuredClone(m.init)
    patch.values[vol] = m.params[vol].def * 0.4
    const quiet = await held(name, patch, [], { note: name === "TTYPE" ? 60 : 57 })
    expect(maxDiff(allPcm(base.frames), allPcm(quiet.frames))).toBeGreaterThan(0.01)
    expect(rmsMany(quiet.frames)).toBeLessThan(rmsMany(base.frames))
    // the same patch twice is the same sound
    const again = await held(name, m.init, [], { note: name === "TTYPE" ? 60 : 57 })
    expect(maxDiff(allPcm(base.frames), allPcm(again.frames))).toBe(0)
  }
}, 120_000)

test("a knob moved while the note holds is heard", async () => {
  for (const name of OT3_ENGINES) {
    const m = metas[name]
    const vol = m.volumeParam >= 0 ? m.volumeParam : 0
    const { frames } = await stream([
      { cmd: "live.open", engine: name, patch: m.init, voices: 4 },
      { cmd: "live.note", on: true, note: name === "TTYPE" ? 60 : 57, velocity: 100 },
      pull(60),
      { cmd: "live.param", param: vol, value: 0 },
      pull(200),
    ])
    expect(rmsMany(frames.slice(0, 60))).toBeGreaterThan(0.01)
    expect(rmsMany(frames.slice(-40))).toBeLessThan(rmsMany(frames.slice(0, 60)) * 0.1)
  }
}, 120_000)

test("polyphony 1 to 8: held voices follow the setting for every engine", async () => {
  for (const name of OT3_ENGINES) {
    if (name === "TTYPE") continue
    for (const voices of [1, 3, 8]) {
      const notes = [48, 52, 55, 59, 62, 65, 69, 72, 76, 79].map((note) => ({ cmd: "live.note", on: true, note, velocity: 90 }))
      const { frames } = await stream([{ cmd: "live.open", engine: name, patch: metas[name].init, voices }, ...notes, pull(40)])
      const last = frames.at(-1)!
      expect(last.held).toBe(voices) // more keys than voices: the oldest are stolen
      expect(allPcm(frames).every(Number.isFinite)).toBe(true)
      expect(rmsMany(frames.slice(-10))).toBeGreaterThan(0.005)
    }
  }
}, 180_000)

test("MIDI-style control reaches the engines: pitch bend moves the sound, CC 64 holds a released note", async () => {
  for (const name of ["FM4", "JU6", "DTYPE", "8TYPE"]) {
    const plain = await held(name, metas[name].init)
    const bent = await held(name, metas[name].init, [{ cmd: "live.bend", value: 8000 }])
    expect(maxDiff(allPcm(plain.frames), allPcm(bent.frames))).toBeGreaterThan(0.05)
    const { frames } = await stream([
      { cmd: "live.open", engine: name, patch: metas[name].init, voices: 4 },
      { cmd: "live.cc", cc: 64, value: 127 },
      { cmd: "live.note", on: true, note: 57, velocity: 100 },
      pull(20),
      { cmd: "live.note", on: false, note: 57 },
      pull(40),
    ])
    expect(frames.at(-1)!.held).toBe(1) // the pedal keeps the key logically down (and the voice sounding)
    expect(frames.at(-1)!.voices).toBe(1)
    expect(rmsMany(frames.slice(-10))).toBeGreaterThan(0.005)
    const up = await stream([
      { cmd: "live.open", engine: name, patch: metas[name].init, voices: 4 },
      { cmd: "live.cc", cc: 64, value: 127 },
      { cmd: "live.note", on: true, note: 57, velocity: 100 },
      pull(20),
      { cmd: "live.note", on: false, note: 57 },
      pull(20),
      { cmd: "live.cc", cc: 64, value: 0 },
      pull(2000),
    ])
    expect(up.frames.at(-1)!.held).toBe(0)
    expect(up.frames.at(-1)!.voices).toBe(0)
  }
}, 60_000)

test("A-Type Poly 1 note priority: Low and High pick the sounding note, release returns to the held one", async () => {
  const m = metas.ATYPE
  const pri = m.params.findIndex((p: any) => p.name === "Priority")
  expect(pri).toBe(42)
  expect(m.params[pri].names).toEqual(["Last", "Low", "High"])
  const run = async (mode: number) => {
    const patch = structuredClone(m.init)
    patch.values[pri] = mode
    return stream([
      { cmd: "live.open", engine: "ATYPE", patch, voices: 1 },
      { cmd: "live.note", on: true, note: 60, velocity: 100 },
      pull(30),
      { cmd: "live.note", on: true, note: 72, velocity: 100 },
      pull(60),
    ])
  }
  const last = await run(0), low = await run(1)
  // Last: the second note takes over (the sound changes), Low: it is held silently (the sound stays the same as one note)
  const lowOne = await stream([{ cmd: "live.open", engine: "ATYPE", patch: (() => { const p = structuredClone(m.init); p.values[pri] = 1; return p })(), voices: 1 }, { cmd: "live.note", on: true, note: 60, velocity: 100 }, pull(90)])
  expect(maxDiff(allPcm(low.frames).slice(-3000), allPcm(lowOne.frames).slice(-3000))).toBeLessThan(0.02)
  expect(maxDiff(allPcm(last.frames).slice(-3000), allPcm(lowOne.frames).slice(-3000))).toBeGreaterThan(0.05)
  expect(low.frames.at(-1)!.held).toBe(1)
  // release the sounding note: the voice goes back to the note still held
  const back = await stream([
    { cmd: "live.open", engine: "ATYPE", patch: (() => { const p = structuredClone(m.init); p.values[pri] = 2; return p })(), voices: 1 },
    { cmd: "live.note", on: true, note: 60, velocity: 100 },
    { cmd: "live.note", on: true, note: 72, velocity: 100 },
    pull(30),
    { cmd: "live.note", on: false, note: 72 },
    pull(60),
  ])
  expect(back.frames.at(-1)!.held).toBe(1)
  expect(rmsMany(back.frames.slice(-10))).toBeGreaterThan(0.01)
}, 60_000)

test("A-Type Keyboard Duo: two held keys at Poly 1 tune VCO 1 and VCO 2 to the low and the high note", async () => {
  const m = metas.ATYPE
  const key = m.params.findIndex((p: any) => p.name === "Keyboard")
  expect(m.params[key].names).toEqual(["Mono", "Duo"])
  const two = (mode: number) => {
    const patch = structuredClone(m.init)
    patch.values[key] = mode
    return stream([
      { cmd: "live.open", engine: "ATYPE", patch, voices: 1 },
      { cmd: "live.note", on: true, note: 48, velocity: 100 },
      { cmd: "live.note", on: true, note: 55, velocity: 100 },
      pull(80),
    ])
  }
  const mono = await two(0), duo = await two(1)
  expect(maxDiff(allPcm(mono.frames).slice(-4000), allPcm(duo.frames).slice(-4000))).toBeGreaterThan(0.02)
  expect(duo.frames.at(-1)!.held).toBe(1) // one voice, two keys down
}, 30_000)

test("Init patch and edited patch: encode, save, load and re-save byte for byte", async () => {
  for (const name of OT3_ENGINES) {
    const m = metas[name]
    const patch = structuredClone(m.init)
    // edit a few parameters (not the first, which is often a switch) within their range
    for (const id of [1, 3, 5, 9]) {
      const p = m.params[id]
      if (p && !p.stepped) patch.values[id] = p.min + (p.max - p.min) * 0.37
    }
    const path = join(tmp, name, "Test.patch")
    const saved = await host.request({ cmd: "save", path, patch })
    expect(saved.size).toBeGreaterThan(30)
    const back = await host.request({ cmd: "load", path, engine: name })
    expect(back.warnings).toEqual([])
    expect(back.patch.engine).toBe(name)
    expect(back.patch.values.length).toBe(OT3_PARAM_COUNTS[name])
    for (const id of [1, 3, 5, 9]) expect(back.patch.values[id]).toBeCloseTo(patch.values[id], 4)
    const rt = await host.request({ cmd: "roundtrip", path })
    expect(rt).toMatchObject({ loaded: true, identical: true, codecIdentical: true, engine: name })
    const enc = await host.request({ cmd: "encode", patch: back.patch })
    expect(enc.hex).toBe(readFileSync(path).toString("hex"))
    // the Init patch too
    const initPath = join(tmp, name, "Init.patch")
    await host.request({ cmd: "save", path: initPath, patch: m.init })
    const init = await host.request({ cmd: "load", path: initPath, engine: name })
    expect(init.patch.values).toEqual(m.init.values)
    // the file keeps the engine: another engine's name refuses it
    const wrong = await host.tryRequest({ cmd: "load", path, engine: name === "FM4" ? "JU6" : "FM4" })
    expect(wrong.ok).toBe(false)
  }
  expect(readdirSync(tmp).sort()).toEqual([...OT3_ENGINES].sort())
}, 60_000)

test("a saved patch sounds the same as the patch in memory", async () => {
  for (const name of ["FM4", "ATYPE", "ARCTYPE", "HANDTYPE"]) {
    const m = metas[name]
    const patch = structuredClone(m.init)
    const id = m.params.findIndex((p: any) => p.name === "Volume" || p.name === "Level")
    patch.values[id] = m.params[id].min + (m.params[id].max - m.params[id].min) * 0.5
    const path = join(tmp, name, "Sound.patch")
    await host.request({ cmd: "save", path, patch })
    const back = (await host.request({ cmd: "load", path, engine: name })).patch
    const a = await held(name, patch), b = await held(name, back)
    expect(maxDiff(allPcm(a.frames), allPcm(b.frames))).toBe(0)
  }
}, 60_000)

test("the ten module engines are the OT3 list and all of them, Hand-Type included, are in the firmware release image (tracker-ff 1.2.0)", () => {
  expect(Object.keys(OT3_MODULES)).toEqual([...OT3_ENGINES])
  for (const name of OT3_ENGINES) expect(FIRMWARE_ENGINES.includes(name)).toBe(true)
})
