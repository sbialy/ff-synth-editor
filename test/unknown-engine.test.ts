// A .patch whose engine id no engine of this editor has (a plugin engine id, 0x80 to 0x3FFF, that is not installed here). From tracker-ff 1.2.0 on the
// firmware's codec maps such an id to its "Missing" placeholder (kMissingTypeId, no parameters) so that a project keeps the values of a plugin that is not
// on the card. The editor has no card: it refuses the file with a clear error instead of opening an empty "Missing" engine. PHZ and PLK, which the native
// host has not got either, still load through their runtime modules.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startServer } from "../server/index"
import { HostError, type HostClient } from "../server/host"
import { havePrivate, newHost, testPrivate } from "./helpers"

const pluckFile = join(import.meta.dir, "fixtures/pluck/SG Bass A2.patch")
const NOT_AVAILABLE = "engine id 0x90 (144) is not available in this editor"
let host: HostClient
let dir: string
let dev: Awaited<ReturnType<typeof startServer>>, rel: Awaited<ReturnType<typeof startServer>>

/** The PLK fixture with its engine id (field 1, varint 0x8A 0x01) turned into 0x90: a plugin id no engine of tracker-ff 1.2.0 uses. */
function crafted(): Uint8Array {
  const b = new Uint8Array(readFileSync(pluckFile))
  expect([...b.subarray(0, 3)]).toEqual([0x08, 0x8a, 0x01])
  b[1] = 0x90
  return b
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "poly-editor-unknown-"))
  for (const e of ["PLK", "ACD"]) {
    mkdirSync(join(dir, e), { recursive: true })
    writeFileSync(join(dir, e, "Unknown 90.patch"), crafted())
  }
  writeFileSync(join(dir, "PLK", "SG Bass A2.patch"), readFileSync(pluckFile))
  host = await newHost()
  dev = await startServer({ port: 0, dir })
  rel = await startServer({ port: 0, dir, release: true })
}, 300_000)
afterAll(() => {
  host?.close()
  dev?.stop(); rel?.stop()
  rmSync(dir, { recursive: true, force: true })
})

const post = (s: { url: string }, path: string, body: unknown) => fetch(s.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

describe("a patch of an engine this editor has not got", () => {
  test("host load refuses it, with or without the engine named, never as a Missing engine", async () => {
    for (const engine of [undefined, ...(havePrivate("PLK") ? ["PLK"] : []), "ACD"]) { // PLK named only where its runtime module is installed
      const path = join(dir, engine === "ACD" ? "ACD" : "PLK", "Unknown 90.patch")
      const err = await host.request({ cmd: "load", path, ...(engine ? { engine } : {}) }).then((r) => ({ ok: true, r }), (e) => e)
      expect(err).toBeInstanceOf(HostError)
      expect((err as HostError).message).toBe(NOT_AVAILABLE)
    }
  })

  test("host roundtrip says not loaded with the same reason", async () => {
    const r = await host.request({ cmd: "roundtrip", path: join(dir, "PLK", "Unknown 90.patch") })
    expect(r).toMatchObject({ loaded: false, identical: false, engineId: 0x90, reason: NOT_AVAILABLE })
    expect(r.engine).toBeUndefined()
  })

  test("POST /api/load answers 422 with the error the page shows, in dev and in release mode", async () => {
    for (const s of [dev, rel])
      for (const engine of [...(havePrivate("PLK") ? ["PLK"] : []), "ACD"]) { // PLK is served only where its runtime module is installed
        const res = await post(s, "/api/load", { engine, name: "Unknown 90" })
        expect(res.status).toBe(422)
        const body = await res.json()
        expect(body.ok).toBe(false)
        expect(body.error).toMatch(/not available/)
        expect(JSON.stringify(body)).not.toContain("Missing")
      }
  })

  testPrivate("PLK")("PLK, which only its runtime module has, still loads from the same folder (the refusal does not catch the private engines)", async () => {
    const r = await host.request({ cmd: "load", path: join(dir, "PLK", "SG Bass A2.patch") })
    expect(r.patch.engine).toBe("PLK")
    expect(r.patch.values.length).toBeGreaterThan(9)
    const rt = await host.request({ cmd: "roundtrip", path: join(dir, "PLK", "SG Bass A2.patch") })
    expect(rt).toMatchObject({ loaded: true, engine: "PLK" })
    const res = await post(rel, "/api/load", { engine: "PLK", name: "SG Bass A2" })
    expect(res.status).toBe(200)
    expect((await res.json()).patch.engine).toBe("PLK")
  })

  testPrivate("PHZ")("PHZ (engine id 0x82) saves and loads back through its runtime module", async () => {
    const m = await host.request({ cmd: "meta", engine: "PHZ" })
    const path = join(dir, "PHZ-init.patch")
    await host.request({ cmd: "save", path, patch: m.init })
    expect([...readFileSync(path).subarray(0, 3)]).toEqual([0x08, 0x82, 0x01])
    const r = await host.request({ cmd: "load", path })
    expect(r.patch.engine).toBe("PHZ")
  })

})
