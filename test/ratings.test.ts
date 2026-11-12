// Star ratings: ratings.json next to the patches of an engine folder, GET /api/ratings and PUT /api/ratings (server/ratings.ts).
// The .patch files are never touched, a bad sidecar reads as all unrated, a read-only folder shows its ratings but takes none.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startServer } from "../server/index"
import { parseRatings } from "../server/ratings"

let srv: Awaited<ReturnType<typeof startServer>>, rel: Awaited<ReturnType<typeof startServer>>
let dir: string, init: unknown
const send = (s: { url: string }, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(s.url + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
const get = async (d: string, engine = "ACD", s = srv) => (await send(s, "GET", `/api/ratings?engine=${engine}&dir=${encodeURIComponent(d)}`)).json()
const put = (d: string, name: string, stars: unknown, engine = "ACD", s = srv) => send(s, "PUT", "/api/ratings", { engine, dir: d, name, stars })
const save = async (d: string, name: string, engine = "ACD") => {
  const m = engine === "ACD" ? init : await (await fetch(srv.url + `/api/meta/${engine}`)).json().then((x: any) => x.init)
  expect((await send(srv, "POST", "/api/save", { dir: d, name, patch: m })).status).toBe(200)
}
const sidecar = (d: string, engine = "ACD") => join(d, engine, "ratings.json")
const mkdir = () => mkdtempSync(join(tmpdir(), "poly-editor-stars-"))
const dirs: string[] = []
const fresh = () => { const d = mkdir(); dirs.push(d); return d }

beforeAll(async () => {
  dir = fresh()
  srv = await startServer({ port: 0, dir })
  rel = await startServer({ port: 0, dir, release: true })
  init = (await (await fetch(srv.url + "/api/meta/ACD")).json()).init
}, 300_000)
afterAll(() => {
  srv?.stop(); rel?.stop()
  for (const d of dirs) { try { chmodSync(join(d, "ACD"), 0o755) } catch {} rmSync(d, { recursive: true, force: true }) }
})

describe("ratings sidecar", () => {
  test("a folder without ratings.json is all unrated and stays without one", async () => {
    const d = fresh()
    await save(d, "Acid Glide")
    expect(await get(d)).toEqual({ ratings: {}, readOnly: false })
    expect(existsSync(sidecar(d))).toBe(false)
    expect((await put(d, "Acid Glide", 0)).status).toBe(200) // clearing what was never rated writes nothing
    expect(existsSync(sidecar(d))).toBe(false)
  })

  test("create, update and clear: one file in the patch folder, keyed by the patch file name", async () => {
    const d = fresh()
    await save(d, "Acid Glide"); await save(d, "Bass One")
    const before = readFileSync(join(d, "ACD", "Acid Glide.patch"))
    let r = await put(d, "Acid Glide", 4)
    expect(r.status).toBe(200)
    expect((await r.json()).ratings).toEqual({ "Acid Glide": 4 })
    expect(JSON.parse(readFileSync(sidecar(d), "utf8"))).toEqual({ version: 1, ratings: { "Acid Glide.patch": 4 } })
    r = await put(d, "Bass One", 2)
    expect((await r.json()).ratings).toEqual({ "Acid Glide": 4, "Bass One": 2 })
    await put(d, "Acid Glide", 5) // update
    expect((await get(d)).ratings).toEqual({ "Acid Glide": 5, "Bass One": 2 })
    await put(d, "Acid Glide", 0) // clear
    expect((await get(d)).ratings).toEqual({ "Bass One": 2 })
    expect(JSON.parse(readFileSync(sidecar(d), "utf8")).ratings).toEqual({ "Bass One.patch": 2 })
    // the device files are untouched and the sidecar is not taken for a patch
    expect(readFileSync(join(d, "ACD", "Acid Glide.patch")).equals(before)).toBe(true)
    const list = await (await fetch(`${srv.url}/api/patches?engine=ACD&dir=${encodeURIComponent(d)}`)).json()
    expect(list.names).toEqual(["Acid Glide", "Bass One"])
    // no temp file is left behind
    expect(readdirSync(join(d, "ACD")).sort()).toEqual(["Acid Glide.patch", "Bass One.patch", "ratings.json"])
  })

  test("the folders of the engines are separate, and a folder that is the engine folder itself works", async () => {
    const d = fresh()
    await save(d, "Same", "ACD"); await save(d, "Same", "FAT")
    await put(d, "Same", 3, "ACD")
    expect((await get(d, "FAT")).ratings).toEqual({})
    expect((await get(join(d, "ACD"), "ACD")).ratings).toEqual({ Same: 3 })
    expect(existsSync(sidecar(d, "FAT"))).toBe(false)
  })

  test("a malformed ratings.json reads as all unrated and never blocks listing or loading", async () => {
    for (const bad of ["", "not json {", "[]", "null", '{"version":2,"ratings":{"A.patch":3}}', '{"version":1,"ratings":[1,2]}', '{"version":1}']) {
      const d = fresh()
      await save(d, "A")
      writeFileSync(sidecar(d), bad)
      const r = await send(srv, "GET", `/api/ratings?engine=ACD&dir=${encodeURIComponent(d)}`)
      expect(r.status).toBe(200)
      expect((await r.json()).ratings).toEqual({})
      expect((await send(srv, "POST", "/api/load", { dir: d, engine: "ACD", name: "A" })).status).toBe(200)
      // the next rating starts a good file
      expect((await put(d, "A", 3)).status).toBe(200)
      expect(JSON.parse(readFileSync(sidecar(d), "utf8"))).toEqual({ version: 1, ratings: { "A.patch": 3 } })
    }
    // single bad entries are dropped, the good ones stay
    expect(parseRatings('{"version":1,"ratings":{"A.patch":3,"B.patch":9,"C.patch":2.5,"D.patch":"4","E":4,"F.patch":0}}')).toEqual({ "A.patch": 3 })
  })

  test("a rating for a patch that is not there is refused, and entries of deleted patches go on the next write only", async () => {
    const d = fresh()
    await save(d, "Keep"); await save(d, "Gone")
    await put(d, "Keep", 5); await put(d, "Gone", 1)
    expect((await put(d, "Missing", 3)).status).toBe(404)
    expect(existsSync(join(d, "ACD", "Missing.patch"))).toBe(false)
    rmSync(join(d, "ACD", "Gone.patch"))
    // the read hides it, the file still has it
    expect((await get(d)).ratings).toEqual({ Keep: 5 })
    expect(JSON.parse(readFileSync(sidecar(d), "utf8")).ratings).toEqual({ "Gone.patch": 1, "Keep.patch": 5 })
    await put(d, "Keep", 4) // the next write drops it
    expect(JSON.parse(readFileSync(sidecar(d), "utf8")).ratings).toEqual({ "Keep.patch": 4 })
  })

  test("saving under a new name copies nothing, saving over a name keeps its stars", async () => {
    const d = fresh()
    await save(d, "Lead")
    await put(d, "Lead", 4)
    await save(d, "Lead 2")
    expect((await get(d)).ratings).toEqual({ Lead: 4 })
    expect((await send(srv, "POST", "/api/save", { dir: d, name: "Lead", patch: init, overwrite: true })).status).toBe(200)
    expect((await get(d)).ratings).toEqual({ Lead: 4 })
  })

  test("bad input: stars out of range, path tricks, no folder, wrong type, foreign hosts", async () => {
    const d = fresh()
    await save(d, "A")
    for (const stars of [6, -1, 2.5, "3", null, undefined]) expect((await put(d, "A", stars)).status).toBe(400)
    for (const name of ["../evil", "a/b", ".hidden", ""]) expect((await put(d, name, 3)).status).toBe(400)
    expect((await send(srv, "PUT", "/api/ratings", { engine: "NOPE", dir: d, name: "A", stars: 3 })).status).toBe(400)
    expect((await send(srv, "GET", "/api/ratings?engine=NOPE")).status).toBe(400)
    expect((await fetch(srv.url + "/api/ratings", { method: "PUT", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415)
    expect((await send(srv, "PUT", "/api/ratings", { engine: "ACD", dir: d, name: "A", stars: 3 }, { origin: "http://evil.example" })).status).toBe(403)
    expect((await send(srv, "PUT", "/api/ratings", { engine: "ACD", dir: d, name: "A", stars: 3 }, { host: "evil.example" })).status).toBe(403)
    expect(existsSync(sidecar(d))).toBe(false)
  })

  test("the folder falls back to the server's own, and an unset one has no ratings", async () => {
    await save(dir, "Home")
    expect((await send(srv, "PUT", "/api/ratings", { engine: "ACD", name: "Home", stars: 2 })).status).toBe(200)
    expect((await (await send(srv, "GET", "/api/ratings?engine=ACD")).json()).ratings).toEqual({ Home: 2 })
    const none = await startServer({ port: 0, dir: "" })
    try {
      expect(await (await send(none, "GET", "/api/ratings?engine=ACD")).json()).toEqual({ ratings: {}, readOnly: true })
      expect((await send(none, "PUT", "/api/ratings", { engine: "ACD", name: "Home", stars: 2 })).status).toBe(400)
    } finally { none.stop() }
  })

  test("a read-only folder shows its ratings and takes none", async () => {
    const d = fresh()
    await save(d, "Card")
    await put(d, "Card", 3)
    const was = readFileSync(sidecar(d), "utf8")
    chmodSync(join(d, "ACD"), 0o555)
    try {
      if (process.getuid?.() === 0) return // root writes anywhere, the check cannot be shown
      const g = await get(d)
      expect(g).toEqual({ ratings: { Card: 3 }, readOnly: true })
      const r = await put(d, "Card", 5)
      expect(r.status).toBe(403)
      expect((await r.json()).error).toContain("read-only")
      expect(readFileSync(sidecar(d), "utf8")).toBe(was)
      expect(readdirSync(join(d, "ACD")).sort()).toEqual(["Card.patch", "ratings.json"]) // no temp file either
      // a read-only folder with no sidecar at all is simply unrated
      const e = fresh()
      await save(e, "Plain")
      chmodSync(join(e, "ACD"), 0o555)
      expect(await get(e)).toEqual({ ratings: {}, readOnly: true })
    } finally { chmodSync(join(d, "ACD"), 0o755) }
  })

  test("a folder that does not exist is empty and read-only", async () => {
    const d = join(fresh(), "nowhere")
    expect(await get(d)).toEqual({ ratings: {}, readOnly: true })
    expect((await put(d, "A", 1)).status).toBe(404)
    expect(existsSync(d)).toBe(false)
  })

  test("two quick ratings in a row both land", async () => {
    const d = fresh()
    for (const n of ["A", "B", "C", "D"]) await save(d, n)
    await Promise.all(["A", "B", "C", "D"].map((n, i) => put(d, n, i + 1)))
    expect((await get(d)).ratings).toEqual({ A: 1, B: 2, C: 3, D: 4 })
  })

  test("release mode serves and stores ratings the same way", async () => {
    const d = fresh()
    await save(d, "Rel")
    expect((await put(d, "Rel", 5, "ACD", rel)).status).toBe(200)
    expect((await get(d, "ACD", rel)).ratings).toEqual({ Rel: 5 })
    expect(statSync(sidecar(d)).isFile()).toBe(true)
  })
})
