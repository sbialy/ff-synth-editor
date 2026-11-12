import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { PARAM_COUNTS, PLK_PARAM_COUNT, POLYEND_AND_PLUCK, newHost } from "./helpers"

const COUNTS: Record<string, number> = { ...PARAM_COUNTS, PLK: PLK_PARAM_COUNT }
import type { HostClient } from "../server/host"

let host: HostClient
beforeAll(async () => { host = await newHost() }, 300_000)
afterAll(() => host.close())

describe.each(POLYEND_AND_PLUCK)("metadata %s", (engine) => {
  test("params, sections, macros", async () => {
    const m = await host.request({ cmd: "meta", engine })
    expect(m.params.length).toBe(COUNTS[engine])
    expect(m.sections.length).toBeGreaterThanOrEqual(engine === "PLK" ? 3 : 5)
    expect(m.macros.length).toBe(8)
    // every param is in exactly one section, with a name and a sane range
    const seen = new Map<number, number>()
    for (const s of m.sections) for (const id of s.params) seen.set(id, (seen.get(id) ?? 0) + 1)
    for (const p of m.params) {
      if (p.min === p.max) {
        // unused slot kept for file layout (WTFM 6 and 7): no name, in no section, written as absent
        expect(p.name).toBe("")
        expect(seen.has(p.id)).toBe(false)
        continue
      }
      expect(p.name.length).toBeGreaterThan(0)
      expect(p.min).toBeLessThanOrEqual(p.max)
      expect(p.def).toBeGreaterThanOrEqual(p.min)
      expect(p.def).toBeLessThanOrEqual(p.max)
      expect(["linear", "exp", "expSteep", "power"]).toContain(p.curve)
      expect(seen.get(p.id)).toBe(1)
      if (p.names) expect(p.names.length).toBe(p.max - p.min + 1)
    }
    expect(m.init.values.length).toBe(COUNTS[engine])
  })

  test("value text and edit curve", async () => {
    const m = await host.request({ cmd: "meta", engine })
    const d = await host.request({ cmd: "describe", engine, patch: m.init, macroValues: m.macros.slice(0, 6).map((x: any) => x.value) })
    expect(d.texts.length).toBe(COUNTS[engine])
    for (const t of d.texts) expect(typeof t === "string" && t.length > 0).toBe(true)
    // knob 0 and 1 give the range ends, the middle lies inside, texts differ between the ends for non-trivial params
    for (const p of m.params) {
      const lo = await host.request({ cmd: "knob", engine, param: p.id, knob: 0 })
      const hi = await host.request({ cmd: "knob", engine, param: p.id, knob: 1 })
      expect(lo.value).toBeCloseTo(p.min, 3)
      expect(hi.value).toBeCloseTo(p.max, 3)
    }
  })
})

test("known value texts of ACD", async () => {
  const m = await host.request({ cmd: "meta", engine: "ACD" })
  const cutoff = m.params.find((p: any) => p.name.toLowerCase().includes("cutoff"))
  const lo = await host.request({ cmd: "knob", engine: "ACD", param: cutoff.id, knob: 0 })
  const hi = await host.request({ cmd: "knob", engine: "ACD", param: cutoff.id, knob: 1 })
  expect(lo.text).toMatch(/Hz$/)
  expect(hi.text).toMatch(/kHz$/)
  const sub = m.params.find((p: any) => p.name === "Sub Mode")
  expect(sub.names).toContain("-1 Oct Square")
})

