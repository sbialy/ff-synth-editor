import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startServer } from "../server/index"
import { PHZ_ONLY, PLK_ONLY, available, havePrivate, parseWav, testPrivate } from "./helpers"

let srv: Awaited<ReturnType<typeof startServer>>
let dir: string
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(srv.url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "poly-editor-srv-"))
  srv = await startServer({ port: 0, dir })
}, 300_000)
afterAll(() => {
  srv.stop()
  rmSync(dir, { recursive: true, force: true })
})

test("serves the page and the script", async () => {
  const html = await (await fetch(srv.url + "/")).text()
  expect(html).toContain("<title>FF SYNTH EDITOR</title>")
  const js = await fetch(srv.url + "/app.js")
  expect(js.status).toBe(200)
  expect((await fetch(srv.url + "/../package.json")).status).toBe(404)
})

test("lists engines and metadata", async () => {
  const e = await (await fetch(srv.url + "/api/engines")).json()
  // tracker-ff 1.2.0: all 18 engines of the release image, Hand-Type and Pluck included
  expect(e.engines.map((x: any) => x.name)).toEqual(available(["ACD", "FAT", "VAP", "WTFM", "PERC", "CHIP", "PHZ", "PLK", "FM4", "JU6", "DTYPE", "CSTYPE", "ATYPE", "TTYPE", "8TYPE", "HANDTYPE", "BTYPE", "ARCTYPE"]))
  const m = await (await fetch(srv.url + "/api/meta/VAP")).json()
  expect(m.params.length).toBe(60)
  expect((await fetch(srv.url + "/api/meta/NOPE")).status).toBe(400)
})

test("save, list and load a patch in <folder>/<ENGINE>/", async () => {
  const m = await (await fetch(srv.url + "/api/meta/FAT")).json()
  const r = await post("/api/save", { dir, name: "Test One", patch: m.init })
  expect(r.status).toBe(200)
  expect(existsSync(join(dir, "FAT", "Test One.patch"))).toBe(true)
  expect((await post("/api/save", { dir, name: "Test One", patch: m.init })).status).toBe(409)
  expect((await post("/api/save", { dir, name: "Test One", patch: m.init, overwrite: true })).status).toBe(200)
  const list = await (await fetch(`${srv.url}/api/patches?engine=FAT&dir=${encodeURIComponent(dir)}`)).json()
  expect(list.names).toEqual(["Test One"])
  // a folder that already is the engine folder works too
  const list2 = await (await fetch(`${srv.url}/api/patches?engine=FAT&dir=${encodeURIComponent(join(dir, "FAT"))}`)).json()
  expect(list2.names).toEqual(["Test One"])
  const back = await (await post("/api/load", { dir, engine: "FAT", name: "Test One" })).json()
  expect(back.patch.values).toEqual(m.init.values)
  expect((await post("/api/load", { dir, engine: "ACD", name: "Test One" })).status).toBe(422)
})

test("refuses path tricks, foreign hosts and cross-origin posts", async () => {
  const m = await (await fetch(srv.url + "/api/meta/ACD")).json()
  for (const name of ["../evil", "a/b", ".hidden", ""]) expect((await post("/api/save", { dir, name, patch: m.init })).status).toBe(400)
  expect((await post("/api/save", { dir, name: "x", patch: m.init }, { origin: "http://evil.example" })).status).toBe(403)
  const bad = await fetch(srv.url + "/api/engines", { headers: { host: "evil.example" } })
  expect(bad.status).toBe(403)
  const noType = await fetch(srv.url + "/api/save", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })
  expect(noType.status).toBe(415)
})

test("POLY_ALLOWED_HOSTS: default refuses a foreign host, a listed host is accepted, Origin is still checked", async () => {
  const name = "mac.example.ts.net"
  expect((await fetch(srv.url + "/api/engines", { headers: { host: name } })).status).toBe(403)
  const opened = await startServer({ port: 0, dir, allowedHosts: [` ${name}:3210 `] })
  try {
    expect((await fetch(opened.url + "/api/engines", { headers: { host: name } })).status).toBe(200)
    expect((await fetch(opened.url + "/api/engines", { headers: { host: `${name}:3210` } })).status).toBe(200)
    expect((await fetch(opened.url + "/api/engines", { headers: { host: "evil.example" } })).status).toBe(403)
    // Origin must still equal the Host header
    expect((await fetch(opened.url + "/api/engines", { headers: { host: name, origin: "http://evil.example" } })).status).toBe(403)
    expect((await fetch(opened.url + "/api/engines", { headers: { host: name, origin: `http://${name}` } })).status).toBe(200)
  } finally {
    opened.stop()
  }
}, 300_000)

test("renders a note to a WAV over HTTP", async () => {
  const r = await post("/api/render", { engine: "WTFM", note: 60, velocity: 110, seconds: 1, hold: 0.5 })
  expect(r.status).toBe(200)
  expect(r.headers.get("content-type")).toBe("audio/wav")
  const wav = parseWav(new Uint8Array(await r.arrayBuffer()))
  expect(wav.rate).toBe(44100)
  expect(wav.samples.some((s) => Math.abs(s) > 0.01)).toBe(true)
  expect(wav.samples.every(Number.isFinite)).toBe(true)
})

test("/api/engines: every engine is on the Tracker (tracker-ff 1.2.0), Pluck in its own group, nothing experimental, groups, no flash figures", async () => {
  const e = await (await fetch(srv.url + "/api/engines")).json()
  expect(e.freeFlash).toBeUndefined()
  for (const x of e.engines) expect(x.budget).toBeUndefined()
  expect(e.engines.filter((x: any) => x.onTracker).map((x: any) => x.name)).toEqual(
    available(["ACD", "FAT", "VAP", "WTFM", "PERC", "CHIP", "PHZ", "PLK", "FM4", "JU6", "DTYPE", "CSTYPE", "ATYPE", "TTYPE", "8TYPE", "HANDTYPE", "BTYPE", "ARCTYPE"])) // the release image: all 18
  expect(e.engines.find((x: any) => x.name === "HANDTYPE")).toMatchObject({ display: "Hand-Type", group: "ot3", onTracker: true })
  if (havePrivate("PLK")) expect(e.engines.find((x: any) => x.name === "PLK")).toMatchObject({ display: "Pluck", group: "plk", onTracker: true, experimental: false, stored: 18, engineId: 0x8a, params: 11 })
  expect(e.engines.filter((x: any) => x.experimental).map((x: any) => x.name)).toEqual([])
  expect(e.engines.filter((x: any) => x.group === "plk").map((x: any) => x.name)).toEqual(PLK_ONLY)
  expect(e.engines.filter((x: any) => x.group === "phz").map((x: any) => x.name)).toEqual(PHZ_ONLY)
  expect(e.engines.filter((x: any) => x.group === "polyend").map((x: any) => x.name)).toEqual(["ACD", "FAT", "VAP", "WTFM", "PERC"])
  expect(e.engines.filter((x: any) => x.group === "polyend-oss").map((x: any) => x.name)).toEqual(["CHIP"])
  expect(e.firmware).toMatchObject({ tag: "tracker-ff-v1.2.0", version: "1.2.0", matches: "matches tracker-ff 1.2.0", notInRelease: [] })
  expect(e.firmware.experimental).toBeUndefined()
  expect(e.firmware.engines).toContain("PLK") // a release engine of the tag
  expect(e.firmware.releaseEngines).toEqual(e.firmware.engines)
})

test("Hand-Type (a release engine since tracker-ff 1.2.0): meta, save, load and render work", async () => {
  const m = await (await fetch(srv.url + "/api/meta/HANDTYPE")).json()
  expect(m.params.length).toBe(52)
  const saved = await post("/api/save", { dir, name: "Hand Keep", patch: m.init })
  expect(saved.status).toBe(200)
  const back = await post("/api/load", { dir, engine: "HANDTYPE", name: "Hand Keep" })
  expect(back.status).toBe(200)
  expect((await back.json()).patch.values).toEqual(m.init.values)
  const r = await post("/api/render", { engine: "HANDTYPE", patch: m.init, note: 57, velocity: 100, seconds: 1, hold: 0.5 })
  expect(r.status).toBe(200)
  // a Hand-Type file that ends up in another engine's folder is refused with a clear message, not loaded as that engine
  mkdirSync(join(dir, "ACD"), { recursive: true })
  copyFileSync(join(dir, "HANDTYPE", "Hand Keep.patch"), join(dir, "ACD", "Hand Keep.patch"))
  const wrong = await post("/api/load", { dir, engine: "ACD", name: "Hand Keep" })
  expect(wrong.status).toBeGreaterThanOrEqual(400)
  expect(JSON.stringify(await wrong.json())).toContain("file is a HANDTYPE patch, not ACD")
})

testPrivate("PHZ")("PHZ metadata over HTTP and many knob positions mapped at once", async () => {
  const m = await (await fetch(srv.url + "/api/meta/PHZ")).json()
  expect(m.params.length).toBe(62)
  const cut = m.params.findIndex((p: any) => p.name === "Cutoff")
  const r = await (await post("/api/knobs", { engine: "PHZ", items: [{ param: cut, knob: 0 }, { param: cut, knob: 0.5 }, { param: cut, knob: 1 }] })).json()
  expect(r.values[0]).toBeCloseTo(20, 3)
  expect(r.values[1]).toBeGreaterThan(20)
  expect(r.values[1]).toBeLessThan(20000)
  expect(r.values[2]).toBeCloseTo(20000, 1)
  expect((await post("/api/knobs", { engine: "PHZ", items: [{ param: 999, knob: 0 }] })).status).toBe(422)
  expect((await post("/api/knobs", { engine: "PHZ", items: "x" })).status).toBe(422)
})
