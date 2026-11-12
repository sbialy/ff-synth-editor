// Release mode (POLY_RELEASE=1, option `release`): the published variant. Strict is on for good and the page has no box for it, only the
// engines of the firmware release image exist, and a client cannot turn either back on. Dev mode (the default) keeps the Strict box and
// every engine. The page side is in test/page.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startServer } from "../server/index"
import { FIRMWARE_ENGINES, HIDDEN_ENGINES } from "../server/engines"
import { havePrivate, testPrivate } from "./helpers"

let dev: Awaited<ReturnType<typeof startServer>>, rel: Awaited<ReturnType<typeof startServer>>
let dir: string
const post = (s: { url: string }, path: string, body: unknown) => fetch(s.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "poly-editor-rel-"))
  dev = await startServer({ port: 0, dir })
  rel = await startServer({ port: 0, dir, release: true })
}, 300_000)
afterAll(() => {
  dev?.stop(); rel?.stop()
  rmSync(dir, { recursive: true, force: true })
})

const wanted = FIRMWARE_ENGINES.filter((e) => !HIDDEN_ENGINES.includes(e) && (!["PHZ", "PLK"].includes(e) || havePrivate(e)))

describe("release mode", () => {
  test("dev is the default, release only comes from the option or POLY_RELEASE=1", async () => {
    expect(dev.release).toBe(false)
    expect(rel.release).toBe(true)
    expect((await (await fetch(dev.url + "/api/engines")).json()).release).toBe(false)
    expect((await (await fetch(rel.url + "/api/engines")).json()).release).toBe(true)
    // nothing a visitor sends flips it
    for (const q of ["?release=1", "?strict=0", "?dev=1"]) expect((await (await fetch(rel.url + "/api/engines" + q, { headers: { "x-release": "0" } })).json()).release).toBe(true)
    expect(await (await fetch(rel.url + "/?dev=1")).text()).not.toContain('id="strict"')
  })

  test("the page has no Strict box in release mode and keeps it in dev mode", async () => {
    const d = await (await fetch(dev.url + "/")).text(), r = await (await fetch(rel.url + "/")).text()
    expect(d).toContain('id="strict"')
    expect(r).not.toMatch(/strict/i)
    expect(r).toContain("<title>FF SYNTH EDITOR</title>")
    expect(r).toContain('id="fwbadge"')
  })

  test("closed engines are marked: exactly the private module engines of modules.lock.json (PHZ, PLK), in dev and release", async () => {
    const lock = JSON.parse(readFileSync(join(import.meta.dir, "../modules.lock.json"), "utf8"))
    const files = (set: string) => Object.keys(lock.sets[set].files).filter((f) => f.endsWith(".wasm"))
    // the private engine set of the lock is the pluck and phz modules, the public one holds every other engine
    expect(lock.sets.engines.visibility).toBe("private")
    expect(files("engines").sort()).toEqual(["phz.wasm", "pluck.wasm"])
    for (const s of ["engines-os", "effects-os"]) expect(files(s)).not.toContain("phz.wasm")
    for (const s of [dev, rel]) {
      const e = await (await fetch(s.url + "/api/engines")).json()
      const closed = e.engines.filter((x: any) => x.closed).map((x: any) => x.name).sort()
      expect(closed).toEqual(["PHZ", "PLK"].filter((n) => havePrivate(n)))
      for (const x of e.engines) expect(x.closed).toBe(["PHZ", "PLK"].includes(x.name))
    }
  })

  test("the engines of the firmware release image are listed (all 18 of tracker-ff 1.2.0, Hand-Type and Pluck included), nothing names an experimental ref", async () => {
    const e = await (await fetch(rel.url + "/api/engines")).json()
    expect(e.engines.map((x: any) => x.name).sort()).toEqual([...wanted].sort())
    expect(e.engines.every((x: any) => x.onTracker && !x.experimental)).toBe(true)
    expect(e.engines.some((x: any) => x.group === "experimental")).toBe(false)
    expect(JSON.stringify(e)).not.toMatch(/experimental|pluck@|0d65211/)
    expect(e.engines.map((x: any) => x.name)).toContain("HANDTYPE")
    if (havePrivate("PLK", "PHZ")) expect(wanted.length).toBe(18)
    const dv = await (await fetch(dev.url + "/api/engines")).json()
    expect(dv.engines.map((x: any) => x.name).sort()).toEqual([...wanted].sort()) // dev mode has no engine the release lacks
  })

  testPrivate("PLK")("release mode serves Pluck and Hand-Type, and refuses an engine that is in no release everywhere", async () => {
    for (const s of [rel, dev]) {
      expect((await fetch(s.url + "/api/meta/PLK")).status).toBe(200)
      expect((await fetch(s.url + "/api/meta/HANDTYPE")).status).toBe(200)
    }
    const m = await (await fetch(rel.url + "/api/meta/PLK")).json()
    expect((await post(rel, "/api/render", { engine: "PLK", patch: m.init, note: 60, velocity: 100, seconds: 0.2 })).status).toBe(200)
    // ids that are no engines of this editor are refused
    for (const x of ["NOSUCH", "UNSHIPPED", "XYZ"]) {
      expect((await fetch(rel.url + "/api/meta/" + x)).status).toBe(400)
      expect((await post(rel, "/api/load", { engine: x, name: "x" })).status).toBe(400)
      expect((await fetch(rel.url + "/api/patches?engine=" + x + "&dir=" + encodeURIComponent(dir))).status).toBe(400)
    }
    expect((await fetch(rel.url + "/api/meta/ACD")).status).toBe(200)
  })

  testPrivate("PLK")("a file of another engine, found in an offered folder, is refused with the host's error and the server keeps working", async () => {
    // a Pluck patch saved by the dev server and then dropped into the ACD folder
    const m = await (await fetch(dev.url + "/api/meta/PLK")).json()
    expect((await post(dev, "/api/save", { dir, name: "pluckish", patch: m.init })).status).toBe(200)
    mkdirSync(join(dir, "ACD"), { recursive: true })
    copyFileSync(join(dir, "PLK", "pluckish.patch"), join(dir, "ACD", "pluckish.patch"))
    writeFileSync(join(dir, "ACD", "garbage.patch"), "not a patch")
    for (const name of ["pluckish", "garbage"]) {
      const r = await post(rel, "/api/load", { engine: "ACD", dir, name })
      expect(r.status).toBe(422)
      const body = await r.json()
      expect(body.ok).toBe(false)
    }
    expect((await fetch(rel.url + "/api/engines")).status).toBe(200)
  })

  test("release always renders and streams as Strict, whatever the client says", async () => {
    const m = await (await fetch(dev.url + "/api/meta/ACD")).json()
    const req = { engine: "ACD", patch: m.init, note: 60, velocity: 100, seconds: 0.3, hold: 0.2, voices: 8 }
    const a = Buffer.from(await (await post(rel, "/api/render", req)).arrayBuffer())
    const b = Buffer.from(await (await post(rel, "/api/render", { ...req, strict: false })).arrayBuffer())
    const c = Buffer.from(await (await post(dev, "/api/render", { ...req, strict: true })).arrayBuffer())
    expect(a.equals(b)).toBe(true)
    expect(a.equals(c)).toBe(true)

    // live: six keys with 8 voices asked and strict:false sent. Release holds it to the firmware cap (4), dev mode plays all 6
    const heldMax = async (s: { url: string }) => {
      const ws = new WebSocket(s.url.replace("http", "ws") + "/api/live")
      ws.binaryType = "arraybuffer"
      let max = 0
      ws.onmessage = (e) => { if (typeof e.data !== "string") max = Math.max(max, new DataView(e.data).getUint32(20, true)) }
      await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws")) })
      ws.send(JSON.stringify({ cmd: "live.open", engine: "ACD", patch: m.init, voices: 8, strict: false }))
      await Bun.sleep(300)
      ws.send(JSON.stringify({ cmd: "live.voices", voices: 8, strict: false }))
      for (const n of [48, 50, 52, 53, 55, 57]) { ws.send(JSON.stringify({ cmd: "live.note", on: true, note: n, velocity: 100 })); await Bun.sleep(40) }
      await Bun.sleep(500)
      ws.close()
      return max
    }
    expect(await heldMax(rel)).toBe(4)
    expect(await heldMax(dev)).toBe(6)
  }, 60_000)
})
