// Patch randomizer: pure functions, no DOM, no network and no host, so bun can test them (test/randomize.test.ts) and the page
// imports the same files.
//
// VERSION LOCK. What a seed means is frozen per algorithm version: algo2.js (with prng.js, seed.js and curve.js under it) is never
// edited once released, see the rule at the top of algo2.js. A change to what a seed produces is a NEW file (algo3.js) registered in
// ALGORITHMS below, ALGO is moved to it, and version 2 stays callable for every old seed, recipe and roll code.
// This file is the part that may change: the dispatcher, the section list for the toggles, the history list.
import * as algo2 from "./algo2.js"
import { newSeed, toSeed } from "./seed.js"

export { parseSeed, newSeed, formatSeed, parseSeedCode, toSeed, fnv1a64 } from "./seed.js"
export { OTHER, GUARD, protectedParams, ampEnvelope } from "./algo2.js"

/** The algorithm versions this editor can replay. Add a version here, never change one that has been released. */
export const ALGORITHMS = { 2: algo2 }
/** The version a new roll uses. */
export const ALGO = 2

/** Section list for the toggles: the engine's own sections, plus "Other" when some parameters are in none of them. */
export function sectionNames(meta) {
  const names = meta.sections.map((s) => s.name)
  const inSection = new Set(meta.sections.flatMap((s) => s.params))
  return meta.params.some((_, id) => !inSection.has(id)) ? [...names, algo2.OTHER] : names
}

/** Message for a version this editor has no code for. */
export const unknownAlgo = (a) => `randomizer algorithm ${a} is not in this editor (it has ${Object.keys(ALGORITHMS).join(", ")}): replaying it would give a different sound, so it is refused`

/**
 * Plan a roll. Pure and synchronous: a roll needs nothing from the host.
 * @param meta   the engine's /api/meta
 * @param patch  the current patch ({values, macros})
 * @param opts   { algo (default ALGO), amount 0..1 or percent 0..100, seed (BigInt, number or seed code; default a new one), sections
 *               (array of enabled names, default all), locks (Set or array of ids), macros (bool) }
 * @returns { algo, seed, percent, amount (0..1), values: {id: value}, positions: {id: knob 0..65535}, macros: [{macro, target, amount}], touched }
 */
export function randomize(meta, patch, opts = {}) {
  const algo = opts.algo ?? ALGO
  const impl = ALGORITHMS[algo]
  if (!impl) throw new Error(unknownAlgo(algo))
  const percent = opts.percent !== undefined ? opts.percent : Math.round((Number.isFinite(opts.amount) ? opts.amount : 1) * 100)
  const plan = impl.plan(meta, patch, { seed: opts.seed === undefined ? newSeed() : toSeed(opts.seed), percent, sections: opts.sections ?? null, locks: opts.locks, macros: opts.macros })
  plan.amount = plan.percent / 100
  return plan
}

/** Apply a plan to a patch. Returns a new patch. */
export function applyPlan(patch, plan) {
  const out = structuredClone(patch)
  for (const [id, v] of Object.entries(plan.values)) out.values[id] = v
  for (const c of plan.macros) if (out.macros?.[c.macro]?.targets?.[c.target]) out.macros[c.macro].targets[c.target].amount = c.amount
  return out
}

/**
 * The step list of a patch: entries[0] is the base (Init or a loaded patch), then one entry per roll or batch of manual edits, up
 * to `limit` entries. `index` is the current one. An entry is { kind: "base" | "roll" | "edits", snap, settings?, ... }, snap is
 * the patch state AFTER that step, settings what the roll used (seed, amount, sections, locks, macros).
 * push() after going back drops the forward tail. When the cap is hit the oldest step is dropped and the one after it becomes an
 * "edits" step (a jump from the base to its state), so a recipe built from the list still replays exactly.
 */
export function createHistory(limit = 200) {
  const entries = []
  let index = -1
  const h = {
    reset(base) { entries.length = 0; entries.push(base); index = 0 },
    push(entry) {
      entries.length = index + 1
      entries.push(entry)
      if (entries.length > limit) {
        entries.splice(1, 1)
        entries[1] = { kind: "edits", snap: entries[1].snap, collapsed: true }
      }
      index = entries.length - 1
      return entry
    },
    /** Replace the current entry (manual edits are merged into one step) and drop what came after it. */
    replaceCurrent(entry) { entries.length = index + 1; entries[index] = entry },
    goto(i) { if (!(i >= 0 && i < entries.length)) return undefined; index = i; return entries[i] },
    undo() { return index > 0 ? h.goto(index - 1) : undefined },
    redo() { return index < entries.length - 1 ? h.goto(index + 1) : undefined },
    clear() { entries.length = 0; index = -1 },
    get entries() { return entries },
    get index() { return index },
    get current() { return entries[index] },
    get undoCount() { return Math.max(0, index) },
    get redoCount() { return Math.max(0, entries.length - 1 - index) },
  }
  return h
}

/** Peak of a render below this is silence: the patch is kept, the page shows a hint (no retry loop). */
export const SILENT_PEAK = 0.002
