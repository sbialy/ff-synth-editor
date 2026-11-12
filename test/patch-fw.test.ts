// Patch files against the pinned firmware codec (vendor/poly/synth-open/open_patchio.cpp, the firmware's own code, byte for byte).
//   - every factory patch and every patch the editor saves loads through the firmware PatchStore, and what the editor writes (the PatchStore
//     path, host commands "save" and "encode") is exactly what the codec alone writes for the same model (host command "codec": the model's
//     PatchData straight through encodePatch), and writing it again changes nothing
//   - patches an older editor build saved with an editor-only engine id still load, mapped to the firmware's ids (CHIP 0x10, D-Type 0x82), and
//     the editor saves them with the firmware's ids from then on
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { factoryDir, haveFactory, havePrivate, newHost } from "./helpers"
import { SERVED_ENGINES as ENGINES } from "./helpers"
import type { HostClient } from "../server/host"

let host: HostClient
let tmp: string
beforeAll(async () => {
  host = await newHost()
  tmp = mkdtempSync(join(tmpdir(), "poly-editor-fw-"))
}, 300_000)
afterAll(() => {
  host.close()
  rmSync(tmp, { recursive: true, force: true })
})

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex")

describe("editor-saved patches are what the firmware codec writes", () => {
  test.each(ENGINES)("%s: save (PatchStore) = encode = the codec alone, and a reload writes the same bytes", async (engine) => {
    const m = await host.request({ cmd: "meta", engine })
    const patch = structuredClone(m.init)
    patch.values = m.params.map((p: any, i: number) => (p.stepped ? Math.round(p.min + ((i % 7) / 7) * (p.max - p.min)) : Math.fround(p.min + ((i % 5) / 5) * (p.max - p.min))))
    patch.macros[0].name = "Sync Macro"
    const path = join(tmp, engine, "saved.patch")
    await host.request({ cmd: "save", path, patch })
    const saved = readFileSync(path)
    const codec = await host.request({ cmd: "codec", engine, patch })
    expect(hex(saved)).toBe(codec.hex)
    expect((await host.request({ cmd: "encode", engine, patch })).hex).toBe(codec.hex)
    // load it back through the PatchStore and save again: the same bytes
    const back = (await host.request({ cmd: "load", path })).patch
    expect(back.engine).toBe(engine)
    expect((await host.request({ cmd: "codec", engine, patch: back })).hex).toBe(codec.hex)
    const rt = await host.request({ cmd: "roundtrip", path })
    expect(rt).toMatchObject({ loaded: true, identical: true, codecIdentical: true })
  })
})

describe.skipIf(!haveFactory)("factory patches", () => {
  test("every one loads, and the editor writes the codec's bytes for it (and the same bytes again)", async () => {
    const bad: string[] = []
    let n = 0
    for (const engine of readdirSync(factoryDir).filter((d) => ["ACD", "FAT", "VAP", "WTFM", "PERC"].includes(d))) {
      for (const file of readdirSync(join(factoryDir, engine)).filter((f) => f.endsWith(".patch"))) {
        const loaded = await host.tryRequest({ cmd: "load", path: join(factoryDir, engine, file) })
        if (!loaded.ok) { bad.push(`${engine}/${file}: refused: ${loaded.error}`); continue }
        const viaStore = (await host.request({ cmd: "encode", engine, patch: loaded.patch })).hex
        const viaCodec = (await host.request({ cmd: "codec", engine, patch: loaded.patch })).hex
        if (viaStore !== viaCodec) { bad.push(`${engine}/${file}: PatchStore writes other bytes than the codec`); continue }
        const again = (await host.request({ cmd: "load", path: join(factoryDir, engine, file) })).patch
        if ((await host.request({ cmd: "codec", engine, patch: again })).hex !== viaCodec) bad.push(`${engine}/${file}: a second load writes other bytes`)
        n++
      }
    }
    expect(bad).toEqual([])
    expect(n).toBeGreaterThanOrEqual(252)
  }, 300_000)
})

describe("patches written by older editor builds", () => {
  /** the engine id is the first field of a .patch (tag 0x08, then a varint): rewrite it, same length */
  const withEngineId = (bytes: Uint8Array, from: number[], to: number[]) => {
    expect(Array.from(bytes.subarray(0, 1 + from.length))).toEqual([0x08, ...from])
    expect(to.length).toBe(from.length)
    const out = Uint8Array.from(bytes)
    out.set(to, 1)
    return out
  }
  const saveNow = async (engine: string, name: string) => {
    const m = await host.request({ cmd: "meta", engine })
    const patch = structuredClone(m.init)
    patch.values = m.params.map((p: any, i: number) => (p.stepped ? Math.round(p.min + ((i % 3) / 3) * (p.max - p.min)) : Math.fround(p.min + ((i % 4) / 4) * (p.max - p.min))))
    const path = join(tmp, "now-" + name + ".patch")
    await host.request({ cmd: "save", path, patch })
    return { path, bytes: readFileSync(path), patch }
  }

  test("CHIP saved with the old id 0x10 loads as CHIP and is saved with Polyend's id 8 from then on", async () => {
    const now = await saveNow("CHIP", "chip")
    expect(now.bytes[1]).toBe(8)
    const old = join(tmp, "old-chip.patch")
    writeFileSync(old, withEngineId(now.bytes, [8], [0x10]))
    const r = await host.request({ cmd: "load", path: old })
    expect(r.patch.engine).toBe("CHIP")
    expect(r.warnings.join("\n")).toContain("engine id 0x10")
    expect(r.patch.values).toEqual((await host.request({ cmd: "load", path: now.path })).patch.values)
    const rt = await host.request({ cmd: "roundtrip", path: old })
    expect(rt).toMatchObject({ loaded: true, engine: "CHIP", identical: true })
    expect(rt.migrated).toContain("0x10")
    // the editor writes the firmware's id
    const out = join(tmp, "resaved-chip.patch")
    await host.request({ cmd: "save", path: out, patch: r.patch })
    expect(readFileSync(out).equals(now.bytes)).toBe(true)
  })

  test("D-Type saved with the old id 0x82 (before PHZ took it) loads as D-Type, a PHZ patch with 0x82 stays PHZ", async () => {
    const now = await saveNow("DTYPE", "dtype")
    expect(Array.from(now.bytes.subarray(1, 3))).toEqual([0xa2, 0x01]) // 0xA2 as a varint
    const old = join(tmp, "old-dtype.patch")
    writeFileSync(old, withEngineId(now.bytes, [0xa2, 0x01], [0x82, 0x01]))
    const r = await host.request({ cmd: "load", path: old })
    expect(r.patch.engine).toBe("DTYPE")
    expect(r.warnings.join("\n")).toContain("0x82")
    expect(r.patch.values).toEqual((await host.request({ cmd: "load", path: now.path })).patch.values)
    const out = join(tmp, "resaved-dtype.patch")
    await host.request({ cmd: "save", path: out, patch: r.patch })
    expect(readFileSync(out).equals(now.bytes)).toBe(true) // saved with 0xA2
    if (!havePrivate("PHZ")) return
    // asking for a PHZ patch with D-Type's file is still refused, and a real PHZ file (0x82, 62 parameters) is not mapped
    expect((await host.tryRequest({ cmd: "load", path: old, engine: "PHZ" })).ok).toBe(false)
    const phz = await saveNow("PHZ", "phz")
    expect(Array.from(phz.bytes.subarray(1, 3))).toEqual([0x82, 0x01])
    const p = await host.request({ cmd: "load", path: phz.path })
    expect(p.patch.engine).toBe("PHZ")
    expect(p.warnings.join("\n")).not.toContain("older editor build")
  })

  test("an id nobody ever wrote is still refused, with the number in the message", async () => {
    const now = await saveNow("ACD", "acd")
    const bad = join(tmp, "bad.patch")
    writeFileSync(bad, withEngineId(now.bytes, [1], [0x7f]))
    const r = await host.tryRequest({ cmd: "load", path: bad })
    expect(r.ok).toBe(false)
    expect(r.error).toContain("127")
  })
})
