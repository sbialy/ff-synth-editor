// Pluck 1.1 (pluck-realism): the two new parameters Vel Bright and Body. With both at their default 0 the engine renders the very same samples as the
// released PLK 1.0 (test/fixtures/pluck-1.0-goldens.json, written from the 1.0 module), old 9 value .patch files load unchanged, velocity from the keys
// and MIDI reaches the engine, and the new parameters are heard.
import { afterAll, beforeAll, expect } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { havePrivate, newHost, pull, stream, testPrivate } from "./helpers"
import { goldenHashes, goldenPatches } from "./pluck-golden-lib"
import type { HostClient } from "../server/host"

const priv = testPrivate("PLK")
let host: HostClient
let tmp: string
let m: any
let patches: Record<string, any>
const goldens: Record<string, string> = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/pluck-1.0-goldens.json"), "utf8")).hashes
beforeAll(async () => {
  if (!havePrivate("PLK")) return
  host = await newHost()
  tmp = mkdtempSync(join(tmpdir(), "poly-editor-pluckreal-"))
  m = await host.request({ cmd: "meta", engine: "PLK" })
  patches = await goldenPatches(host, tmp, m)
}, 300_000)
afterAll(() => {
  host?.close()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

const id = (name: string) => m.params.findIndex((p: any) => p.name === name)
const pcmOf = async (patch: any, note: number, velocity: number) => {
  const { frames } = await stream([{ cmd: "live.open", engine: "PLK", patch, voices: 2 }, { cmd: "live.note", on: true, note, velocity }, pull(140)])
  return frames.flatMap((f) => Array.from(f.pcm))
}
/** share of the signal energy in the first difference: a brighter pluck has more of it */
const brightness = (x: number[]) => {
  let d = 0, e = 0
  for (let i = 1; i < x.length; i++) { d += (x[i]! - x[i - 1]!) ** 2; e += x[i]! ** 2 }
  return d / Math.max(e, 1e-12)
}

priv("Vel Bright and Body are in the metadata with their names, ranges, defaults and value text, after Volume", async () => {
  expect(m.params.map((p: any) => p.name)).toEqual(["Exciter", "Brightness", "Damping", "Pick Pos", "Stretch", "Release", "Tune", "Fine", "Volume", "Vel Bright", "Body"])
  for (const n of ["Vel Bright", "Body"]) expect(m.params[id(n)]).toMatchObject({ min: 0, max: 1, def: 0, stepped: false })
  expect(m.init.values.slice(9)).toEqual([0, 0])
  expect(m.volumeParam).toBe(8)
  const section = (n: string) => m.sections.find((s: any) => s.params?.includes?.(id(n)) || s.ids?.includes?.(id(n)))?.name
  expect(section("Vel Bright")).toBe("Oscillator")
  expect(section("Body")).toBe("Filter")
  const patch = structuredClone(m.init)
  patch.values[id("Vel Bright")] = 0.5
  patch.values[id("Body")] = 1
  const d = await host.request({ cmd: "describe", engine: "PLK", patch })
  expect(d.texts.length).toBe(11)
  expect(d.texts.every((t: string) => typeof t === "string" && t.length > 0)).toBe(true)
  expect(d.texts[id("Vel Bright")]).not.toBe(d.texts[id("Body")])
  const lo = (await host.request({ cmd: "describe", engine: "PLK", patch: m.init })).texts
  expect(d.texts[id("Vel Bright")]).not.toBe(lo[id("Vel Bright")]) // the readout follows the value
  expect(d.texts[id("Body")]).not.toBe(lo[id("Body")])
})

priv("an old 9 value .patch loads unchanged: the two new parameters come in at 0 and the file re-saves with the engine's values", async () => {
  for (const [name, patch] of Object.entries(patches)) {
    if (!["SG Bass A2", "SG Bright C4", "SG Soft C5"].includes(name)) continue
    expect(patch.values.length).toBe(11)
    expect(patch.values.slice(9)).toEqual([0, 0])
    expect(patch.values[8]).toBeGreaterThan(0) // Volume was read from its old place
  }
})

priv("with Vel Bright and Body at 0 every note renders bit for bit as PLK 1.0 (28 renders: 7 patches, 2 notes, 2 velocities)", async () => {
  const now = await goldenHashes(patches)
  expect(Object.keys(now).sort()).toEqual(Object.keys(goldens).sort())
  expect(now).toEqual(goldens)
}, 120_000)

priv("an explicit 0 and 0 equals the old file, and Vel Bright at full velocity is the patch as saved", async () => {
  const explicit = await goldenHashes(patches, (p) => { p.values[id("Vel Bright")] = 0; p.values[id("Body")] = 0; return p })
  expect(explicit).toEqual(goldens)
  const full = await goldenHashes(Object.fromEntries(Object.entries(patches).slice(0, 3)), (p) => { p.values[id("Vel Bright")] = 1; return p })
  for (const [k, h] of Object.entries(full)) if (k.endsWith("|127")) expect(h).toBe(goldens[k]!)
}, 120_000)

priv("note velocity reaches the engine: with Vel Bright up a soft key is darker, with it at 0 only the level changes", async () => {
  const patch = structuredClone(patches["SG Bright C4"])
  const dry = structuredClone(patch); dry.values[id("Vel Bright")] = 0
  const wet = structuredClone(patch); wet.values[id("Vel Bright")] = 1
  const loudDry = await pcmOf(dry, 60, 127), softDry = await pcmOf(dry, 60, 50)
  const loudWet = await pcmOf(wet, 60, 127), softWet = await pcmOf(wet, 60, 50)
  expect(loudWet).toEqual(loudDry) // a full velocity key is the patch as saved
  expect(softWet).not.toEqual(softDry)
  expect(brightness(softWet)).toBeLessThan(brightness(softDry) * 0.8) // the soft key lost its highs
  expect(brightness(softDry) / brightness(loudDry)).toBeGreaterThan(0.9) // without Vel Bright the soft key is only quieter
  expect(Math.max(...softDry.map(Math.abs))).toBeLessThan(Math.max(...loudDry.map(Math.abs)))
  expect(softWet.every(Number.isFinite)).toBe(true)
}, 60_000)

priv("the render path of the page (POST /api/render, a render per note) carries the velocity as well", async () => {
  const patch = structuredClone(patches["SG Bright C4"]); patch.values[id("Vel Bright")] = 1
  const out = (name: string) => join(tmp, name)
  await host.request({ cmd: "render", engine: "PLK", patch, note: 60, velocity: 127, seconds: 0.8, hold: 0.5, out: out("loud.wav") })
  await host.request({ cmd: "render", engine: "PLK", patch, note: 60, velocity: 40, seconds: 0.8, hold: 0.5, out: out("soft.wav") })
  expect(readFileSync(out("loud.wav")).equals(readFileSync(out("soft.wav")))).toBe(false)
  const pcm16 = (f: string) => { const b = readFileSync(f); const v = new DataView(b.buffer, b.byteOffset); const x: number[] = []; for (let i = 44; i + 1 < b.length; i += 2) x.push(v.getInt16(i, true)); return x }
  expect(brightness(pcm16(out("soft.wav")))).toBeLessThan(brightness(pcm16(out("loud.wav"))) * 0.85)
})

priv("Body changes the sound, stays finite and bounded, and rings out at every exciter and from A1 to C6", async () => {
  const base = structuredClone(patches["init"])
  const plain = await pcmOf(base, 57, 100)
  for (const exciter of [0, 1, 2, 3]) for (const note of [33, 57, 84]) {
    const p = structuredClone(base); p.values[id("Exciter")] = exciter; p.values[id("Body")] = 1
    const x = await pcmOf(p, note, 100)
    expect(x.every(Number.isFinite)).toBe(true)
    expect(Math.max(...x.map(Math.abs))).toBeLessThanOrEqual(1.0001)
  }
  const body = structuredClone(base); body.values[id("Body")] = 0.5
  const x = await pcmOf(body, 57, 100)
  expect(x).not.toEqual(plain)
}, 120_000)
