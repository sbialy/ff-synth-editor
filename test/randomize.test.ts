// The patch randomizer (public/randomize.js): range, enum validity, locks, sections, Amount 0, seeds, Volume, macros, undo history,
// and every engine rendered through the real host (finite). The roll itself needs no host (public/curve.js maps knob positions).
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ALL_ENGINES, available, havePrivate, newHost, parseWav, testPrivate } from "./helpers"
import { knobOf } from "../public/curve.js"
import { randomize, applyPlan, createHistory, protectedParams, sectionNames, ampEnvelope, GUARD, OTHER } from "../public/randomize.js"
import { SERVED_ENGINES as ENGINES } from "./helpers"
import type { HostClient } from "../server/host"

let host: HostClient
let tmp: string
const metas: Record<string, any> = {}
beforeAll(async () => {
  host = await newHost()
  tmp = mkdtempSync(join(tmpdir(), "poly-editor-rand-"))
  for (const e of ENGINES) metas[e] = await host.request({ cmd: "meta", engine: e })
}, 300_000)
afterAll(() => {
  host.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** The page's pipeline: plan, apply. (The host is only needed to render.) */
async function roll(engine: string, patch: any, opts: any) {
  const plan = randomize(metas[engine], patch, opts)
  return { plan, patch: applyPlan(patch, plan) }
}
const changedIds = (a: any, b: any) => a.values.map((v: number, i: number) => (v !== b.values[i] ? i : -1)).filter((i: number) => i >= 0)

test("the eighteen engines are all covered (PHZ and PLK when their runtime modules are installed)", () => {
  expect(ENGINES.slice().sort()).toEqual(available([...ALL_ENGINES, "PHZ", "PLK"]).sort())
  if (havePrivate("PHZ", "PLK")) expect(ENGINES.length).toBe(18)
})

test("Amount 100%: every parameter of every engine lands in its range, enums on a valid entry, steps on whole numbers", async () => {
  for (const name of ENGINES) {
    const meta = metas[name]
    for (const seed of [1, 2, 3]) {
      const { plan, patch } = await roll(name, meta.init, { amount: 1, seed })
      expect(plan.touched).toBeGreaterThan(meta.params.length * 0.5)
      patch.values.forEach((v: number, id: number) => {
        const p = meta.params[id]
        if (!(p.max > p.min)) return // WTFM 6 and 7 are unused slots (no name, range 0..0): never touched
        expect(Number.isFinite(v)).toBe(true)
        expect(v).toBeGreaterThanOrEqual(p.min - 1e-6)
        expect(v).toBeLessThanOrEqual(p.max + 1e-6)
        if (p.stepped || p.names) expect(Number.isInteger(v)).toBe(true)
        if (p.names) expect(p.names[v - p.min]).toBeDefined()
      })
    }
  }
}, 120_000)

testPrivate("PHZ")("Amount 100% really spreads: over many seeds an enum visits every entry and a knob covers most of its range", async () => {
  const meta = metas.PHZ
  const model = meta.params.findIndex((p: any) => p.name === "Model")
  const cutoff = meta.params.findIndex((p: any) => p.name === "Cutoff")
  const seen = new Set<number>(), ks: number[] = []
  for (let seed = 1; seed <= 200; seed++) {
    const plan = randomize(meta, meta.init, { amount: 1, seed })
    seen.add(plan.values[model])
    ks.push(plan.positions[cutoff] / 65535)
  }
  expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5])
  expect(Math.min(...ks)).toBeLessThan(0.05)
  expect(Math.max(...ks)).toBeGreaterThan(0.95)
})

test("Amount below 100% moves each parameter by at most Amount of its range", async () => {
  for (const name of available(["PHZ", "ACD", "ARCTYPE"])) {
    const meta = metas[name]
    const base = (await roll(name, meta.init, { amount: 1, seed: 7 })).patch // a patch away from the defaults
    for (const amount of [0.05, 0.25, 0.6]) {
      const plan = randomize(meta, base, { amount, seed: 11 })
      for (const [id, v] of Object.entries(plan.values) as [string, number][]) {
        const p = meta.params[id]
        expect(v).toBeGreaterThanOrEqual(p.min)
        expect(v).toBeLessThanOrEqual(p.max)
        if (!(id in plan.positions)) expect(Math.abs(v - base.values[id])).toBeLessThanOrEqual(Math.ceil(amount * (p.max - p.min))) // a stepped move is rounded at random: at most up to the next whole step
      }
      for (const [id, k] of Object.entries(plan.positions) as [string, number][]) {
        expect(Number.isInteger(k)).toBe(true)
        expect(k).toBeGreaterThanOrEqual(0)
        expect(k).toBeLessThanOrEqual(65535)
        expect(Math.abs(k - knobOf(meta.params[id], base.values[id]))).toBeLessThanOrEqual(amount * 65535 + 1)
      }
    }
  }
})

test("Amount 0 changes nothing", async () => {
  for (const name of available(["PHZ", "FM4", "CHIP"])) {
    const meta = metas[name]
    const { plan, patch } = await roll(name, meta.init, { amount: 0, seed: 5, macros: true })
    expect(plan.touched).toBe(0)
    expect(patch).toEqual(meta.init)
  }
})

test("seeds: the same seed on the same patch gives the same result, another seed another one", async () => {
  const meta = metas.VAP
  const a = await roll("VAP", meta.init, { amount: 1, seed: 1234, macros: true })
  const b = await roll("VAP", meta.init, { amount: 1, seed: 1234, macros: true })
  const c = await roll("VAP", meta.init, { amount: 1, seed: 1235, macros: true })
  expect(b.patch).toEqual(a.patch)
  expect(c.patch).not.toEqual(a.patch)
  expect(a.plan.seed).toBe(1234n)
  const m1 = await roll("VAP", a.patch, { amount: 0.3, seed: 9 }), m2 = await roll("VAP", a.patch, { amount: 0.3, seed: 9 })
  expect(m2.patch).toEqual(m1.patch)
  // a roll without a seed picks one and reports it, so it can be repeated
  const free = await roll("VAP", meta.init, { amount: 1 })
  expect(typeof free.plan.seed).toBe("bigint")
  expect((await roll("VAP", meta.init, { amount: 1, seed: free.plan.seed })).patch).toEqual(free.patch)
})

test("Volume (the output level) is never touched, on any engine, at any amount", async () => {
  for (const name of ENGINES) {
    const meta = metas[name]
    const prot = protectedParams(meta)
    if (meta.volumeParam >= 0) expect(prot.has(meta.volumeParam)).toBe(true)
    for (const amount of [1, 0.5]) {
      const start = (await roll(name, meta.init, { amount: 1, seed: 3 })).patch
      for (const seed of [1, 2, 3, 4]) {
        const { patch } = await roll(name, start, { amount, seed, macros: true })
        for (const id of prot) expect(patch.values[id]).toBe(start.values[id])
      }
    }
  }
  if (havePrivate("PHZ")) expect(metas.PHZ.params[18].name).toBe("Volume")
}, 120_000)

testPrivate("PHZ")("locked parameters stay, and locking one does not change what the others get for a seed", async () => {
  const meta = metas.PHZ
  const all = await roll("PHZ", meta.init, { amount: 1, seed: 21 })
  const locks = [0, 7, 19]
  const some = await roll("PHZ", meta.init, { amount: 1, seed: 21, locks })
  for (const id of locks) expect(some.patch.values[id]).toBe(meta.init.values[id])
  for (const id of changedIds(meta.init, all.patch).filter((i: number) => !locks.includes(i))) expect(some.patch.values[id]).toBe(all.patch.values[id])
  expect(changedIds(meta.init, some.patch).some((i: number) => locks.includes(i))).toBe(false)
  // everything locked: nothing to do
  const none = randomize(meta, meta.init, { amount: 1, seed: 1, locks: meta.params.map((_: any, i: number) => i) })
  expect(none.touched).toBe(0)
})

test("sections: only the switched on sections are randomized", async () => {
  for (const name of available(["PHZ", "WTFM", "JU6", "FM4"])) {
    const meta = metas[name]
    expect(sectionNames(meta).slice(0, meta.sections.length)).toEqual(meta.sections.map((s: any) => s.name))
    const pick = meta.sections.find((s: any) => /filter|vcf/i.test(s.name)) ?? meta.sections[1]
    const { patch } = await roll(name, meta.init, { amount: 1, seed: 8, sections: [pick.name] })
    const changed = changedIds(meta.init, patch)
    expect(changed.length).toBeGreaterThan(0)
    for (const id of changed) expect(pick.params).toContain(id)
    // no section on: nothing
    expect(randomize(meta, meta.init, { amount: 1, seed: 8, sections: [] }).touched).toBe(0)
  }
})

test("parameters in no section are the Other section", () => {
  const meta = { volumeParam: -1, macros: [], sections: [{ name: "A", params: [0] }], params: [{ name: "x", min: 0, max: 1, def: 0 }, { name: "y", min: 0, max: 1, def: 0 }] }
  expect(sectionNames(meta)).toEqual(["A", OTHER])
  const patch = { values: [0, 0], macros: [] }
  expect(Object.keys(randomize(meta, patch, { amount: 1, seed: 1, sections: ["A"] }).values)).toEqual(["0"])
  expect(Object.keys(randomize(meta, patch, { amount: 1, seed: 1, sections: [OTHER] }).values)).toEqual(["1"])
})

testPrivate("PHZ")("macro assignments only move with the toggle, only their amounts, never a locked or volume target", async () => {
  const meta = metas.PHZ
  const off = await roll("PHZ", meta.init, { amount: 1, seed: 4 })
  expect(off.plan.macros).toEqual([])
  expect(off.patch.macros).toEqual(meta.init.macros)
  const on = await roll("PHZ", meta.init, { amount: 1, seed: 4, macros: true })
  expect(on.plan.macros.length).toBeGreaterThan(3)
  expect(on.patch.macros).not.toEqual(meta.init.macros)
  expect(on.patch.macros.map((m: any) => m.targets.map((t: any) => t.param))).toEqual(meta.init.macros.map((m: any) => m.targets.map((t: any) => t.param)))
  for (const m of on.patch.macros) for (const t of m.targets) expect(Math.abs(t.amount)).toBeLessThanOrEqual(1)
  // the Velocity macro rides on Volume: left alone
  const vel = meta.init.macros.findIndex((m: any) => m.name === "Velocity")
  expect(on.patch.macros[vel]).toEqual(meta.init.macros[vel])
  // a locked target keeps its amount
  const cut = meta.init.macros[0].targets[0].param
  const locked = await roll("PHZ", meta.init, { amount: 1, seed: 4, macros: true, locks: [cut] })
  expect(locked.patch.macros[0].targets[0].amount).toBe(meta.init.macros[0].targets[0].amount)
  // gentle mutation stays near
  const near = await roll("PHZ", meta.init, { amount: 0.1, seed: 4, macros: true })
  for (const c of near.plan.macros) expect(Math.abs(c.amount - meta.init.macros[c.macro].targets[c.target].amount)).toBeLessThanOrEqual(0.2 + 1e-9)
})

test("the audibility guard keeps the amp attack short and gives a sustain-less envelope a decay", () => {
  const meta = {
    volumeParam: -1, macros: [], sections: [{ name: "Amp Envelope", params: [0, 1, 2, 3] }],
    params: [{ name: "Attack", min: 0, max: 10, def: 0 }, { name: "Decay", min: 0, max: 10, def: 0 }, { name: "Sustain", min: 0, max: 1, def: 1 }, { name: "Release", min: 0, max: 10, def: 0 }],
  }
  expect(ampEnvelope(meta)).toEqual({ attack: 0, decay: 1, sustain: 2 })
  let long = 0, dead = 0
  for (let seed = 1; seed <= 300; seed++) {
    const plan = randomize(meta, { values: [0, 5, 1, 0], macros: [] }, { amount: 1, seed })
    expect(plan.positions[0]).toBeLessThanOrEqual(GUARD.attackMax)
    const sustain = plan.positions[2]
    if (sustain < GUARD.sustainFloor) { expect(plan.positions[1]).toBeGreaterThanOrEqual(GUARD.decayMin); dead++ }
    if (plan.positions[0] > 0.3 * 65535) long++
  }
  expect(long).toBeGreaterThan(20) // the cap does not flatten the attack
  expect(dead).toBeGreaterThan(10) // short sustains still happen
  // a locked decay or a section that is off is not touched by the guard
  const plan = randomize(meta, { values: [0, 0, 1, 0], macros: [] }, { amount: 1, seed: 3, locks: [1, 0] })
  expect(1 in plan.positions).toBe(false)
  expect(0 in plan.positions).toBe(false)
  // mutation: a long attack that is already there is not pushed lower than it sits unless the draw does so
  const mut = randomize(meta, { values: [9, 0, 1, 0], macros: [] }, { amount: 0.05, seed: 2 })
  expect(mut.positions[0]).toBeGreaterThanOrEqual(0.85 * 65535 - 1)
  // 100% is the same from any start, the guard included (a decay already above the floor does not change what the seed gives)
  for (let seed = 1; seed <= 100; seed++) {
    const a = randomize(meta, { values: [0, 0, 1, 0], macros: [] }, { amount: 1, seed }), b = randomize(meta, { values: [7, 9, 0, 4], macros: [] }, { amount: 1, seed })
    expect(b.values).toEqual(a.values)
  }
})

test("every engine, rolled at 100% from its Init patch: finite audio, and silent results are the exception", async () => {
  const silent: Record<string, number> = {}
  for (const name of ENGINES) {
    silent[name] = 0
    for (const seed of [11, 12, 13, 14, 15, 16]) {
      const { patch } = await roll(name, metas[name].init, { amount: 1, seed })
      const out = join(tmp, name + ".wav")
      const r = await host.request({ cmd: "render", engine: name, patch, note: name === "TTYPE" ? 60 : 57, velocity: 100, seconds: 0.8, hold: 0.5, out })
      expect(r.finite).toBe(true)
      expect(parseWav(readFileSync(out)).samples.every(Number.isFinite)).toBe(true)
      if (!(r.peak >= 0.002)) silent[name]++
    }
  }
  console.log("silent results out of 6 rolls at 100%:", JSON.stringify(silent))
  const total = Object.values(silent).reduce((a, b) => a + b, 0)
  expect(total).toBeLessThanOrEqual(ENGINES.length * 6 * 0.25)
}, 180_000)

test("history: a step list with an index, undo and redo walk it, a new step drops the forward tail, the cap keeps the base", () => {
  const h = createHistory(50)
  h.reset({ kind: "base", snap: { n: 0 } })
  for (let i = 1; i <= 60; i++) h.push({ kind: "roll", snap: { n: i } })
  expect(h.entries.length).toBe(50)
  expect(h.undoCount).toBe(49)
  expect(h.entries[0].kind).toBe("base")
  expect(h.entries[1].kind).toBe("edits") // the oldest roll was dropped, the next one now jumps from the base
  expect(h.entries[1].snap).toEqual({ n: 12 })
  expect(h.entries[49].snap).toEqual({ n: 60 })
  for (let i = 48; i >= 0; i--) expect(h.undo()!.snap).toEqual(i === 0 ? { n: 0 } : i === 1 ? { n: 12 } : { n: i + 11 })
  expect(h.undo()).toBeUndefined()
  expect(h.redoCount).toBe(49)
  expect(h.redo()!.snap).toEqual({ n: 12 })
  expect(h.goto(10)!.snap).toEqual({ n: 21 })
  expect(h.index).toBe(10)
  h.push({ kind: "roll", snap: { n: 99 } })
  expect(h.redoCount).toBe(0)
  expect(h.entries.length).toBe(12)
  expect(h.goto(99)).toBeUndefined()
  h.clear()
  expect(h.undoCount).toBe(0)
  expect(createHistory(20).undo()).toBeUndefined()
})
