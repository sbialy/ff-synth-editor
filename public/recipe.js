// Recipes and roll codes: a short text that replays a sound exactly (tested by test/recipe.test.ts, test/randomize-golden.test.ts, used
// by the page).
//
// A roll code (polyroll.<base64url JSON>) is one roll: engine and the settings of the roll (seed, Amount, sections, locks, Macros). The
// seed is a versioned seed code ("2-0123-4567-89AB-CD", public/seed.js): its first symbol is the randomizer algorithm version, so the
// code says by itself which frozen algorithm replays it. It gives the same result as the original from the same starting patch, and
// from any start at Amount 100%.
// A recipe (polyrec.<base64url JSON>) is the whole way from a base to the current step, so it gives the same patch bytes from
// nothing but the base:
//   { f: 2, e: "ACD", b: { b: "init" } | { b: "patch", n: "name", h: "8 hex" }, s: [step, ...], h: "8 hex", w: "tracker-ff-v1.1.0" }
//   f format version, e engine, b base: Init, or a loaded patch by name and the short hash of its encoded bytes, s the steps in order,
//   h the short hash of the patch bytes the recipe ends in (shortHash below): a replay that ends in other bytes (the engine's metadata
//   changed, a range moved in a newer firmware) is shown as a warning instead of silently giving another sound,
//   w the firmware release tag the editor matched when the recipe was made (vendor/FIRMWARE.json). A recipe made on another tag gets a
//   warning that names both ("made on tracker-ff 1.0.0, you are on tracker-ff 1.1.0", firmwareWarning below). Optional: a recipe from
//   before this field, or with a bare tag it does not know, just has no firmware to compare. Steps:
//     ["r", "2-0123-4567-89AB-CD", amountPercent, sections | 0, [locked ids], macros 0 | 1]    a roll (sections 0 = all of them)
//     ["e", { "id": value, ... }, macros | 0]                                                  manual edits, written as parameter sets
//                                                                                              (macros only when they changed: the whole list)
// The roll steps are replayed through the same functions the page uses (applyRoll), the edit steps are plain sets, so the replay
// does not depend on how the original was reached. Format 1 (the numeric seeds of the first round) was never shared and is not read.
import { randomize, applyPlan, ALGO, ALGORITHMS, sectionNames, unknownAlgo } from "./randomize.js"
import { formatSeed, parseSeedCode, toSeed } from "./seed.js"

export const RECIPE_FORMAT = 2
export const RECIPE_PREFIX = "polyrec."
export const ROLL_PREFIX = "polyroll."

// ---- text encoding
const toB64Url = (text) => {
  const bytes = new TextEncoder().encode(text)
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
const fromB64Url = (b64) => {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

/**
 * The short hash of a patch: FNV-1a 32 bit over the bytes of its .patch encoding (given as hex, the host's /api/encode), as 8 hex
 * digits: h = 0x811c9dc5, for each byte h = (h XOR byte) * 0x01000193 mod 2^32.
 */
export function shortHash(hex) {
  let h = 0x811c9dc5
  for (let i = 0; i + 1 < hex.length; i += 2) h = Math.imul(h ^ parseInt(hex.slice(i, i + 2), 16), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, "0")
}

/** "tracker-ff-v1.1.0" -> "tracker-ff 1.1.0" (anything else is shown as it is) */
export const firmwareLabel = (tag) => String(tag).replace(/^tracker-ff-v(?=\d)/, "tracker-ff ")

/** null when the recipe was made on the firmware tag the editor matches now (or does not say), else a warning that names both versions. */
export function firmwareWarning(code, currentTag) {
  if (!code.firmware || !currentTag || code.firmware === currentTag) return null
  return `Warning: made on ${firmwareLabel(code.firmware)}, you are on ${firmwareLabel(currentTag)}. Engines, parameter ranges, curves or macros can differ between the two firmware releases, so the sound may differ.`
}

/** null when the patch bytes (hex) are the ones the recipe ended in, else a warning for the status line. */
export function resultWarning(code, hex) {
  if (!code.hash || shortHash(hex) === code.hash) return null
  return `Warning: the replay ends in other patch bytes than the recipe was made with (hash ${shortHash(hex)}, the recipe says ${code.hash}). The engine's parameter ranges or this editor changed since, so the sound may differ.`
}

// ---- roll settings
/**
 * Normalise the settings of a roll: seed as a BigInt, the algorithm version, Amount as a whole percent, sections null when all are
 * on, locks sorted ids.
 * @param s { seed (BigInt, number or seed code), algo, amount (percent), sections (array of enabled names or null), locks (array/Set), macros }
 */
export function rollSettings(meta, s) {
  const names = sectionNames(meta)
  const on = s.sections ? names.filter((n) => s.sections.includes(n)) : names
  return {
    seed: toSeed(s.seed ?? 0),
    algo: s.algo ?? ALGO,
    amount: Math.min(100, Math.max(0, Math.round(Number(s.amount)))),
    sections: on.length === names.length ? null : on,
    locks: [...new Set(s.locks ?? [])].map(Number).sort((a, b) => a - b),
    macros: !!s.macros,
  }
}

/** One line for the history panel. */
export function describeSettings(meta, s) {
  const names = sectionNames(meta)
  const secs = s.sections === null || s.sections === undefined ? "all sections" : s.sections.length === 0 ? "no section" : s.sections.length <= 2 ? s.sections.join(" + ") : `${s.sections.length} of ${names.length} sections`
  return `seed ${formatSeed(s.seed, s.algo)} \u00b7 ${s.amount}% \u00b7 ${secs}${s.locks.length ? ` \u00b7 ${s.locks.length} locked` : ""}${s.macros ? " \u00b7 macros" : ""}`
}

/**
 * Roll once and return the new patch (synchronous, no host: the knob curves are the frozen ones of public/curve.js).
 * @returns { plan, patch }
 */
export function applyRoll(meta, patch, settings) {
  const plan = randomize(meta, patch, { algo: settings.algo, percent: settings.amount, seed: settings.seed, sections: settings.sections ?? undefined, locks: settings.locks, macros: settings.macros })
  return { plan, patch: applyPlan(patch, plan) }
}

/** The manual edits between two patch states as a step: the values that differ, and the macros when they differ. */
export function diffEdits(before, after) {
  const values = {}
  after.values.forEach((v, i) => { if (!Object.is(v, before.values[i])) values[i] = v })
  const macros = JSON.stringify(after.macros ?? []) !== JSON.stringify(before.macros ?? []) ? structuredClone(after.macros ?? []) : null
  return { values, macros }
}

/** Apply edit sets to a patch. Returns a new patch. */
export function applyEdits(patch, edits) {
  const out = structuredClone(patch)
  for (const [id, v] of Object.entries(edits.values ?? {})) out.values[id] = v
  if (edits.macros) out.macros = structuredClone(edits.macros)
  return out
}

// ---- building and reading codes
const rollStep = (s) => ["r", formatSeed(s.seed, s.algo), s.amount, s.sections === null || s.sections === undefined ? 0 : s.sections, s.locks, s.macros ? 1 : 0]

/**
 * The recipe object up to and including entry `upTo` of a history (entries as in createHistory: entries[0] is the base).
 * @param base { kind: "init" } | { kind: "patch", name, hash }
 * @param hash the short hash of the patch bytes of entry `upTo` (the caller encodes the patch through the host), left out when null
 * @param firmwareTag the firmware release tag the editor matches (vendor/FIRMWARE.json), left out when null
 */
export function buildRecipe(meta, engine, base, entries, upTo = entries.length - 1, hash = null, firmwareTag = null) {
  const steps = []
  for (let i = 1; i <= upTo; i++) {
    const e = entries[i]
    if (e.kind === "roll") steps.push(rollStep(e.settings))
    else {
      const d = diffEdits(entries[i - 1].snap, e.snap)
      steps.push(["e", d.values, d.macros ?? 0])
    }
  }
  const recipe = { f: RECIPE_FORMAT, e: engine, b: base.kind === "patch" ? { b: "patch", n: base.name, h: base.hash } : { b: "init" }, s: steps }
  if (hash) recipe.h = hash
  if (firmwareTag) recipe.w = firmwareTag
  return recipe
}

export const encodeRecipe = (recipe) => RECIPE_PREFIX + toB64Url(JSON.stringify(recipe))

/** The roll code of one roll (a history entry's settings). */
export const encodeRollCode = (engine, settings) => ROLL_PREFIX + toB64Url(JSON.stringify({ f: RECIPE_FORMAT, e: engine, r: rollStep(settings) }))

const stepError = (i, what) => new Error(i < 0 ? `the roll code is ${what}` : `step ${i + 1} is ${what}`)
function readSettings(step, i) {
  if (!Array.isArray(step) || step[0] !== "r" || typeof step[1] !== "string" || typeof step[2] !== "number" || !Array.isArray(step[4]) || !step[4].every(Number.isInteger) || (step[3] !== 0 && !(Array.isArray(step[3]) && step[3].every((x) => typeof x === "string")))) throw stepError(i, "not a roll")
  let code
  try { code = parseSeedCode(step[1]) } catch (e) { throw new Error(`${i < 0 ? "the roll code" : `step ${i + 1}`}: ${e.message}`) }
  if (code.algo === null) throw stepError(i, "a roll whose seed has no algorithm version")
  if (!ALGORITHMS[code.algo]) throw new Error(`${i < 0 ? "the roll code" : `step ${i + 1}`} uses ${unknownAlgo(code.algo)}`)
  return { seed: code.seed, algo: code.algo, amount: Math.min(100, Math.max(0, step[2])), sections: step[3] === 0 ? null : step[3], locks: step[4], macros: !!step[5] }
}
function readEdits(step, i) {
  if (!Array.isArray(step) || step[0] !== "e" || typeof step[1] !== "object" || step[1] === null) throw stepError(i, "not an edit")
  for (const [id, v] of Object.entries(step[1])) if (!/^\d+$/.test(id) || typeof v !== "number") throw stepError(i, "an edit with a bad value")
  if (step[2] !== 0 && !Array.isArray(step[2])) throw stepError(i, "an edit with bad macros")
  return { values: step[1], macros: step[2] === 0 ? null : step[2] }
}

/**
 * Parse pasted text (a recipe or a roll code, whitespace and a missing prefix tolerated for recipes).
 * @returns { type: "recipe", engine, base, hash, firmware (tag or null), steps: [{ kind: "roll", settings } | { kind: "edits", values, macros }] } or { type: "roll", engine, settings }
 * @throws Error with a message fit for the status line
 */
export function decodeCode(text) {
  const t = String(text ?? "").replace(/\s+/g, "")
  if (!t) throw new Error("nothing to paste: the field is empty")
  const isRoll = t.startsWith(ROLL_PREFIX)
  let obj
  try { obj = JSON.parse(fromB64Url(isRoll ? t.slice(ROLL_PREFIX.length) : t.startsWith(RECIPE_PREFIX) ? t.slice(RECIPE_PREFIX.length) : t)) }
  catch { throw new Error("this is not a recipe or roll code (it should start with polyrec. or polyroll.)") }
  if (!obj || typeof obj !== "object" || typeof obj.e !== "string") throw new Error("this is not a recipe or roll code")
  if (obj.f !== RECIPE_FORMAT) throw new Error(`the code format is version ${obj.f}, this editor reads version ${RECIPE_FORMAT}`)
  if (isRoll) return { type: "roll", engine: obj.e, settings: readSettings(obj.r, -1) }
  if (!Array.isArray(obj.s)) throw new Error("the recipe has no steps")
  const base = obj.b?.b === "patch" && typeof obj.b.n === "string" ? { kind: "patch", name: obj.b.n, hash: String(obj.b.h ?? "") } : { kind: "init" }
  const steps = obj.s.map((s, i) => (s?.[0] === "e" ? { kind: "edits", ...readEdits(s, i) } : { kind: "roll", settings: readSettings(s, i) }))
  return { type: "recipe", engine: obj.e, base, hash: typeof obj.h === "string" ? obj.h : null, firmware: typeof obj.w === "string" ? obj.w : null, steps }
}

/**
 * Replay recipe steps from a base patch (synchronous, no host).
 * @returns the entries after the base: [{ kind, snap: { values, macros, dirty: true }, settings? }] and the final patch.
 */
export function replaySteps(meta, basePatch, steps) {
  let patch = structuredClone(basePatch)
  const out = []
  for (const step of steps) {
    if (step.kind === "roll") {
      patch = applyRoll(meta, patch, step.settings).patch
      out.push({ kind: "roll", settings: rollSettings(meta, step.settings), snap: { values: [...patch.values], macros: structuredClone(patch.macros ?? []), dirty: true } })
    } else {
      patch = applyEdits(patch, step)
      out.push({ kind: "edits", snap: { values: [...patch.values], macros: structuredClone(patch.macros ?? []), dirty: true } })
    }
  }
  return { entries: out, patch }
}
