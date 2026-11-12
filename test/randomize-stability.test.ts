// Properties that make a seed stable: it is keyed by the engine's id and by each parameter's slot in the .patch file, so a later engine
// version that adds, removes or reorders parameters leaves the others alone, and no two engines share an id.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { havePrivate, newHost } from "./helpers"
import { SERVED_ENGINES as ENGINES } from "./helpers"
import { randomize, applyPlan } from "../public/randomize.js"
import type { HostClient } from "../server/host"

let host: HostClient
const metas: Record<string, any> = {}
beforeAll(async () => {
  host = await newHost()
  for (const e of ENGINES) metas[e] = await host.request({ cmd: "meta", engine: e })
}, 300_000)
afterAll(() => host.close())

test("every engine has its own engine id (the id in the .patch file) and parameter ids that are their slots", () => {
  const ids = ENGINES.map((e) => metas[e].engineId)
  expect(new Set(ids).size).toBe(ENGINES.length)
  for (const id of ids) expect(Number.isInteger(id) && id >= 0).toBe(true)
  for (const e of ENGINES) metas[e].params.forEach((p: any, i: number) => expect(p.id).toBe(i))
})

test("stepped parameters have whole number ranges (the integer target maths relies on it)", () => {
  for (const e of ENGINES) for (const p of metas[e].params) if (p.stepped || p.names) { expect(Number.isInteger(p.min)).toBe(true); expect(Number.isInteger(p.max)).toBe(true) }
})

test("the same seed means different patches on different engines, and the engine id is what separates them", () => {
  const a = randomize(metas.ACD, metas.ACD.init, { amount: 1, seed: 5 }), twin = structuredClone(metas.ACD)
  twin.engineId = 99
  const b = randomize(twin, twin.init, { amount: 1, seed: 5 })
  expect(b.values).not.toEqual(a.values)
})

// a future engine version: parameters added at the end, one removed, the list shuffled (each keeps its slot id)
test("adding, removing or reordering parameters in the metadata leaves every other parameter's result unchanged", () => {
  const meta = metas[havePrivate("PHZ") ? "PHZ" : "WTFM"], base = randomize(meta, meta.init, { amount: 1, seed: 77 })
  const same = (other: any, patch: any, ids: number[], amount = 1) => {
    const p = randomize(other, patch, { amount, seed: 77 })
    for (const id of ids) {
      expect(p.values[id]).toBe(base.values[id])
    }
    return p
  }
  const ids = meta.params.map((_: any, i: number) => i)
  // added: three new parameters appended with new slots
  const grown = structuredClone(meta)
  for (let k = 0; k < 3; k++) grown.params.push({ id: meta.params.length + k, name: "New " + k, min: 0, max: 1, def: 0.5, curve: "linear", stepped: false })
  grown.sections[0].params.push(meta.params.length, meta.params.length + 1)
  const patchGrown = { ...structuredClone(meta.init), values: [...meta.init.values, 0.5, 0.5, 0.5] }
  const g = same(grown, patchGrown, ids)
  expect(Object.keys(g.values).length).toBe(Object.keys(base.values).length + 3)
  // removed: the last parameter dropped
  const last = meta.params.length - 1
  const shrunk = structuredClone(meta)
  shrunk.params.pop()
  for (const s of shrunk.sections) s.params = s.params.filter((i: number) => i !== last)
  same(shrunk, { ...structuredClone(meta.init), values: meta.init.values.slice(0, last) }, ids.filter((i: number) => i !== last))
  // reordered: the list is reversed, every parameter keeps its slot id (and the patch is addressed by slot)
  const rev = structuredClone(meta)
  rev.params.reverse()
  same(rev, meta.init, ids)
  // and at a partial Amount from a rolled patch too
  const start = applyPlan(meta.init, base)
  const half = randomize(meta, start, { amount: 0.4, seed: 9 }), halfRev = randomize(rev, start, { amount: 0.4, seed: 9 })
  expect(halfRev.values).toEqual(half.values)
})
