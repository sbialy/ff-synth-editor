// Streaming path: the host's --stream mode (deterministic, stepped by live.pull) and the WebSocket relay of the server (real time).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startServer } from "../server/index"
import { FRAME_BLOCK, FRAME_BYTES } from "../server/live"
import { POLYEND_AND_PLUCK, ensureBuilt, newHost, pull, rmsMany, rmsOf, stream } from "./helpers"
import type { HostClient } from "../server/host"

let host: HostClient
beforeAll(async () => {
  host = await newHost()
}, 300_000)
afterAll(() => host.close())

// PERC has no Volume parameter (the note velocity is its gain): its own test below
describe.each(POLYEND_AND_PLUCK.filter((e) => e !== "PERC"))("host --stream %s", (engine) => {
  test("a held note streams audio, a parameter change is heard while it holds, release dies away", async () => {
    const m = await host.request({ cmd: "meta", engine })
    const { frames, err } = await stream([
      { cmd: "live.open", engine, id: 1 },
      { cmd: "live.note", on: true, note: 57, velocity: 100, id: 2 },
      pull(60), // 174 ms held
      { cmd: "live.param", param: m.volumeParam, value: 0, id: 3 }, // the framework gain: every engine reacts to it
      pull(30),
      { cmd: "live.param", param: m.volumeParam, value: m.params[m.volumeParam].def, id: 4 },
      { cmd: "live.note", on: false, note: 57, id: 5 },
      pull(400), // 1.2 s: long enough for any release of the init patch
    ])
    expect(err).toBe("")
    expect(frames.length).toBe(490)
    expect(frames.every((f) => f.pcm.length === FRAME_BLOCK && f.pcm.every(Number.isFinite))).toBe(true)
    expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i))
    const held = rmsMany(frames.slice(10, 60))
    expect(held).toBeGreaterThan(0.005)
    // the volume change lands within the next block (cmdId 3 is stamped on it) and the sound is gone a block later
    expect(frames[60].cmdId).toBe(3)
    expect(rmsMany(frames.slice(62, 90))).toBeLessThan(held * 0.01)
    expect(rmsMany(frames.slice(-40))).toBeLessThan(held * 0.01)
  })
})

describe("host --stream: PERC", () => {
  test("a hit streams audio and dies away on its own, a Kick Level change (note 60 is the kick) is heard on the next hit", async () => {
    const m = await host.request({ cmd: "meta", engine: "PERC" })
    expect(m.volumeParam).toBe(-1)
    const kickLevel = m.params.findIndex((p: any) => p.name === "Kick Level")
    const { frames, err } = await stream([
      { cmd: "live.open", engine: "PERC", id: 1 },
      { cmd: "live.note", on: true, note: 60, velocity: 100, id: 2 },
      pull(120),
      { cmd: "live.note", on: false, note: 60, id: 3 },
      pull(300),
      { cmd: "live.param", param: kickLevel, value: 0, id: 4 },
      { cmd: "live.note", on: true, note: 60, velocity: 100, id: 5 },
      pull(120),
    ])
    expect(err).toBe("")
    expect(frames.every((f) => f.pcm.length === FRAME_BLOCK && f.pcm.every(Number.isFinite))).toBe(true)
    const hit = rmsMany(frames.slice(0, 60))
    expect(hit).toBeGreaterThan(0.005)
    expect(rmsMany(frames.slice(300, 420))).toBeLessThan(hit * 0.01) // the first hit has decayed
    expect(rmsMany(frames.slice(422, 540))).toBeLessThan(hit * 0.01) // Kick Level 0: the second hit is silent
  })
})

describe("host --stream: knobs", () => {
  test("CHIP: the Model parameter changes the waveform of a held note", async () => {
    const zcr = (fs: { pcm: Float32Array }[]) => {
      let z = 0, prev = 0
      for (const f of fs) for (const x of f.pcm) { if (prev <= 0 !== x <= 0) z++; prev = x }
      return z
    }
    const { frames } = await stream([
      { cmd: "live.open", engine: "CHIP" },
      { cmd: "live.note", on: true, note: 57, velocity: 100 },
      pull(80),
      { cmd: "live.param", param: 0, value: 2 }, // Noise / LFSR
      pull(80),
    ])
    const before = frames.slice(20, 80), after = frames.slice(100, 160)
    expect(rmsMany(before)).toBeGreaterThan(0.05)
    expect(rmsMany(after)).toBeGreaterThan(0.05)
    expect(zcr(after)).toBeGreaterThan(zcr(before) * 2)
  })

  test("ACD: turning the cutoff down takes the highs out of a held note", async () => {
    const m = await host.request({ cmd: "meta", engine: "ACD" })
    const cutoff = m.params.findIndex((p: any) => p.name === "Cutoff")
    const patch = structuredClone(m.init)
    patch.values[cutoff] = 12000
    patch.values[m.params.findIndex((p: any) => p.name === "Sustain")] = 1
    const { frames } = await stream([
      { cmd: "live.open", engine: "ACD", patch },
      { cmd: "live.note", on: true, note: 45, velocity: 100 },
      pull(120),
      { cmd: "live.param", param: cutoff, value: 120 },
      pull(120),
    ])
    const bright = rmsMany(frames.slice(60, 120)), dull = rmsMany(frames.slice(180, 240))
    expect(bright).toBeGreaterThan(0.01)
    expect(dull).toBeLessThan(bright * 0.8)
  })

  test("bad control lines are reported on stderr and do not stop the stream", async () => {
    const { frames, err } = await stream([{ cmd: "live.note", on: true, note: 60 }, { cmd: "live.open", engine: "NOPE" }, { cmd: "live.open", engine: "CHIP" }, pull(3)])
    expect(frames.length).toBe(3)
    expect(err).toContain("no live session")
    expect(err).toContain("unknown engine")
  })
})

describe("websocket relay", () => {
  let srv: Awaited<ReturnType<typeof startServer>>
  let dir: string
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "poly-editor-live-"))
    await ensureBuilt()
    srv = await startServer({ port: 0, dir })
  }, 300_000)
  afterAll(() => {
    srv.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  type Got = { t: number; seq: number; cmdId: number; rms: number; pcm: Float32Array }
  async function connect() {
    const ws = new WebSocket(srv.url.replace("http", "ws") + "/api/live")
    ws.binaryType = "arraybuffer"
    const got: Got[] = [], texts: string[] = []
    ws.onmessage = (e) => {
      if (typeof e.data === "string") return void texts.push(e.data)
      const buf = new Uint8Array(e.data as ArrayBuffer), dv = new DataView(e.data as ArrayBuffer)
      const pcm = new Float32Array((e.data as ArrayBuffer).slice(24))
      got.push({ t: performance.now(), seq: dv.getUint32(4, true), cmdId: dv.getUint32(8, true), rms: rmsOf(pcm), pcm })
      if (buf.length !== FRAME_BYTES) texts.push("bad frame size " + buf.length)
    }
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")) })
    return { ws, got, texts, send: (o: object) => ws.send(JSON.stringify(o)) }
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  test("streams a held CHIP note in real time, hears a knob move, measures latency", async () => {
    const c = await connect()
    c.send({ cmd: "live.open", engine: "CHIP", id: 1 })
    await sleep(300) // the stream is running, silent
    expect(c.got.length).toBeGreaterThan(50)
    expect(c.got.every((g) => g.rms === 0)).toBe(true)

    const tNote = performance.now()
    c.send({ cmd: "live.note", on: true, note: 57, velocity: 100, id: 2 })
    await sleep(500)
    const first = c.got.find((g) => g.cmdId >= 2 && g.rms > 0.001)
    expect(first).toBeDefined()
    const noteLatency = first!.t - tNote
    const held = c.got.filter((g) => g.t > tNote + 100)
    expect(held.length).toBeGreaterThan(100)
    expect(held.every((g) => g.pcm.every(Number.isFinite))).toBe(true)
    const heldRms = Math.sqrt(held.reduce((a, g) => a + g.rms * g.rms, 0) / held.length)
    expect(heldRms).toBeGreaterThan(0.05)

    // real time pacing: blocks per second of the host clock (344.5 expected)
    const span = (c.got[c.got.length - 1].t - c.got[0].t) / 1000
    const rate = (c.got.length - 1) / span
    expect(rate).toBeGreaterThan(300)
    expect(rate).toBeLessThan(390)
    // no block lost or repeated
    for (let i = 1; i < c.got.length; i++) expect(c.got[i].seq).toBe(c.got[i - 1].seq + 1)

    // a knob moved while the note holds: Volume to 0 is silent from the block stamped with that command
    const tKnob = performance.now()
    c.send({ cmd: "live.param", param: 24, value: 0, id: 3 })
    await sleep(300)
    const gone = c.got.find((g) => g.cmdId >= 3 && g.rms < 0.0005)
    expect(gone).toBeDefined()
    const knobLatency = gone!.t - tKnob
    // Model -> Noise at full volume again: the stream sounds different, not just quieter
    c.send({ cmd: "live.param", param: 24, value: 1, id: 4 })
    c.send({ cmd: "live.param", param: 0, value: 2, id: 5 })
    await sleep(300)
    const noisy = c.got.filter((g) => g.cmdId >= 5 && g.t > tKnob + 250)
    expect(noisy.length).toBeGreaterThan(20)
    expect(Math.sqrt(noisy.reduce((a, g) => a + g.rms * g.rms, 0) / noisy.length)).toBeGreaterThan(0.05)
    console.log(`live pipeline (page -> server -> host -> server -> page): note ${noteLatency.toFixed(1)} ms, knob ${knobLatency.toFixed(1)} ms, block rate ${rate.toFixed(1)}/s`)
    expect(noteLatency).toBeLessThan(30)
    expect(knobLatency).toBeLessThan(30)
    expect(c.texts).toEqual([])
    expect(srv.liveRunning).toBe(true)

    c.ws.close()
    await sleep(300)
    expect(srv.liveRunning).toBe(false) // the host stops with the last page
  }, 20_000)

  test("refuses unknown commands and engines, ignores binary", async () => {
    const c = await connect()
    c.send({ cmd: "live.pull", blocks: 1000 })
    c.send({ cmd: "render" })
    c.send({ cmd: "live.open", engine: "NOPE" })
    c.ws.send(new Uint8Array([1, 2, 3]))
    await sleep(200)
    expect(c.texts.length).toBe(3)
    expect(c.texts.every((t) => JSON.parse(t).ok === false)).toBe(true)
    c.ws.close()
    await sleep(200)
  })

  test("the page and the worklet are served, a plain GET of /api/live is refused", async () => {
    expect((await fetch(srv.url + "/worklet.js")).status).toBe(200)
    expect((await fetch(srv.url + "/api/live")).status).toBe(426)
    const bad = await fetch(srv.url + "/api/live", { headers: { Origin: "http://evil.example" } })
    expect(bad.status).toBe(403)
  })
})
