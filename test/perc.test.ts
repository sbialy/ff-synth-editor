// PERC, the Polyend drum engine (the firmware's optional engine, synth-open/engine_perc.cpp): metadata from the firmware tables,
// the ids it takes (type 6, no clash with the editor-only engines), one voice per slot, the per-drum sends that are inert in the
// editor, and the patch files: the 47 Polyend factory patches and the 16 OpenTracker 2.2.4 kits load and survive a save-load round trip.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { available, factoryDir, havePrivate, newHost, parseWav, pull, rmsMany, stream } from "./helpers"
import type { HostClient } from "../server/host"

let host: HostClient
let tmp: string
let m: any
beforeAll(async () => {
  host = await newHost()
  tmp = mkdtempSync(join(tmpdir(), "poly-editor-perc-"))
  m = await host.request({ cmd: "meta", engine: "PERC" })
}, 300_000)
afterAll(() => {
  host.close()
  rmSync(tmp, { recursive: true, force: true })
})

const idOf = (name: string) => m.params.findIndex((p: any) => p.name === name)
// the drum sections: Kick 0-8 Toms 9-17 Snare 18-26 Hihat 27-35 Cymbal 36-44 Percussion 45-48 Mixer 49-78 FX 79-83
const mixer = (drum: string, what: string) => m.params.findIndex((p: any) => p.section === "Mixer" && p.name === `${drum} ${what}`)

test("PERC is listed after WTFM in the OpenTracker 2.x group with type 6, one voice and no clash with another engine", async () => {
  const e = await host.request({ cmd: "engines" })
  const names = e.engines.map((x: any) => x.name)
  expect(names.indexOf("PERC")).toBe(names.indexOf("WTFM") + 1)
  const x = e.engines.find((y: any) => y.name === "PERC")
  expect(x).toMatchObject({ display: "PERC", group: "polyend", typeId: 6, engineId: 6, params: 84, sections: 8, maxVoices: 1 })
  expect(new Set(e.engines.map((y: any) => y.typeId)).size).toBe(e.engines.length)
  expect(new Set(e.engines.map((y: any) => y.engineId)).size).toBe(e.engines.length)
  // the other Polyend ids did not move when PERC came back
  expect(Object.fromEntries(e.engines.filter((y: any) => available(["ACD", "FAT", "VAP", "WTFM", "PERC", "CHIP", "PHZ", "FM4"]).includes(y.name)).map((y: any) => [y.name, y.engineId]))).toEqual({ ACD: 1, FAT: 2, VAP: 4, WTFM: 5, PERC: 6, CHIP: 8, ...(havePrivate("PHZ") ? { PHZ: 0x82 } : {}), FM4: 0x80 })
})

test("metadata: 84 parameters in 8 sections, no Volume, value text for note and body wave", async () => {
  expect(m.params.length).toBe(84)
  expect(m.volumeParam).toBe(-1)
  expect(m.sections.map((s: any) => `${s.name}:${s.params.length}`)).toEqual(["Kick:9", "Toms:9", "Snare:9", "Hihat:9", "Cymbal:9", "Percussion:4", "Mixer:30", "FX:5"])
  expect(m.params[0]).toMatchObject({ name: "Body Wave", min: 0, max: 175, stepped: true })
  expect(m.params[1]).toMatchObject({ name: "Pitch", min: 12, max: 119, def: 31, stepped: true })
  expect(m.params[8].names).toEqual(["Classic8", "Synced8", "Classic9"]) // kick model
  expect(m.params[mixer("Kick", "Output")].names).toEqual(["Main", "Post Overdrive", "Post EQ"])
  const d = await host.request({ cmd: "describe", engine: "PERC", patch: m.init })
  expect(d.texts.length).toBe(84)
  expect(d.texts.every((t: string) => typeof t === "string" && t.length > 0)).toBe(true)
  expect(d.texts[0]).toBe("Sat-Sin 0%") // body wave: family and position
  expect(d.texts[1]).toBe("G1") // pitch 31 as a note name
  // the end of the body wave range is the last family at 100%, the pitch range ends on B8
  const hi = await host.request({ cmd: "knob", engine: "PERC", param: 0, knob: 1 })
  expect(hi.value).toBe(175)
  expect(hi.text).toBe("Glitch 4 100%")
  const note = await host.request({ cmd: "knob", engine: "PERC", param: 1, knob: 1 })
  expect(note.text).toBe("B8")
})

test("every drum plays: the kick, snare, hats, cymbal, perc and a tom make finite sound, the unmapped keys none", async () => {
  const rms: Record<number, number> = {}
  for (const note of [60, 62, 64, 66, 69, 71, 48, 61]) {
    const { frames, err } = await stream([{ cmd: "live.open", engine: "PERC" }, { cmd: "live.note", on: true, note, velocity: 100 }, pull(60)])
    expect(err).toBe("")
    expect(frames.every((f) => f.pcm.every(Number.isFinite))).toBe(true)
    rms[note] = rmsMany(frames)
  }
  for (const note of [60, 62, 64, 66, 69, 71, 48]) expect(rms[note]).toBeGreaterThan(0.005)
  expect(rms[61]).toBeLessThan(1e-6) // C#4 belongs to no drum
})

test("velocity is the gain: a soft hit is quieter than a hard one", async () => {
  const hit = async (velocity: number) => rmsMany((await stream([{ cmd: "live.open", engine: "PERC" }, { cmd: "live.note", on: true, note: 60, velocity }, pull(60)])).frames)
  const soft = await hit(30), hard = await hit(127)
  expect(soft).toBeGreaterThan(0)
  expect(soft).toBeLessThan(hard * 0.6)
})

test("one voice per slot: 8 asked, 1 sounds, and a render with 8 voices equals one with 1", async () => {
  const a = join(tmp, "v1.wav"), b = join(tmp, "v8.wav")
  await host.request({ cmd: "render", engine: "PERC", note: 60, seconds: 1, float: true, voices: 1, out: a })
  await host.request({ cmd: "render", engine: "PERC", note: 60, seconds: 1, float: true, voices: 8, out: b })
  expect(readFileSync(a).equals(readFileSync(b))).toBe(true)
})

test("the per-drum Delay and Reverb sends are inert, as in the firmware (the shim reports no aux sends for them, setSendTap is never called): the engine's own part level sends are the live ones", async () => {
  const render = async (patch: any, name: string) => {
    const out = join(tmp, name)
    await host.request({ cmd: "render", engine: "PERC", patch, note: 62, seconds: 1.5, hold: 0.5, float: true, out })
    return parseWav(readFileSync(out)).samples
  }
  const dry = await render(m.init, "dry.wav")
  const sent = structuredClone(m.init)
  for (const drum of ["Kick", "Tom", "Snare", "Hi Hat", "Cymbal", "Perc"]) for (const send of ["Delay", "Reverb"]) sent.values[mixer(drum, send)] = 1
  const wet = await render(sent, "wet.wav")
  expect(dry.some((v) => Math.abs(v) > 0.01)).toBe(true)
  expect(wet.length).toBe(dry.length)
  expect(wet.every((v, i) => v === dry[i])).toBe(true)
  // while a real parameter of the same drum is heard
  const loud = structuredClone(m.init)
  loud.values[mixer("Snare", "Level")] = 0.2
  const quiet = await render(loud, "quiet.wav")
  expect(quiet.some((v, i) => Math.abs(v - dry[i]) > 1e-3)).toBe(true)
})

test("save-load round trip of an edited PERC patch gives the same values and the same bytes again", async () => {
  const patch = structuredClone(m.init)
  patch.values = m.params.map((p: any) => (p.stepped ? Math.round(p.min + 0.3 * (p.max - p.min)) : Math.fround(p.min + 0.3 * (p.max - p.min))))
  patch.macros[0].name = "Drum Decay"
  patch.macros[1].targets = [{ param: idOf("Body Decay"), amount: Math.fround(0.5) }]
  const path = join(tmp, "PERC", "edited.patch")
  await host.request({ cmd: "save", path, patch })
  const back = (await host.request({ cmd: "load", path })).patch
  expect(back.engine).toBe("PERC")
  expect(back.values.map((v: number | null) => (v === null ? null : Math.fround(v)))).toEqual(patch.values.map((v: number) => Math.fround(v)))
  expect(back.macros[0].name).toBe("Drum Decay")
  const path2 = join(tmp, "PERC", "edited2.patch")
  await host.request({ cmd: "save", path: path2, patch: back })
  expect(readFileSync(path2).equals(readFileSync(path))).toBe(true)
  // it is a PERC file, another engine refuses it
  expect(await host.tryRequest({ cmd: "load", path, engine: "ACD" })).toMatchObject({ ok: false })
})

/** load -> save -> load of every file of a folder: the values must come back the same and a second save must write the same bytes */
async function roundTripAll(dir: string) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".patch")).sort()
  const bad: string[] = []
  let identical = 0
  for (const f of files) {
    const a = await host.tryRequest({ cmd: "load", path: join(dir, f), engine: "PERC" })
    if (!a.ok) { bad.push(`${f}: ${a.error}`); continue }
    const p1 = join(tmp, "rt", f)
    await host.request({ cmd: "save", path: p1, patch: a.patch })
    const b = await host.request({ cmd: "load", path: p1, engine: "PERC" })
    const p2 = join(tmp, "rt2", f)
    await host.request({ cmd: "save", path: p2, patch: b.patch })
    if (JSON.stringify(b.patch) !== JSON.stringify(a.patch)) bad.push(`${f}: values or macros changed by a save-load`)
    else if (!readFileSync(p1).equals(readFileSync(p2))) bad.push(`${f}: second save differs`)
    if (readFileSync(p1).equals(readFileSync(join(dir, f)))) identical++
    const r = await host.request({ cmd: "render", engine: "PERC", patch: a.patch, note: 60, seconds: 0.5, hold: 0.3 })
    if (!r.finite) bad.push(`${f}: non finite audio`)
  }
  return { files: files.length, bad, identical }
}

const factory = join(factoryDir || "/nonexistent", "PERC")
describe.skipIf(!existsSync(factory))("Polyend factory PERC patches", () => {
  test("all 47 load as PERC and survive a save-load round trip", async () => {
    const r = await roundTripAll(factory)
    expect(r.files).toBe(47)
    expect(r.bad).toEqual([])
    console.log(`PERC factory: ${r.files} patches load and round trip, ${r.identical} re-save to the same bytes`)
  }, 120_000)
})

// OpenTracker 2.2.4 kits (OpenTracker-2.2.4-Patches.zip), unpacked by hand: POLY_OT224_PERC=<dir of the PERC .patch files>
const ot224 = process.env.POLY_OT224_PERC ?? "/tmp/ot224-patches/x/Patches/PERC"
describe.skipIf(!existsSync(ot224))("OpenTracker 2.2.4 PERC kits", () => {
  test("all 16 load as PERC and survive a save-load round trip", async () => {
    const r = await roundTripAll(ot224)
    expect(r.files).toBe(16)
    expect(r.bad).toEqual([])
    console.log(`PERC OT 2.2.4: ${r.files} kits load and round trip, ${r.identical} re-save to the same bytes`)
  }, 120_000)
})
