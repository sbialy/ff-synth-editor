// "Strict (match my Tracker)" in the host: what is editor only (voices above the firmware cap, the sustain pedal, the held-key registry behind
// A-Type's Priority and Duo) is capped or switched off when the request says strict, and is there when it does not. The frame header carries
// voices sounding and keys held, so no audio heuristics are needed except for the A-Type check.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { newHost, pull, rmsMany, stream } from "./helpers"
import type { HostClient } from "../server/host"

const on = (note: number, velocity = 100) => ({ cmd: "live.note", on: true, note, velocity })
const off = (note: number) => ({ cmd: "live.note", on: false, note })

let host: HostClient
let atype: any
beforeAll(async () => {
  host = await newHost()
  atype = await host.request({ cmd: "meta", engine: "ATYPE" })
}, 300_000)
afterAll(() => host.close())

test("voices: 8 asked, the firmware cap (4) is what sounds in Strict, 8 without it, a kit engine is one voice either way", async () => {
  const six = [48, 50, 52, 53, 55, 57].flatMap((n) => [on(n), pull(3)])
  for (const [strict, want] of [[true, 4], [false, 6]] as const) {
    const { frames, err } = await stream([{ cmd: "live.open", engine: "ACD", voices: 8, strict }, ...six, pull(4)])
    expect(err).toBe("")
    expect(Math.max(...frames.map((f) => f.voices))).toBe(want)
  }
  // live.voices honours the mode that live.open set, and can switch it
  const { frames } = await stream([
    { cmd: "live.open", engine: "ACD", voices: 8, strict: true }, { cmd: "live.voices", voices: 8 }, ...six, pull(4),
    { cmd: "live.panic" }, pull(4),
    { cmd: "live.voices", voices: 8, strict: false }, ...six, pull(4),
  ])
  const held = frames.map((f) => f.held) // keys down with a voice (the panic only releases, so those still count as sounding while they ring out)
  expect(Math.max(...held.slice(0, 22))).toBe(4)
  expect(Math.max(...held.slice(26))).toBe(6)
  for (const strict of [true, false]) {
    const kit = await stream([{ cmd: "live.open", engine: "TTYPE", voices: 8, strict }, on(36), pull(3), on(38), pull(3), on(42), pull(3)])
    expect(Math.max(...kit.frames.map((f) => f.voices))).toBe(1)
  }
})

test("the sustain pedal (CC64) is editor only: Strict ignores it", async () => {
  const run = (strict: boolean) =>
    stream([
      { cmd: "live.open", engine: "FM4", voices: 4, strict },
      { cmd: "live.cc", cc: 64, value: 127 },
      on(57), pull(20), off(57), pull(20),
    ])
  expect((await run(false)).frames.at(-1)!.held).toBe(1) // the pedal keeps the key down
  expect((await run(true)).frames.at(-1)!.held).toBe(0) // the Tracker lets go
  // the pedal went down in editor mode and Strict is switched on while it holds a key: it lets go at once
  const { frames } = await stream([
    { cmd: "live.open", engine: "FM4", voices: 4, strict: false },
    { cmd: "live.cc", cc: 64, value: 127 }, on(57), pull(10), off(57), pull(10),
    { cmd: "live.voices", voices: 4, strict: true }, pull(10),
  ])
  expect(frames[19]!.held).toBe(1)
  expect(frames.at(-1)!.held).toBe(0)
})

test("A-Type Priority is editor only: Low picks the low note without Strict, Strict plays the last key as the firmware does", async () => {
  const pri = atype.params.findIndex((p: any) => p.name === "Priority")
  const patch = structuredClone(atype.init)
  patch.values[pri] = 1 // Low
  const two = (strict: boolean) =>
    stream([{ cmd: "live.open", engine: "ATYPE", patch, voices: 1, strict }, on(60), pull(30), on(72), pull(60)])
  const loose = await two(false), strict = await two(true)
  const one = await stream([{ cmd: "live.open", engine: "ATYPE", patch, voices: 1 }, on(60), pull(90)])
  const pcm = (fs: { pcm: Float32Array }[]) => fs.flatMap((f) => Array.from(f.pcm)).slice(-3000)
  const diff = (a: number[], b: number[]) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i]!)), 0)
  expect(diff(pcm(loose.frames), pcm(one.frames))).toBeLessThan(0.02) // Low: the second key is held silently
  expect(diff(pcm(strict.frames), pcm(one.frames))).toBeGreaterThan(0.05) // Strict: the second key sounds
  expect(rmsMany(strict.frames.slice(-10))).toBeGreaterThan(0.005)
}, 60_000)

test("a render honours strict as well", async () => {
  const meta = await host.request({ cmd: "meta", engine: "ACD" })
  const r = await host.request({ cmd: "render", engine: "ACD", patch: meta.init, note: 57, velocity: 100, seconds: 0.3, hold: 0.2, voices: 8, strict: true, out: "/tmp/poly-editor-strict.wav" })
  expect(r.ok).toBe(true)
})
