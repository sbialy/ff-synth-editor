// Algorithm 2 and the codes (public/randomize.js, public/recipe.js): the seed fixes a target per parameter whatever the Amount is,
// the Amount only decides how far the patch travels toward it, and a recipe (base + steps, manual edits included) or a roll code
// replays to the same patch bytes. The page behaviour (panel, undo, paste) is in test/page.test.ts.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { available, havePrivate, newHost } from "./helpers"
// the engine the tests use as their example: PHZ (private) when its module is installed, else WTFM
const EX = havePrivate("PHZ") ? "PHZ" : "WTFM"
import { ALGO, ampEnvelope, applyPlan, createHistory, randomize, sectionNames } from "../public/randomize.js"
import { formatSeed } from "../public/seed.js"
import { knobOf } from "../public/curve.js"
import { RECIPE_FORMAT, applyEdits, applyRoll, buildRecipe, decodeCode, diffEdits, encodeRecipe, encodeRollCode, firmwareLabel, firmwareWarning, replaySteps, resultWarning, rollSettings, shortHash } from "../public/recipe.js"
import { SERVED_ENGINES as ENGINES } from "./helpers"
import type { HostClient } from "../server/host"

let host: HostClient
const metas: Record<string, any> = {}
beforeAll(async () => {
  host = await newHost()
  for (const e of ENGINES) metas[e] = await host.request({ cmd: "meta", engine: e })
}, 300_000)
afterAll(() => host.close())

const bytes = async (patch: any) => (await host.request({ cmd: "encode", patch })).hex as string
const settings = (meta: any, o: any = {}) => rollSettings(meta, { seed: 1, amount: 100, sections: null, locks: [], macros: false, ...o })
const snapOf = (p: any) => ({ values: [...p.values], macros: structuredClone(p.macros ?? []), dirty: true })
const b64 = (o: object) => "polyrec." + Buffer.from(JSON.stringify(o)).toString("base64url")
const SEED2 = formatSeed(1234n, 2)

test("the algorithm is versioned: a plan, the seed of a step, a recipe and a roll code carry it", () => {
  expect(ALGO).toBe(2)
  const meta = metas.ACD
  expect(randomize(meta, meta.init, { amount: 1, seed: 1 }).algo).toBe(ALGO)
  expect(settings(meta).algo).toBe(ALGO)
  const text = encodeRecipe(buildRecipe(meta, "ACD", { kind: "init" }, [{ kind: "base", snap: snapOf(meta.init) }]))
  expect(JSON.parse(Buffer.from(text.slice("polyrec.".length), "base64url").toString()).f).toBe(RECIPE_FORMAT)
  expect(text.startsWith("polyrec.")).toBe(true)
  const roll = encodeRollCode("ACD", settings(meta, { seed: 1234n }))
  expect(roll.startsWith("polyroll.")).toBe(true)
  expect(JSON.parse(Buffer.from(roll.slice("polyroll.".length), "base64url").toString()).r[1]).toBe(SEED2) // the seed text starts with "2-": the algorithm
  expect(SEED2.startsWith("2-")).toBe(true)
})

test("a code of another algorithm version, a mistyped seed or a broken text is refused with a message", () => {
  const meta = metas.ACD
  const ok = { f: RECIPE_FORMAT, e: "ACD", b: { b: "init" }, s: [] as unknown[] }
  const step = (seed: string) => ["r", seed, 100, 0, [], 0]
  expect(decodeCode(b64(ok)).type).toBe("recipe")
  expect(decodeCode(b64({ ...ok, s: [step(SEED2)] })).type).toBe("recipe")
  expect(() => decodeCode(b64({ ...ok, s: [step(formatSeed(1234n, 3))] }))).toThrow(/algorithm 3/)
  expect(() => decodeCode(b64({ ...ok, s: [step(formatSeed(1234n, 1))] }))).toThrow(/algorithm 1/)
  expect(() => decodeCode(b64({ ...ok, s: [step(formatSeed(1234n))] }))).toThrow(/algorithm version/) // a bare seed code has none
  const typo = SEED2.slice(0, 6) + (SEED2[6] === "A" ? "B" : "A") + SEED2.slice(7)
  expect(() => decodeCode(b64({ ...ok, s: [step(typo)] }))).toThrow(/check symbol/)
  expect(() => decodeCode(b64({ ...ok, s: [step(typo)] }))).toThrow(/step 1/)
  expect(() => decodeCode(b64({ ...ok, s: [["r", 1234, 100, 0, [], 0]] }))).toThrow(/step 1/) // numeric seeds were format 1
  expect(() => decodeCode(b64({ ...ok, f: 1 }))).toThrow(/format/)
  expect(() => decodeCode(b64({ ...ok, f: 9 }))).toThrow(/format/)
  expect(() => decodeCode(b64({ ...ok, s: [["r", "x"]] }))).toThrow(/step 1/)
  expect(() => decodeCode("polyrec.!!!")).toThrow(/not a recipe/)
  expect(() => decodeCode("   ")).toThrow(/empty/)
  expect(() => decodeCode(encodeRollCode("ACD", settings(meta)).replace("polyroll.", "polyrec."))).toThrow() // a roll code is not a recipe
  expect(() => decodeCode(encodeRollCode("ACD", settings(meta)).slice(0, -2))).toThrow()
})

test("the same seed at 100% gives the same patch from two different starting patches, every engine, continuous and enum parameters", () => {
  for (const name of ENGINES) {
    const meta = metas[name]
    const startB = applyRoll(meta, meta.init, settings(meta, { seed: 777 })).patch
    expect(startB.values).not.toEqual(meta.init.values)
    const a = applyRoll(meta, meta.init, settings(meta, { seed: 4242 }))
    const b = applyRoll(meta, startB, settings(meta, { seed: 4242 }))
    expect(b.patch.values).toEqual(a.patch.values)
    expect(a.plan.touched).toBeGreaterThan(meta.params.length * 0.5)
    expect(Object.keys(a.plan.values).length - Object.keys(a.plan.positions).length).toBeGreaterThan(0) // enums or switches were drawn too
  }
})

test("the same seed at 30% and 70% goes the same way, 70% simply goes further (continuous and stepped)", () => {
  for (const name of available(["ACD", "PHZ", "FM4", "WTFM", "PERC"])) {
    const meta = metas[name]
    const start = applyRoll(meta, meta.init, settings(meta, { seed: 31 })).patch
    const env = ampEnvelope(meta)
    const guarded = new Set(env ? [env.decay] : []) // the audibility guard may lift a decay on top of the travel
    for (const seed of [1, 2, 3, 4, 5]) {
      const lo = randomize(meta, start, { amount: 0.3, seed }), hi = randomize(meta, start, { amount: 0.7, seed }), full = randomize(meta, start, { amount: 1, seed })
      let moved = 0
      for (const [id, t16] of Object.entries(full.positions) as [string, number][]) {
        if (guarded.has(Number(id))) continue
        const cur = knobOf(meta.params[id], start.values[Number(id)]), a = lo.positions[id] - cur, b = hi.positions[id] - cur, t = t16 - cur
        expect(a * t).toBeGreaterThanOrEqual(0) // toward the target, never away
        expect(b * t).toBeGreaterThanOrEqual(0)
        expect(Math.abs(b)).toBeGreaterThanOrEqual(Math.abs(a))
        expect(Math.abs(t)).toBeGreaterThanOrEqual(Math.abs(b))
        expect(Math.abs(a - t * 0.3)).toBeLessThanOrEqual(1) // whole knob positions: within one of the exact fraction
        expect(Math.abs(b - t * 0.7)).toBeLessThanOrEqual(1)
        if (Math.abs(t) > 650) moved++
      }
      for (const [id, v] of (Object.entries(full.values) as [string, number][]).filter(([id]) => !(id in full.positions))) {
        const cur = start.values[id], a = lo.values[id] - cur, b = hi.values[id] - cur, t = v - cur
        expect(a * t).toBeGreaterThanOrEqual(0)
        expect(b * t).toBeGreaterThanOrEqual(0)
        expect(Math.abs(b)).toBeGreaterThanOrEqual(Math.abs(a)) // one rounding draw per parameter, so a bigger Amount never goes less far
        expect(Math.abs(t)).toBeGreaterThanOrEqual(Math.abs(b))
      }
      expect(moved).toBeGreaterThan(3)
    }
  }
})

test("a parameter's draw does not depend on the others: locks and sections leave every other parameter on its target at any Amount", () => {
  const meta = metas[EX]
  for (const amount of [100, 35]) {
    const all = applyRoll(meta, meta.init, settings(meta, { seed: 8, amount }))
    const some = applyRoll(meta, meta.init, settings(meta, { seed: 8, amount, locks: [0, 5, 9, 12] }))
    all.patch.values.forEach((v: number, id: number) => { if (![0, 5, 9, 12].includes(id)) expect(some.patch.values[id]).toBe(v) })
    const filter = meta.sections.find((s: any) => /filter/i.test(s.name))
    const onlyFilter = applyRoll(meta, meta.init, settings(meta, { seed: 8, amount, sections: [filter.name] }))
    for (const id of filter.params) expect(onlyFilter.patch.values[id]).toBe(all.patch.values[id])
  }
})

test("macro amounts also travel toward a fixed target: 100% is the same from any start", () => {
  const meta = metas[EX]
  const a = randomize(meta, meta.init, { amount: 1, seed: 5, macros: true })
  const other = structuredClone(meta.init)
  other.macros.forEach((m: any) => m.targets.forEach((t: any) => (t.amount = 0.123)))
  const b = randomize(meta, other, { amount: 1, seed: 5, macros: true })
  expect(b.macros).toEqual(a.macros)
  expect(a.macros.length).toBeGreaterThan(3)
  const half = randomize(meta, meta.init, { amount: 0.5, seed: 5, macros: true })
  half.macros.forEach((c: any, i: number) => expect(Math.abs(c.amount - (meta.init.macros[c.macro].targets[c.target].amount + a.macros[i].amount) / 2)).toBeLessThan(0.001))
})

test("the diff of two patch states is a set of values, macros only when they changed", () => {
  const meta = metas.ACD
  const b = structuredClone(meta.init)
  expect(diffEdits(meta.init, b)).toEqual({ values: {}, macros: null })
  b.values[3] = meta.init.values[3] + 1
  b.macros[0].targets[0].amount = 0.5
  const d = diffEdits(meta.init, b)
  expect(d.values).toEqual({ 3: b.values[3] })
  expect(applyEdits(meta.init, d)).toEqual(b)
})

/** What the page does: a history of rolls and manual edits on an engine, from Init or from a loaded patch. */
function build(engine: string, basePatch: any, plan: ({ roll: any } | { edit: Record<number, number> })[]) {
  const meta = metas[engine]
  const hist = createHistory(200)
  hist.reset({ kind: "base", snap: { ...snapOf(basePatch), dirty: false } })
  let patch = structuredClone(basePatch)
  for (const step of plan) {
    if ("roll" in step) {
      const s = settings(meta, step.roll)
      patch = applyRoll(meta, patch, s).patch
      hist.push({ kind: "roll", settings: s, snap: snapOf(patch) })
    } else {
      patch = structuredClone(patch)
      for (const [id, v] of Object.entries(step.edit)) patch.values[id] = v
      hist.push({ kind: "edits", snap: snapOf(patch) })
    }
  }
  return { meta, hist, patch }
}

test("recipe round trip: roll, manual edit, roll (sections, locks, macros) -> text -> replay from Init -> identical patch bytes and the same result hash", async () => {
  for (const engine of available(["ACD", "PHZ", "WTFM", "PERC"])) {
    const meta = metas[engine]
    const sec = sectionNames(meta)
    const { hist, patch } = build(engine, meta.init, [
      { roll: { seed: 11, amount: 40 } },
      { edit: { 0: meta.params[0].min + 1, 2: meta.params[2].min + (meta.params[2].max - meta.params[2].min) * 0.37 } }, // by hand: odd values
      { roll: { seed: 12, amount: 100, macros: true, locks: [1, 3] } },
      { roll: { seed: 13, amount: 65, sections: sec.slice(0, 2), macros: true } },
    ])
    const hash = shortHash(await bytes(patch))
    const text = encodeRecipe(buildRecipe(meta, engine, { kind: "init" }, hist.entries, hist.entries.length - 1, hash))
    expect(text).toMatch(/^polyrec\.[A-Za-z0-9_-]+$/) // text safe to paste anywhere
    expect(text.length).toBeLessThan(1700)
    // a fresh page: only the text and the engine's Init patch
    const code = decodeCode("\n  " + text + "  \n")
    expect(code.type).toBe("recipe")
    if (code.type !== "recipe") throw new Error("type")
    expect(code.engine).toBe(engine)
    expect(code.base).toEqual({ kind: "init" })
    expect(code.hash).toBe(hash)
    expect(code.steps.map((s: any) => s.kind)).toEqual(["roll", "edits", "roll", "roll"])
    const replay = replaySteps(meta, meta.init, code.steps)
    expect(replay.patch).toEqual(patch)
    const replayHex = await bytes(replay.patch)
    expect(replayHex).toBe(await bytes(patch))
    expect(resultWarning(code, replayHex)).toBeNull() // the replay ended in the bytes the recipe says
    expect(replay.entries.length).toBe(4)
    expect(replay.entries[0].settings).toEqual(hist.entries[1].settings)
    // a replay under drifted metadata (a range moved in a newer firmware) ends in other bytes: a warning instead of a silent difference
    const moved = structuredClone(meta)
    const cont = moved.params.findIndex((p: any, i: number) => !p.stepped && !p.names && p.max > p.min && i !== meta.volumeParam && ![1, 3].includes(i))
    moved.params[cont].max = moved.params[cont].min + (moved.params[cont].max - moved.params[cont].min) * 0.8
    const drifted = replaySteps(moved, meta.init, code.steps).patch
    expect(resultWarning(code, await bytes(drifted))).toMatch(/other patch bytes/)
    // a recipe without a hash (an older one) never warns
    expect(resultWarning({ ...code, hash: null }, await bytes(drifted))).toBeNull()
    // a recipe up to an earlier step replays that step
    const upTo2 = decodeCode(encodeRecipe(buildRecipe(meta, engine, { kind: "init" }, hist.entries, 2)))
    if (upTo2.type !== "recipe") throw new Error("type")
    expect(upTo2.hash).toBeNull()
    expect(replaySteps(meta, meta.init, upTo2.steps).patch).toEqual({ ...structuredClone(meta.init), values: hist.entries[2].snap.values, macros: hist.entries[2].snap.macros })
  }
})

test("short hash: FNV-1a 32 over the bytes of the .patch, fixed vectors", () => {
  expect(shortHash("")).toBe("811c9dc5")
  expect(shortHash("61")).toBe("e40c292c") // FNV-1a 32 of the byte 0x61 ("a")
  expect(shortHash("666f6f626172")).toBe("bf9cf968") // "foobar"
})

test("recipe from a loaded patch: the base is its name and the short hash of its bytes, a different patch is detected", async () => {
  const meta = metas.ACD
  const loaded = applyRoll(meta, meta.init, settings(meta, { seed: 90 })).patch // stands for a patch loaded from a file
  const hash = shortHash(await bytes(loaded))
  expect(hash).toMatch(/^[0-9a-f]{8}$/)
  const { hist, patch } = build("ACD", loaded, [{ roll: { seed: 5, amount: 30 } }, { edit: { 4: meta.params[4].max } }, { roll: { seed: 6, amount: 55 } }])
  const code = decodeCode(encodeRecipe(buildRecipe(meta, "ACD", { kind: "patch", name: "My Pad", hash }, hist.entries)))
  if (code.type !== "recipe") throw new Error("type")
  expect(code.base).toEqual({ kind: "patch", name: "My Pad", hash })
  expect(replaySteps(meta, loaded, code.steps).patch).toEqual(patch) // replayed from the same patch: exact
  expect(shortHash(await bytes(meta.init))).not.toBe(hash) // another patch has another hash, the page warns
  expect(shortHash(await bytes(loaded))).toBe(hash) // and the hash is stable
  // a changed base still replays (the steps are applied), it just is not the same sound
  const other = replaySteps(meta, meta.init, code.steps).patch
  expect(other.values).not.toEqual(patch.values)
})

test("a roll code carries one roll: from the same patch it repeats the result, at 100% from any patch", () => {
  const meta = metas[EX]
  const s = settings(meta, { seed: 2024, amount: 100, locks: [3], sections: sectionNames(meta).slice(0, 3), macros: true })
  const code = decodeCode(encodeRollCode(EX, s))
  if (code.type !== "roll") throw new Error("type")
  expect(code.engine).toBe(EX)
  expect(rollSettings(meta, code.settings)).toEqual(s)
  expect(code.settings.algo).toBe(2)
  const direct = applyRoll(meta, meta.init, s), viaCode = applyRoll(meta, meta.init, rollSettings(meta, code.settings))
  expect(viaCode.patch).toEqual(direct.patch)
  const elsewhere = applyRoll(meta, meta.init, settings(meta, { seed: 3 })).patch
  const t = applyRoll(meta, elsewhere, s)
  for (const sec of meta.sections.slice(0, 3)) for (const id of sec.params) if (id !== 3 && !protectedIds(meta).has(id)) expect(t.patch.values[id]).toBe(direct.patch.values[id])
  // partial Amount from the same patch: still exactly repeatable
  const p = settings(meta, { seed: 2024, amount: 45 })
  expect(applyRoll(meta, elsewhere, p).patch).toEqual(applyRoll(meta, elsewhere, p).patch)
})
const protectedIds = (meta: any) => new Set<number>(meta.volumeParam >= 0 ? [meta.volumeParam] : [])

test("applyPlan keeps working with the plan of algorithm 2 (stepped values and knob values together)", () => {
  const meta = metas[EX]
  const plan = randomize(meta, meta.init, { amount: 1, seed: 3 })
  const out = applyPlan(meta.init, plan)
  for (const [id, v] of Object.entries(plan.values)) expect(out.values[id as any]).toBe(v)
})

test("a recipe records the firmware release tag, and a recipe from another release gets a warning that names both versions", async () => {
  const meta = metas.ACD
  const e0 = { kind: "base", snap: snapOf(meta.init) }
  const patch = applyRoll(meta, meta.init, settings(meta, { seed: 7 })).patch
  const entries = [e0, { kind: "roll", settings: settings(meta, { seed: 7 }), snap: snapOf(patch) }]
  const recipe = buildRecipe(meta, "ACD", { kind: "init" }, entries, 1, shortHash(await bytes(patch)), "tracker-ff-v1.1.0")
  expect(recipe.w).toBe("tracker-ff-v1.1.0")
  // without a tag the field is left out, so the recipes of before this field are unchanged byte for byte
  expect("w" in buildRecipe(meta, "ACD", { kind: "init" }, entries, 1, null)).toBe(false)
  const code = decodeCode(encodeRecipe(recipe))
  expect(code.type === "recipe" && code.firmware).toBe("tracker-ff-v1.1.0")
  expect(firmwareWarning(code, "tracker-ff-v1.1.0")).toBeNull()
  const old = decodeCode(b64({ f: 2, e: "ACD", b: { b: "init" }, s: [], w: "tracker-ff-v1.0.0" }))
  const warning = firmwareWarning(old, "tracker-ff-v1.1.0")!
  expect(warning).toContain("made on tracker-ff 1.0.0, you are on tracker-ff 1.1.0")
  expect(firmwareLabel("tracker-ff-v1.1.0")).toBe("tracker-ff 1.1.0")
  // a recipe from before the field has nothing to compare, and a bare or odd tag is shown as it is
  const none = decodeCode(b64({ f: 2, e: "ACD", b: { b: "init" }, s: [] }))
  expect(none.type === "recipe" && none.firmware).toBeNull()
  expect(firmwareWarning(none, "tracker-ff-v1.1.0")).toBeNull()
  expect(firmwareWarning({ firmware: "my-build" }, "tracker-ff-v1.1.0")).toContain("made on my-build, you are on tracker-ff 1.1.0")
})
