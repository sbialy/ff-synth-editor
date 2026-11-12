// MIDI control of the streaming path: the messages the page forwards from Web MIDI (live.note, live.cc, live.bend, live.voices)
// and the polyphony setting. Voice counts come from the frame header (voices sounding, keys held), so no audio heuristics there.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startServer } from "../server/index"
import { POLYEND_AND_PLUCK, ensureBuilt, newHost, pull, rmsMany, stream } from "./helpers"
import type { HostClient } from "../server/host"

const on = (note: number, velocity = 100) => ({ cmd: "live.note", on: true, note, velocity })
const off = (note: number) => ({ cmd: "live.note", on: false, note })
const cc = (c: number, value: number) => ({ cmd: "live.cc", cc: c, value })
const last = <T,>(a: T[]) => a[a.length - 1]

let host: HostClient
beforeAll(async () => {
  host = await newHost()
}, 300_000)
afterAll(() => host.close())

// PERC is held to one voice by the host (its kit lives in the slot scratch), see "PERC: one voice" below
describe.each(POLYEND_AND_PLUCK.filter((e) => e !== "PERC"))("polyphony %s", (engine) => {
  test("8 held notes are 8 voices, a 9th steals the oldest, 1..8 is the cap", async () => {
    const notes = [48, 50, 52, 53, 55, 57, 59, 60]
    const { frames, err } = await stream([
      { cmd: "live.open", engine, voices: 8 },
      ...notes.flatMap((n) => [on(n), pull(4)]),
      pull(4), // frames.at(-1) of each step is the state after it
      on(62), pull(8),
      off(48), pull(4), // the oldest note was stolen by the 9th: releasing it frees nothing
      off(62), pull(4), // the 9th is held, releasing it does
    ])
    expect(err).toBe("")
    const state = (i: number) => ({ voices: frames[i].voices, held: frames[i].held })
    expect(state(4 * 8 + 3)).toEqual({ voices: 8, held: 8 }) // after the 8th note
    expect(state(4 * 8 + 4 + 8 - 1)).toEqual({ voices: 8, held: 8 }) // 9th: still 8, one was stolen
    expect(state(4 * 8 + 4 + 8 + 4 - 1)).toEqual({ voices: 8, held: 8 }) // note 48 had no voice left to release
    expect(last(frames).held).toBe(7)
    expect(rmsMany(frames.slice(4 * 8 + 8, 4 * 8 + 12))).toBeGreaterThan(0.005)
  })
})

describe("PERC: one voice", () => {
  test("voices 8 asked, one voice sounds: a second hit takes the kit over, live.voices cannot raise it", async () => {
    const { frames, err } = await stream([
      { cmd: "live.open", engine: "PERC", voices: 8 },
      on(36), pull(4), on(38), pull(4), on(42), pull(4),
      { cmd: "live.voices", voices: 6 },
      on(46), pull(4),
    ])
    expect(err).toBe("")
    expect(Math.max(...frames.map((f) => f.voices))).toBe(1)
    expect(Math.max(...frames.map((f) => f.held))).toBe(1)
    expect(rmsMany(frames)).toBeGreaterThan(0.005)
  })
})

describe("polyphony setting", () => {
  test.each([1, 2, 3, 5, 8])("voices=%d caps the held voices there", async (voices) => {
    const { frames } = await stream([
      { cmd: "live.open", engine: "ACD", voices },
      ...[48, 52, 55, 59, 62, 65, 67, 71, 72, 74].flatMap((n) => [on(n), pull(2)]),
    ])
    expect(Math.max(...frames.map((f) => f.voices))).toBe(voices)
    expect(last(frames).held).toBe(voices)
  })

  test("live.voices changes the cap on a running session, out of range values are clamped", async () => {
    const { frames, err } = await stream([
      { cmd: "live.open", engine: "ACD" }, // the default is 2, the firmware's cap
      on(48), on(52), on(55), pull(4),
      { cmd: "live.voices", voices: 4 },
      on(59), on(62), on(65), pull(4),
      { cmd: "live.voices", voices: 99 },
      on(67), on(69), on(71), on(72), on(74), pull(4),
    ])
    expect(err).toBe("")
    expect(frames[3].voices).toBe(2)
    expect(frames[7].voices).toBe(4)
    expect(last(frames).voices).toBe(8)
  })

  test("voices=1 is mono legato: a second key bends the same voice, no second voice and no retrigger", async () => {
    const zcr = (fs: { pcm: Float32Array }[]) => {
      let z = 0, prev = 0
      for (const f of fs) for (const x of f.pcm) { if (prev <= 0 !== x <= 0) z++; prev = x }
      return z
    }
    const lines = (voices: number) => [
      { cmd: "live.open", engine: "CHIP", voices },
      on(48), pull(80),
      on(60), pull(80), // an octave up while the first key is still down
    ]
    const mono = (await stream(lines(1))).frames
    expect(Math.max(...mono.map((f) => f.voices))).toBe(1)
    expect(last(mono).held).toBe(1)
    expect(zcr(mono.slice(120, 160))).toBeGreaterThan(zcr(mono.slice(40, 80)) * 1.5) // the pitch moved to the new key
    expect(rmsMany(mono.slice(82, 90))).toBeGreaterThan(0.02) // no gap where an envelope restarts

    const poly = (await stream(lines(2))).frames
    expect(last(poly).voices).toBe(2) // the same keys with 2 voices are two voices
  })

  test("sustain pedal (CC64) holds released keys until it goes up", async () => {
    const { frames, err } = await stream([
      { cmd: "live.open", engine: "ACD", voices: 4 },
      on(48), on(52), pull(4),
      cc(64, 127), off(48), off(52), pull(8), // pedal down: the keys are up but the voices are still gated
      on(55), pull(4),
      cc(64, 0), pull(4), // pedal up: 48 and 52 are released, 55 is still held
      off(55), pull(4),
      cc(64, 127), on(60), off(60), on(60), pull(4), // struck again while sustained: the held voice is let go, the new one holds
      cc(64, 0), pull(4),
    ])
    expect(err).toBe("")
    expect(frames[3].held).toBe(2)
    expect(frames[11].held).toBe(2)
    expect(frames[15].held).toBe(3)
    expect(frames[19].held).toBe(1)
    expect(frames[23].held).toBe(0)
    expect(frames[27].held).toBe(1) // 60 struck twice: the first voice was released by the second strike
    expect(last(frames).held).toBe(1) // the pedal going up has nothing to release, key 60 is still down
  })

  test("CC123 and CC120 release everything and drop the held pedal keys", async () => {
    const { frames } = await stream([
      { cmd: "live.open", engine: "ACD", voices: 4 },
      on(48), on(52), cc(64, 127), off(52), pull(4),
      cc(123, 0), pull(4),
      cc(64, 0), pull(4),
      on(55), on(57), pull(4),
      cc(120, 0), pull(4),
    ])
    expect(frames[3].held).toBe(2)
    expect(frames[7].held).toBe(0)
    expect(frames[11].held).toBe(0)
    expect(frames[15].held).toBe(2)
    expect(frames[19].held).toBe(0)
  })
})

describe("pitch bend, mod wheel, macros", () => {
  const zcr = (fs: { pcm: Float32Array }[]) => {
    let z = 0, prev = 0
    for (const f of fs) for (const x of f.pcm) { if (prev <= 0 !== x <= 0) z++; prev = x }
    return z
  }

  test("pitch bend moves a held note by +-1 semitone and a bend before the note applies to it", async () => {
    const { frames, err } = await stream([
      { cmd: "live.open", engine: "CHIP", voices: 2 },
      { cmd: "live.bend", value: -8192 }, on(48), pull(120), // bent down before the key
      { cmd: "live.bend", value: 8191 }, pull(120), // up while it holds
      { cmd: "live.bend", value: 0 }, pull(120),
    ])
    expect(err).toBe("")
    const down = zcr(frames.slice(60, 120)), up = zcr(frames.slice(180, 240)), mid = zcr(frames.slice(300, 360))
    expect(up / down).toBeGreaterThan(1.09) // two semitones apart is 12.2 percent
    expect(up / down).toBeLessThan(1.16)
    expect(mid / down).toBeGreaterThan(1.03)
    expect(mid / down).toBeLessThan(1.09)
  })

  test("CC1 (mod wheel) is accepted and changes nothing, as the firmware ignores it", async () => {
    const base = [{ cmd: "live.open", engine: "ACD" }, on(57), pull(60)]
    const a = await stream([...base, pull(60)])
    const b = await stream([...base, cc(1, 127), pull(60)])
    expect(b.err).toBe("")
    expect(rmsMany(b.frames.slice(61))).toBeCloseTo(rmsMany(a.frames.slice(61)), 6)
  })

  test("CC102..107 move macros M1..M6 like the firmware shim: M1 opens the ACD cutoff", async () => {
    const m = await host.request({ cmd: "meta", engine: "ACD" })
    const cutoff = m.params.findIndex((p: any) => p.name === "Cutoff")
    const patch = structuredClone(m.init)
    patch.values[cutoff] = 150
    const bright = (fs: { pcm: Float32Array }[]) => {
      let d = 0, e = 0
      for (const f of fs) for (let i = 1; i < f.pcm.length; i++) { d += (f.pcm[i] - f.pcm[i - 1]) ** 2; e += f.pcm[i] ** 2 }
      return d / Math.max(e, 1e-12)
    }
    const run = (value: number) => stream([{ cmd: "live.open", engine: "ACD", patch }, cc(102, value), on(48), pull(120)])
    const closed = (await run(0)).frames.slice(60), open = (await run(127)).frames.slice(60)
    expect(bright(open)).toBeGreaterThan(bright(closed) * 1.5)
  })
})

describe("patch auto-load on a running session", () => {
  test("live.patch swaps the sound of a held note without cutting it, and the next note plays the new patch", async () => {
    const m = await host.request({ cmd: "meta", engine: "ACD" })
    const cutoff = m.params.findIndex((p: any) => p.name === "Cutoff")
    const at = (hz: number) => { const p = structuredClone(m.init); p.values[cutoff] = hz; return p }
    const bright = (fs: { pcm: Float32Array }[]) => {
      let d = 0, e = 0
      for (const f of fs) for (let i = 1; i < f.pcm.length; i++) { d += (f.pcm[i] - f.pcm[i - 1]) ** 2; e += f.pcm[i] ** 2 }
      return d / Math.max(e, 1e-12)
    }
    const { frames, err } = await stream([
      { cmd: "live.open", engine: "ACD", patch: at(12000), voices: 4 },
      on(48), pull(100),
      { cmd: "live.patch", patch: at(700) }, // arrow key in the patch list: the held note takes the new patch
      pull(100),
      off(48), on(55), pull(100), // the next note is the new sound as well
    ])
    expect(err).toBe("")
    expect(frames.slice(0, 100).every((f) => f.held === 1)).toBe(true)
    expect(frames.slice(100, 200).every((f) => f.held === 1 && f.voices === 1)).toBe(true) // not cut by the swap
    expect(bright(frames.slice(40, 100))).toBeGreaterThan(bright(frames.slice(140, 200)) * 1.5)
    expect(bright(frames.slice(240, 300))).toBeLessThan(bright(frames.slice(40, 100)) / 1.5)
    expect(rmsMany(frames.slice(140, 200))).toBeGreaterThan(0.002)
  })
})

describe("websocket relay carries MIDI", () => {
  let srv: Awaited<ReturnType<typeof startServer>>
  let dir: string
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "poly-editor-midi-"))
    await ensureBuilt()
    srv = await startServer({ port: 0, dir })
  }, 300_000)
  afterAll(() => {
    srv.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  test("8 notes over the socket are 8 voices in the frame header, a 9th steals, pedal and bend are accepted", async () => {
    const ws = new WebSocket(srv.url.replace("http", "ws") + "/api/live")
    ws.binaryType = "arraybuffer"
    const heads: { voices: number; held: number; cmdId: number }[] = [], texts: string[] = []
    ws.onmessage = (e) => {
      if (typeof e.data === "string") return void texts.push(e.data)
      const dv = new DataView(e.data as ArrayBuffer)
      heads.push({ cmdId: dv.getUint32(8, true), voices: dv.getUint32(16, true), held: dv.getUint32(20, true) })
    }
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")) })
    const send = (o: object) => ws.send(JSON.stringify(o))
    send({ cmd: "live.open", engine: "CHIP", voices: 8, id: 1 })
    send({ cmd: "live.bend", value: 2048, id: 2 })
    send({ cmd: "live.cc", cc: 64, value: 127, id: 3 })
    for (let n = 0; n < 8; n++) send({ cmd: "live.note", on: true, note: 48 + n, velocity: 90, id: 10 + n })
    await sleep(250)
    expect(last(heads).voices).toBe(8)
    expect(last(heads).held).toBe(8)
    send({ cmd: "live.note", on: true, note: 72, velocity: 90, id: 30 })
    await sleep(150)
    expect(last(heads).voices).toBe(8)
    expect(last(heads).held).toBe(8)
    send({ cmd: "live.voices", voices: 1, id: 31 })
    send({ cmd: "live.cc", cc: 123, value: 0, id: 32 })
    await sleep(150)
    expect(last(heads).held).toBe(0)
    send({ cmd: "live.cc", cc: 7, value: 5, id: 33 }) // not a command the page filters: it reaches the shim, which ignores it
    await sleep(60)
    expect(texts).toEqual([])
    ws.close()
  })

  test("the relay refuses nothing a MIDI page sends and still refuses unknown commands", async () => {
    const ws = new WebSocket(srv.url.replace("http", "ws") + "/api/live")
    const texts: string[] = []
    ws.onmessage = (e) => { if (typeof e.data === "string") texts.push(e.data) }
    await new Promise<void>((res) => (ws.onopen = () => res()))
    ws.send(JSON.stringify({ cmd: "live.open", engine: "CHIP" }))
    ws.send(JSON.stringify({ cmd: "live.cc", cc: 1, value: 3 }))
    ws.send(JSON.stringify({ cmd: "live.midi", x: 1 }))
    await sleep(100)
    expect(texts.length).toBe(1)
    expect(texts[0]).toContain("bad live command")
    ws.close()
  })
})
