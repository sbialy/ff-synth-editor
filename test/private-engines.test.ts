// PHZ and PLK are private: the native host is built without them and the server answers for them from the wasm host with their runtime modules
// loaded (server/host.ts, server/wasm-host.ts, server/live.ts). What this checks:
//  - a build without the modules offers neither engine and says why when asked
//  - with the modules: the merged engine list keeps the firmware order, render / describe / load / save / live go through the wasm host
//  - the live session switches between the native stream and the wasm stream with the engine of each live.open, and paces at the block rate
//  - the runtime modules render bit identical to the same engines linked into the wasm host (dev only reference: needs the private source and emscripten)
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { missingPrivateSource, buildWasm, outDir, EMSDK } from "../scripts/build-wasm"
import { startServer } from "../server/index"
import { FRAME_BYTES } from "../server/live"
import { WasmHost } from "../server/wasm-host"
import { HostClient, HostError } from "../server/host"
import { ensureBuilt, havePrivate, newHost, testPrivate } from "./helpers"

let host: HostClient
let tmp: string
beforeAll(async () => {
  host = await newHost()
  await host.ready
  tmp = mkdtempSync(join(tmpdir(), "poly-editor-priv-"))
}, 300_000)
afterAll(() => {
  host?.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe("without the runtime modules", () => {
  test.skipIf(havePrivate("PHZ", "PLK"))("neither engine is offered and a request says its module is not installed", async () => {
    const e = await host.request({ cmd: "engines" })
    const names = e.engines.map((x: any) => x.name)
    for (const n of ["PHZ", "PLK"]) if (!havePrivate(n)) expect(names).not.toContain(n)
    if (!havePrivate("PHZ")) await expect(host.request({ cmd: "meta", engine: "PHZ" })).rejects.toBeInstanceOf(HostError)
    if (!havePrivate("PHZ")) await expect(host.request({ cmd: "meta", engine: "PHZ" })).rejects.toThrow(/not available in this build/)
  })
})

describe("with the runtime modules", () => {
  testPrivate("PHZ", "PLK")("the merged engine list is the firmware's: ... CHIP PHZ PLK then the OpenTracker 3.x engines", async () => {
    const e = await host.request({ cmd: "engines" })
    expect(e.engines.map((x: any) => x.name)).toEqual(["ACD", "FAT", "VAP", "WTFM", "PERC", "CHIP", "PHZ", "PLK", "FM4", "JU6", "DTYPE", "CSTYPE", "ATYPE", "TTYPE", "8TYPE", "HANDTYPE", "BTYPE", "ARCTYPE"])
    const raw = await host.request({ cmd: "firmware" })
    expect(raw.engines.map((x: any) => x.name).sort()).toEqual(e.engines.map((x: any) => x.name).sort()) // (the raw tables are in engine_list.h order)
  })

  testPrivate("PHZ", "PLK")("render, describe, knob, save and load of PHZ and PLK, through real files", async () => {
    for (const engine of ["PHZ", "PLK"]) {
      const m = await host.request({ cmd: "meta", engine })
      const out = join(tmp, `${engine}.wav`)
      const r = await host.request({ cmd: "render", engine, patch: m.init, note: 60, velocity: 100, seconds: 0.5, hold: 0.3, out })
      expect(r.nonSilent).toBe(true)
      expect(r.out).toBe(out)
      expect(readFileSync(out).subarray(0, 4).toString()).toBe("RIFF")
      const d = await host.request({ cmd: "describe", engine, patch: m.init })
      expect(d.texts.length).toBe(m.params.length)
      const path = join(tmp, engine, "x.patch")
      const s = await host.request({ cmd: "save", path, patch: m.init })
      expect(s.path).toBe(path)
      expect(existsSync(path)).toBe(true)
      const l = await host.request({ cmd: "load", path, engine })
      expect(l.patch.engine).toBe(engine)
      expect(l.patch.values).toEqual(m.init.values)
      const rt = await host.request({ cmd: "roundtrip", path })
      expect(rt).toMatchObject({ loaded: true, identical: true, engine })
      // a missing file is an ok:false answer, not a crash
      expect((await host.tryRequest({ cmd: "load", path: join(tmp, "nope.patch"), engine })).ok).toBe(false)
    }
  })

  describe("the live session", () => {
    let srv: Awaited<ReturnType<typeof startServer>>
    beforeAll(async () => {
      await ensureBuilt()
      srv = await startServer({ port: 0, dir: tmp })
    }, 300_000)
    afterAll(() => srv?.stop())
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

    async function connect() {
      const ws = new WebSocket(srv.url.replace("http", "ws") + "/api/live")
      ws.binaryType = "arraybuffer"
      const got: { t: number; seq: number; cmdId: number; rms: number }[] = []
      ws.onmessage = (e) => {
        if (typeof e.data === "string") return
        const dv = new DataView(e.data as ArrayBuffer)
        expect((e.data as ArrayBuffer).byteLength).toBe(FRAME_BYTES)
        const pcm = new Float32Array((e.data as ArrayBuffer).slice(24))
        got.push({ t: performance.now(), seq: dv.getUint32(4, true), cmdId: dv.getUint32(8, true), rms: Math.sqrt(pcm.reduce((a, x) => a + x * x, 0) / pcm.length) })
      }
      await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")) })
      return { ws, got, send: (o: object) => ws.send(JSON.stringify(o)) }
    }

    testPrivate("PHZ")("native -> wasm -> native: each live.open picks the backend of its engine, frames keep coming at the block rate with the last command id", async () => {
      const c = await connect()
      c.send({ cmd: "live.open", engine: "ACD", id: 1 })
      c.send({ cmd: "live.note", on: true, note: 57, velocity: 100, id: 2 })
      await sleep(300)
      expect(c.got.some((g) => g.cmdId >= 2 && g.rms > 0.001)).toBe(true)
      // PHZ: the wasm stream
      const n0 = c.got.length
      c.send({ cmd: "live.open", engine: "PHZ", voices: 2, id: 3 })
      c.send({ cmd: "live.note", on: true, note: 57, velocity: 100, id: 4 })
      await sleep(600)
      const phz = c.got.slice(n0).filter((g) => g.cmdId >= 4)
      expect(phz.length).toBeGreaterThan(100)
      expect(phz.some((g) => g.rms > 0.001)).toBe(true)
      const span = (phz[phz.length - 1].t - phz[0].t) / 1000
      const rate = (phz.length - 1) / span
      expect(rate).toBeGreaterThan(250) // 344.5 blocks per second, the wasm stream is paced by a timer
      expect(rate).toBeLessThan(420)
      for (let i = 1; i < phz.length; i++) expect(phz[i].seq).toBe(phz[i - 1].seq + 1)
      // a knob on the wasm stream is heard, and the next engine moves back to the native stream
      c.send({ cmd: "live.param", param: 18, value: 0, id: 5 })
      await sleep(200)
      expect(c.got.filter((g) => g.cmdId >= 5).slice(-20).every((g) => g.rms < 0.0005)).toBe(true)
      const n1 = c.got.length
      c.send({ cmd: "live.open", engine: "FAT", id: 6 })
      c.send({ cmd: "live.note", on: true, note: 57, velocity: 100, id: 7 })
      await sleep(400)
      expect(c.got.slice(n1).filter((g) => g.cmdId >= 7).some((g) => g.rms > 0.001)).toBe(true)
      c.ws.close()
      await sleep(300)
      expect(srv.liveRunning).toBe(false)
    }, 20_000)
  })
})

// dev only: the same engines linked into the wasm host, compiled from the unpublished source (POLY_PRIVATE_SOURCE=1 scripts/vendor.sh)
const haveLinked = havePrivate("PHZ", "PLK") && missingPrivateSource().length === 0 && existsSync(join(EMSDK, "upstream/emscripten/em++"))
describe("against the linked reference", () => {
  test.skipIf(!haveLinked)("PHZ and PLK as runtime modules render and stream bit identical to the same engines linked in", async () => {
    await buildWasm("linked")
    const linked = await (await import(join(outDir("linked"), "poly.mjs"))).default()
    const ask = (o: object) => JSON.parse(linked.UTF8ToString(linked.ccall("ph_request", "number", ["string"], [JSON.stringify(o)])))
    let seed = 7
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
    let compared = 0
    for (const engine of ["PHZ", "PLK"]) {
      const m = await host.request({ cmd: "meta", engine })
      expect(JSON.stringify(ask({ cmd: "meta", engine }))).toBe(JSON.stringify(m)) // the module's metadata is the linked engine's
      for (let k = 0; k < 8; k++) {
        const values = m.init.values.map((v: number | null, i: number) => (v === null ? v : k === 0 ? m.params[i].min : k === 1 ? m.params[i].max : m.params[i].min + rnd() * (m.params[i].max - m.params[i].min)))
        const req = { cmd: "render", engine, patch: { ...m.init, values }, note: 48 + 7 * (k % 3), velocity: 100, seconds: 0.6, hold: 0.4, voices: 2 }
        await host.request({ ...req, out: join(tmp, "r.wav") })
        ask({ ...req, out: "/l.wav" })
        expect(Buffer.from(linked.FS.readFile("/l.wav")).equals(readFileSync(join(tmp, "r.wav")))).toBe(true)
        compared++
      }
    }
    expect(compared).toBe(16)
    // a fresh module host streams the same blocks as a fresh linked host
    const w = await WasmHost.open()
    expect(w?.engines).toEqual(["PHZ", "PLK"])
  }, 600_000)
})
