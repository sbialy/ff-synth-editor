import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { engines, runCompat, summarize, type FileResult } from "../scripts/compat"
import { POLYEND_AND_PLUCK, factoryDir, haveFactory, newHost } from "./helpers"
import type { HostClient } from "../server/host"

let host: HostClient
let tmp: string
beforeAll(async () => {
  host = await newHost()
  tmp = mkdtempSync(join(tmpdir(), "poly-editor-test-"))
}, 300_000)
afterAll(() => {
  host.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe("host patch files", () => {
  test.each(POLYEND_AND_PLUCK)("%s: edit, save, load gives the same values and macros", async (engine) => {
    const m = await host.request({ cmd: "meta", engine })
    const patch = structuredClone(m.init)
    // move every parameter to a value 30% into its range (stepped ones rounded)
    patch.values = m.params.map((p: any) => (p.stepped ? Math.round(p.min + 0.3 * (p.max - p.min)) : Math.fround(p.min + 0.3 * (p.max - p.min))))
    patch.macros[0].name = "My Macro"
    patch.macros[1].targets = [{ param: 2, amount: Math.fround(0.5) }]
    const path = join(tmp, engine, "edited.patch")
    await host.request({ cmd: "save", path, patch })
    const back = (await host.request({ cmd: "load", path })).patch
    expect(back.engine).toBe(engine)
    // unused slots (min == max) are written as absent, the rest comes back as the same float
    expect(back.values.map((v: number | null) => (v === null ? null : Math.fround(v)))).toEqual(patch.values.map((v: number, i: number) => (m.params[i].min === m.params[i].max ? null : Math.fround(v))))
    expect(back.macros[0].name).toBe("My Macro")
    expect(back.macros[1].targets).toEqual([{ param: 2, amount: 0.5 }])
    // saving the loaded patch again writes the same bytes
    const path2 = join(tmp, engine, "edited2.patch")
    await host.request({ cmd: "save", path: path2, patch: back })
    expect(readFileSync(path2).equals(readFileSync(path))).toBe(true)
  })

  test("garbage, truncated and wrong-engine files are refused", async () => {
    writeFileSync(join(tmp, "junk.patch"), Buffer.from("this is not a patch file"))
    const junk = await host.tryRequest({ cmd: "load", path: join(tmp, "junk.patch") })
    expect(junk.ok).toBe(false)
    const m = await host.request({ cmd: "meta", engine: "FAT" })
    const p = join(tmp, "fat.patch")
    await host.request({ cmd: "save", path: p, patch: m.init })
    const wrong = await host.tryRequest({ cmd: "load", path: p, engine: "ACD" })
    expect(wrong.ok).toBe(false)
    expect(wrong.error).toContain("FAT")
    const bytes = readFileSync(p)
    writeFileSync(join(tmp, "cut.patch"), bytes.subarray(0, 101))
    expect((await host.tryRequest({ cmd: "load", path: join(tmp, "cut.patch") })).ok).toBe(false)
  })
})

describe.skipIf(!haveFactory)("Polyend factory patches", () => {
  let results: FileResult[]
  beforeAll(async () => {
    results = await runCompat(factoryDir, host)
    console.log("\nFactory patch compatibility (synth-open codec, PatchStore load -> save):\n" + summarize(results))
  }, 300_000)

  test("all 252 factory files are found and every one loads", () => {
    expect(results.length).toBe(252)
    expect(Object.fromEntries(engines.map((e) => [e, results.filter((r) => r.engine === e).length]))).toEqual({ ACD: 62, FAT: 57, VAP: 69, WTFM: 64 })
    const refused = results.filter((r) => !r.loaded)
    expect(refused.map((r) => `${r.engine}/${r.file}: ${r.reason}`)).toEqual([])
  })

  test("re-save is byte identical for the files without unassigned macro targets", () => {
    const identical = results.filter((r) => r.identical)
    expect(identical.length).toBeGreaterThanOrEqual(102)
    // every failure has one of the two known causes, nothing unexplained
    const unexplained = results.filter((r) => r.loaded && !r.identical && !(r.hints ?? []).some((h) => h.startsWith("unassigned-target:") || h.startsWith("param-value:")))
    expect(unexplained.map((r) => `${r.engine}/${r.file}`)).toEqual([])
  })

  test("the codec alone (decode -> encode) is exact except for unassigned targets", () => {
    // codecIdentical is false only where the file holds unassigned macro slots the encoder compacts
    const bad = results.filter((r) => r.codecIdentical === false && !(r.hints ?? []).some((h) => h.startsWith("unassigned-target:")))
    expect(bad.map((r) => `${r.engine}/${r.file}`)).toEqual([])
  })

  test("after one load -> save the file is stable: the next load -> save is byte identical", async () => {
    const unstable: string[] = []
    for (const r of results) {
      const out = join(tmp, "gen1", r.engine, r.file)
      const patch = (await host.request({ cmd: "load", path: join(factoryDir, r.engine, r.file) })).patch
      await host.request({ cmd: "save", path: out, patch })
      const again = await host.request({ cmd: "roundtrip", path: out })
      if (!again.loaded || !again.identical) unstable.push(`${r.engine}/${r.file}`)
    }
    expect(unstable).toEqual([])
  }, 300_000)

  test("the editor load path (JSON) clamps half float edge values instead of losing them", async () => {
    const r = await host.request({ cmd: "load", path: join(factoryDir, "ACD", "Solid Bass.patch") })
    expect(r.warnings.length).toBe(1)
    const m = await host.request({ cmd: "meta", engine: "ACD" })
    const lfo = m.params.find((p: any) => p.name === "Frequency")
    expect(r.patch.values[lfo.id]).toBeCloseTo(0.1, 5)
  })

  test("a factory macro changes the final parameter value", async () => {
    const patch = (await host.request({ cmd: "load", path: join(factoryDir, "ACD", "2oh2.patch") })).patch
    const t = patch.macros[0].targets[0]
    const off = await host.request({ cmd: "describe", engine: "ACD", patch, macroValues: [0, 0, 0, 0, 0, 0] })
    const on = await host.request({ cmd: "describe", engine: "ACD", patch, macroValues: [100, 0, 0, 0, 0, 0] })
    expect(on.final[t.param]).not.toBe(off.final[t.param])
  })
})
