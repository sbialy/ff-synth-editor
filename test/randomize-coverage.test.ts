// Coverage of the randomizer over discrete parameters (enum, switch, whole number): every legal value of every one of them, in
// every engine, must be reachable. Amount 100% draws over the whole range, so 2000 rolls must hit each value. Below 100% a roll
// moves toward the seed's target by Amount of the way, and a single roll must be able to change a parameter whose range is small
// (filter Type 0..2, Retrigger 0..2, Sync 0..1) from any value it can start at.
// Regression: the mutate path rounded every move to the nearest step, so for a small range (move under half a step) the value
// never changed (public/randomize.js, the stepped branch of randomize()).
import { afterAll, beforeAll, expect, test } from "bun:test"
import { newHost } from "./helpers"
import { randomize } from "../public/randomize.js"
import { SERVED_ENGINES as ENGINES } from "./helpers"
import type { HostClient } from "../server/host"

let host: HostClient
const metas: Record<string, any> = {}
beforeAll(async () => {
  host = await newHost()
  for (const e of ENGINES) metas[e] = await host.request({ cmd: "meta", engine: e })
}, 300_000)
afterAll(() => host.close())

const N = 2000
const discrete = (p: any) => (p.stepped || p.names) && p.max > p.min
// ids the roll never touches on purpose (the engine's Volume): excluded from the coverage
const skipped = (meta: any) => new Set<number>([meta.volumeParam])

test("Amount 100%: every legal value of every discrete parameter of every engine is hit in 2000 rolls", () => {
  const report: string[] = []
  for (const name of ENGINES) {
    const meta = metas[name], skip = skipped(meta)
    const hits = new Map<number, Map<number, number>>()
    for (let seed = 1; seed <= N; seed++) {
      const plan = randomize(meta, meta.init, { amount: 1, seed })
      for (const [id, v] of (Object.entries(plan.values) as [string, number][]).filter(([id]) => !(id in plan.positions))) {
        const m = hits.get(+id) ?? new Map<number, number>()
        m.set(v, (m.get(v) ?? 0) + 1)
        hits.set(+id, m)
      }
    }
    meta.params.forEach((p: any, id: number) => {
      if (!discrete(p) || skip.has(id)) return
      const missing: number[] = []
      for (let v = p.min; v <= p.max; v++) if (!hits.get(id)?.get(v)) missing.push(v)
      // up to 64 values every one must be hit (about 31 hits each in 2000 rolls, a miss would be a bug). A wider range (a 201 step
      // Fine tune) has about 10 hits per value, so a value missing by chance is normal: there both ends and 95% of the values.
      const wide = p.max - p.min + 1 > 64
      const ends = [p.min, p.max].filter((v) => missing.includes(v))
      if (wide ? ends.length || missing.length > 0.05 * (p.max - p.min + 1) : missing.length) report.push(`${name} #${id} ${p.name} [${p.min}..${p.max}] never hit: ${missing.join(",")}`)
    })
  }
  expect(report).toEqual([])
}, 60_000)

// Algorithm 2 (see public/randomize.js): below 100% a parameter travels from where it is toward the target the seed fixed, so a chain
// of rolls with different seeds is pulled back to the middle on purpose (each roll moves a fraction of the way to a fresh uniform
// target) and "chained rolls walk through every value" is no longer a property of the roll (the old mutate walk had it). What stays
// is the property that matters: from EVERY legal value, including both ends, a roll below 100% can change a small discrete
// parameter (this is what the 226ff7c regression broke), and the ends themselves are reached at 100% (previous test).
test("Amount below 100%: a small-range discrete parameter changes in a single roll from every one of its legal values", () => {
  const report: string[] = []
  for (const name of ENGINES) {
    const meta = metas[name], skip = skipped(meta)
    for (const amount of [0.1, 0.25]) {
      const changed = new Map<string, boolean>() // "id@value" -> changed in at least one roll
      for (let k = 0; k <= 15; k++) {
        const patch = structuredClone(meta.init)
        meta.params.forEach((p: any, id: number) => { if (discrete(p)) patch.values[id] = Math.min(p.max, p.min + k) })
        for (let seed = 1; seed <= 400; seed++) {
          const plan = randomize(meta, patch, { amount, seed })
          for (const [id, v] of (Object.entries(plan.values) as [string, number][]).filter(([id]) => !(id in plan.positions))) if (v !== patch.values[+id]) changed.set(`${id}@${patch.values[+id]}`, true)
        }
      }
      meta.params.forEach((p: any, id: number) => {
        if (!discrete(p) || skip.has(id) || p.max - p.min > 15) return
        for (let v = p.min; v <= p.max; v++) if (!changed.get(`${id}@${v}`)) report.push(`${name} #${id} ${p.name} at ${amount * 100}%: never changed when it starts at ${v}`)
      })
    }
  }
  expect(report).toEqual([])
}, 120_000)

test("Amount below 100%: a stepped move stays within Amount of the range (rounded up at most one step) and inside the range", () => {
  for (const name of ENGINES) {
    const meta = metas[name]
    for (const amount of [0.1, 0.5]) {
      for (let seed = 1; seed <= 200; seed++) {
        const plan = randomize(meta, meta.init, { amount, seed })
        for (const [id, v] of (Object.entries(plan.values) as [string, number][]).filter(([id]) => !(id in plan.positions))) {
          const p = meta.params[id], cur = meta.init.values[id]
          expect(Number.isInteger(v)).toBe(true)
          expect(v).toBeGreaterThanOrEqual(p.min)
          expect(v).toBeLessThanOrEqual(p.max)
          expect(Math.abs(v - cur)).toBeLessThanOrEqual(amount * (p.max - p.min) + 1)
        }
      }
    }
  }
})
