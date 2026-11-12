// The bundled default patches: the generator (scripts/defaults.ts), the manifest (public/defaults/index.json), the server routes and the static path.
// The static path is the GitHub Pages one: scripts/pages.ts output served as plain files, read through public/defaults.js with no API at all.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generate } from "../scripts/defaults"
import { buildPages } from "../scripts/pages"
import { DEFAULTS_DIR, defaultPatchPath, ratedAtLeast, readManifest } from "../server/defaults"
import { ENGINES, FIRMWARE_ENGINES } from "../server/engines"
import { startServer } from "../server/index"
import { defaultNames, defaultPatchUrl, fetchManifest } from "../public/defaults.js"

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex")
/** every file under a folder with its hash (a sorted list): equal before and after means nothing was touched */
const snapshot = (root: string) => readdirSync(root, { recursive: true }).map(String).filter((f) => statSync(join(root, f)).isFile()).map((f) => `${f}:${sha(join(root, f))}`).sort()
const tmp: string[] = []
const fresh = () => { const d = mkdtempSync(join(tmpdir(), "poly-editor-defaults-")); tmp.push(d); return d }
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }) })

describe("ratedAtLeast", () => {
  const side = JSON.stringify({ version: 1, ratings: { "A.patch": 5, "B.patch": 4, "C.patch": 3, "Gone.patch": 5, "bad.txt": 5, "D.patch": 0 } })
  test("keeps 4 stars and up whose file is there, sorted, without .patch", () => {
    expect(ratedAtLeast(side, ["B.patch", "A.patch", "C.patch"])).toEqual(["A", "B"])
    expect(ratedAtLeast(side, ["A.patch", "B.patch", "C.patch"], 5)).toEqual(["A"])
  })
  test("a bad sidecar gives nothing", () => {
    expect(ratedAtLeast("not json", ["A.patch"])).toEqual([])
    expect(ratedAtLeast('{"version":2,"ratings":{"A.patch":5}}', ["A.patch"])).toEqual([])
  })
})

describe("generate", () => {
  test("copies the 4+ star patches of the release engines, never touches the source, skips engines the release lacks", async () => {
    const src = fresh(), out = fresh()
    const put = (engine: string, files: Record<string, string>, ratings: Record<string, number>) => {
      mkdirSync(join(src, engine), { recursive: true })
      for (const [f, c] of Object.entries(files)) writeFileSync(join(src, engine, f), c)
      writeFileSync(join(src, engine, "ratings.json"), JSON.stringify({ version: 1, ratings }))
    }
    put("ACD", { "Hi.patch": "acd-hi", "Mid.patch": "acd-mid", "Five.patch": "acd-five" }, { "Hi.patch": 4, "Mid.patch": 3, "Five.patch": 5, "Missing.patch": 5 })
    put("PHZ", { "Phase.patch": "phz" }, { "Phase.patch": 4 })
    put("NOSUCHA", { "A.patch": "a" }, { "A.patch": 5 })
    put("NOSUCHB", { "B.patch": "b" }, { "B.patch": 5 })
    put("NOSUCHC", { "C.patch": "c" }, { "C.patch": 5 })
    const before = snapshot(src)
    const { manifest } = await generate([src], join(out, "defaults"))
    expect(manifest).toEqual({ version: 1, minStars: 4, engines: { ACD: ["Five", "Hi"], PHZ: ["Phase"] } })
    expect(readdirSync(join(out, "defaults")).sort()).toEqual(["ACD", "PHZ", "index.json"])
    expect(readFileSync(join(out, "defaults/ACD/Hi.patch"), "utf8")).toBe("acd-hi")
    expect(readdirSync(join(out, "defaults/ACD")).sort()).toEqual(["Five.patch", "Hi.patch"])
    expect(JSON.parse(readFileSync(join(out, "defaults/index.json"), "utf8"))).toEqual(manifest)
    const after = snapshot(src)
    expect(after).toEqual(before)
  })

  test("a re-run replaces the old set (a patch that lost its stars is gone)", async () => {
    const src = fresh(), out = join(fresh(), "defaults")
    mkdirSync(join(src, "FAT"))
    writeFileSync(join(src, "FAT/X.patch"), "x"); writeFileSync(join(src, "FAT/Y.patch"), "y")
    writeFileSync(join(src, "FAT/ratings.json"), JSON.stringify({ version: 1, ratings: { "X.patch": 5, "Y.patch": 4 } }))
    await generate([src], out)
    writeFileSync(join(src, "FAT/ratings.json"), JSON.stringify({ version: 1, ratings: { "X.patch": 5, "Y.patch": 2 } }))
    expect((await generate([src], out)).manifest.engines).toEqual({ FAT: ["X"] })
    expect(readdirSync(join(out, "FAT"))).toEqual(["X.patch"])
  })
})

describe("the bundled set in the repository", () => {
  const m = readManifest()
  test("the manifest lists only release engines, no unknown engines, and the set is not empty", () => {
    const names = Object.keys(m.engines)
    expect(names.length).toBeGreaterThan(0)
    for (const e of names) { expect(ENGINES).toContain(e); expect(FIRMWARE_ENGINES).toContain(e) }
    for (const e of ["NOSUCHA", "NOSUCHB", "NOSUCHC"]) expect(names).not.toContain(e)
    expect(m.minStars).toBe(4)
  })
  test("manifest and files agree both ways, names are one path component", () => {
    for (const [e, names] of Object.entries(m.engines)) {
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
      const files = readdirSync(join(DEFAULTS_DIR, e)).filter((f) => f.endsWith(".patch")).map((f) => f.slice(0, -6)).sort((a, b) => a.localeCompare(b))
      expect(files).toEqual(names)
      for (const n of names) { expect(n).not.toMatch(/[\/\\]|^\./); expect(defaultPatchPath(e, n)).not.toBeNull() }
    }
    expect(readdirSync(DEFAULTS_DIR).sort()).toEqual([...Object.keys(m.engines), "index.json"].sort())
  })
  test("defaultPatchPath resolves only what the manifest lists", () => {
    const [e] = Object.keys(m.engines)
    expect(defaultPatchPath(e, "../../index")).toBeNull()
    expect(defaultPatchPath(e, "Not In The Set")).toBeNull()
    expect(defaultPatchPath("NOSUCHA", m.engines[e][0])).toBeNull()
  })
})

describe("server routes", () => {
  let srv: Awaited<ReturnType<typeof startServer>>
  beforeAll(async () => { srv = await startServer({ port: 0, dir: "" }) }, 300_000)
  afterAll(() => srv?.stop())
  const m = readManifest()
  const [engine] = Object.keys(m.engines), name = m.engines[engine][0]

  test("the manifest and a listed patch are served as the files they are", async () => {
    const man = await fetch(srv.url + "/defaults/index.json")
    expect(await man.json()).toEqual(m)
    const p = await fetch(srv.url + "/" + defaultPatchUrl(engine, name))
    expect(p.status).toBe(200)
    expect(Buffer.from(await p.arrayBuffer()).equals(readFileSync(join(DEFAULTS_DIR, engine, name + ".patch")))).toBe(true)
  })
  test("anything the manifest does not list is a 404", async () => {
    for (const path of [`/defaults/${engine}/Nope.patch`, `/defaults/${engine}/${encodeURIComponent("../index")}.patch`, "/defaults/NOSUCH/x.patch", "/defaults/ACD", "/defaults/"])
      expect((await fetch(srv.url + path)).status).toBe(404)
  })
  test("a bundled patch loads with no folder set, a plain load with no folder still says so", async () => {
    const post = (b: object) => fetch(srv.url + "/api/load", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })
    const ok = await post({ engine, bundled: true, name })
    expect(ok.status).toBe(200)
    expect((await ok.json()).patch.engine).toBe(engine)
    expect((await post({ engine, bundled: true, name: "Nope" })).status).toBe(404)
    expect((await post({ engine, name })).status).toBe(400)
  })
})

describe("static build (the GitHub Pages path)", () => {
  let site: string, server: ReturnType<typeof Bun.serve>, base: string
  beforeAll(async () => {
    site = (await buildPages(join(fresh(), "pages"))).out
    // a bare static file server: no API of any kind, so a request outside the built files is a 404
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
      const p = decodeURIComponent(new URL(req.url).pathname)
      const f = Bun.file(join(site, p === "/" ? "index.html" : p))
      return p.includes("..") || !(await f.exists()) ? new Response("no", { status: 404 }) : new Response(f)
    } })
    base = `http://127.0.0.1:${server.port}/`
  })
  afterAll(() => server?.stop(true))

  test("the built site has the manifest and every bundled patch, byte for byte", () => {
    const m = readManifest()
    expect(JSON.parse(readFileSync(join(site, "defaults/index.json"), "utf8"))).toEqual(m)
    for (const [e, names] of Object.entries(m.engines)) for (const n of names) expect(sha(join(site, "defaults", e, n + ".patch"))).toBe(sha(join(DEFAULTS_DIR, e, n + ".patch")))
    expect(existsSync(join(site, ".nojekyll"))).toBe(true)
  })
  test("the manifest and a patch load from the built site with plain fetches, and the page's reader lists them", async () => {
    const m = readManifest()
    const man = await fetchManifest((u: string) => fetch(base + u), "defaults/")
    expect(man).toEqual(m)
    for (const [e, names] of Object.entries(m.engines)) {
      expect(defaultNames(man, e)).toEqual(names)
      const r = await fetch(base + defaultPatchUrl(e, names[0]))
      expect(r.status).toBe(200)
      expect(Buffer.from(await r.arrayBuffer()).equals(readFileSync(join(DEFAULTS_DIR, e, names[0] + ".patch")))).toBe(true)
    }
    expect((await fetch(base + "api/ratings?engine=ACD")).status).toBe(404) // there is no API here, and the default list needs none
  })
  test("a missing or broken manifest reads as an empty list, not an error", async () => {
    expect(await fetchManifest(async () => new Response("nope", { status: 404 }))).toBeNull()
    expect(await fetchManifest(async () => { throw new Error("offline") })).toBeNull()
    expect(defaultNames(null, "ACD")).toEqual([])
    expect(defaultNames({ version: 2, engines: { ACD: ["x"] } }, "ACD")).toEqual([])
  })
})
