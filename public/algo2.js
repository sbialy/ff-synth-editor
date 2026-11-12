// ======================================================================================================================================
// RANDOMIZER ALGORITHM 2 - FROZEN.
//
// THE RULE: once an algorithm version has been released, its code is NEVER edited. Not a fix, not a refactor, not a comment. If the
// result of a seed has to change (a bug, a better curve, a new parameter rule), write algo3.js and add it to ALGORITHMS in
// randomize.js; this file stays callable for every recipe, roll code and seed made with version 2. The same goes for prng.js, seed.js
// and curve.js, which this file builds on. test/frozen-files.test.ts fails when a byte of any of them changes and
// test/randomize-golden.test.ts pins the exact output (the fixtures in test/fixtures/ are NEVER regenerated for an existing version).
// Algorithm 2 was redefined in place once, before it was ever shared. From here on it is frozen.
// ======================================================================================================================================
//
// What it does. The seed decides a fixed TARGET for every parameter, whatever the Amount is:
//   stepped parameter (enum, switch, whole number): a value, every valid value equally likely.
//        count = max - min + 1;  target = min + floor(u32 * count / 2^32),  u32 = the top 32 bits of draw 0 of the parameter's stream
//   continuous parameter: a knob position K in the integer space 0..65535 (K = the top 16 bits of draw 0), so an exponential Hz
//        range is as likely low as high, the way the knob feels. The value is knobValue(param, K) from curve.js (no Math.exp / log /
//        pow anywhere, bit-identical in every JS engine).
//   Every parameter has its own stream draw64(seed, engineId, 1, slot, i) (prng.js, slot = the parameter's slot in the .patch file),
//   so locking a parameter, switching a section off or a future engine version with more or fewer parameters never changes what the
//   others get.
//   Amount (a whole percent A, 0..100) decides how far the patch travels from where it is toward the target, all in integers:
//        continuous  K' = K + roundDiv((target - K) * A, 100),  K = the knob position of the current value (knobOf), roundDiv rounds
//                    half up. A = 100 is the target itself, so the same seed gives the same patch from any start.
//        stepped     r = the top 16 bits of draw 1 of the stream, c = current value - min, t = target - min
//                    value' = min + floor((c * 6553600 + (t - c) * A * 65536 + r * 100) / 6553600)
//                    that is floor(c + (t - c) * A/100 + r/65536): right on average, so a move under half a step still changes the
//                    value now and then and always in the direction of the target, and A = 100 gives t exactly.
//   30% and 70% of one seed go the same way, 70% simply goes further. Amount 0 changes nothing.
// A parameter is left alone when it is locked, when its section is switched off, when it is unused (max <= min) or when it is the
// volume / output level (the engine's volumeParam, or a name that reads like an output level).
// Audibility guard (integer thresholds): the amp attack target is capped at K 29491 (45% of the knob), and an amp envelope that ends
// with a sustain under K 9830 (15%) gets a decay of at least K 26214 (40%).
// Macro assignments (how far each macro moves its targets) only change with the Macros toggle, and then only their amounts, the same
// way: amount target = (2 * m - 65535) / 65535 (m = top 16 bits of draw 0 of stream (engineId, 2, (macro << 16) | target, 0), one
// division, float32), travelling from the current amount's position m0 = round((amount + 1) * 32767.5) by the same roundDiv rule.

import { drawAt, hi16, hi32, KIND_MACRO, KIND_PARAM, stream } from "./prng.js"
import { K_MAX, knobOf, knobValue } from "./curve.js"

export const ALGO_VERSION = 2

/** Section name for parameters that are in none of the engine's sections. */
export const OTHER = "Other"

/** Caps of the audibility guard, as knob positions 0..65535: 45%, 15% and 40% of the knob. */
export const GUARD = { attackMax: 29491, sustainFloor: 9830, decayMin: 26214 }

const OUTPUT_NAME = /^(volume|master( volume| level)?|output( level| volume)?|main( volume| level)?)$/i

/** slot -> parameter. A parameter's slot is its id in the .patch file (meta.params[i].id, the list position only when a meta has no ids). */
export const paramsBySlot = (meta) => new Map(meta.params.map((p, i) => [p.id ?? i, p]))

/** Slots that are never randomized: the engine's Volume and anything named like an output level. */
export function protectedParams(meta) {
  const ids = new Set()
  if (meta.volumeParam >= 0) ids.add(meta.volumeParam)
  for (const [id, p] of paramsBySlot(meta)) if (OUTPUT_NAME.test(p.name)) ids.add(id)
  return ids
}

/** id -> section names that list it (a parameter can sit in two). */
function sectionsOf(meta) {
  const map = new Map()
  for (const s of meta.sections) for (const id of s.params) (map.get(id) ?? map.set(id, []).get(id)).push(s.name)
  return map
}

/**
 * The amplitude envelope of the engine, found by name: the first section called like an amp / loudness / amplifier envelope and
 * its Attack, Decay and Sustain. null when the engine has no such section.
 */
export function ampEnvelope(meta) {
  const sec = meta.sections.find((s) => /amp|loudness/i.test(s.name))
  if (!sec) return null
  const by = paramsBySlot(meta)
  const find = (re) => sec.params.find((id) => by.get(id) && re.test(by.get(id).name))
  const e = { attack: find(/^(a|attack)$/i), decay: find(/^(d|decay)$/i), sustain: find(/^(s|sustain)$/i) }
  return e.attack === undefined && e.sustain === undefined ? null : e
}

const isStepped = (p) => !!p.stepped || !!p.names
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
/** floor(a / b) for whole numbers, b > 0, exact (no division of non-multiples). */
const floorDiv = (a, b) => { const m = ((a % b) + b) % b; return (a - m) / b }
/** a / b rounded to the nearest whole number, halves up. */
const roundDiv = (a, b) => floorDiv(2 * a + b, 2 * b)

/**
 * Plan a roll.
 * @param meta   the engine's /api/meta (engineId, params with id min max curve stepped names def, sections, volumeParam, macros)
 * @param patch  the current patch ({ values, macros })
 * @param opts   { seed (BigInt), percent (whole number 0..100), sections (array of enabled names or null for all), locks (Set or
 *               array of ids), macros (bool) }
 * @returns { algo, seed, percent, values: { id: value } (every parameter the roll moved, as the float32 value), positions:
 *          { id: knob position 0..65535 } (the continuous ones), macros: [{ macro, target, amount }], touched }
 */
export function plan(meta, patch, opts) {
  const percent = clamp(Math.round(opts.percent), 0, 100)
  const seed = opts.seed
  const engineId = meta.engineId ?? 0
  const locks = new Set(opts.locks ?? [])
  const enabled = opts.sections ? new Set(opts.sections) : null
  const prot = protectedParams(meta)
  const secOf = sectionsOf(meta)
  const by = paramsBySlot(meta)
  const out = { algo: ALGO_VERSION, seed, percent, values: {}, positions: {}, macros: [], touched: 0 }
  const allowed = (id) => {
    if (prot.has(id) || locks.has(id)) return false
    if (!enabled) return true
    return (secOf.get(id) ?? [OTHER]).some((s) => enabled.has(s))
  }
  const current = (id, p) => (Number.isFinite(patch.values[id]) ? patch.values[id] : p.def)

  // 1. the targets: one stream per parameter slot, a draw never depends on another parameter, the Amount or the current patch
  const stepped = {}, tk = {}
  for (const [id, p] of by) {
    if (!allowed(id) || !(p.max > p.min)) continue
    const st = stream(seed, engineId, KIND_PARAM, id)
    const d0 = drawAt(st, 0)
    if (isStepped(p)) {
      const lo = Math.ceil(p.min), count = Math.floor(p.max) - lo + 1
      stepped[id] = { lo, count, t: Number((BigInt(hi32(d0)) * BigInt(count)) >> 32n), r: hi16(drawAt(st, 1)) }
    } else tk[id] = hi16(d0)
  }
  // the attack target is capped, a locked or switched off attack is not in tk and so is left alone
  const env = ampEnvelope(meta)
  if (env && env.attack !== undefined && env.attack in tk) tk[env.attack] = Math.min(tk[env.attack], GUARD.attackMax)

  // 2. travel toward them
  if (percent > 0) {
    for (const [id, s] of Object.entries(stepped)) {
      const p = by.get(Number(id))
      const c = clamp(Math.round(current(id, p)), s.lo, s.lo + s.count - 1) - s.lo
      const N = c * 6553600 + (s.t - c) * percent * 65536 + s.r * 100
      out.values[id] = s.lo + clamp(floorDiv(N, 6553600), 0, s.count - 1)
    }
    for (const [id, t] of Object.entries(tk)) {
      const p = by.get(Number(id))
      const c = knobOf(p, current(id, p))
      out.positions[id] = clamp(c + roundDiv((t - c) * percent, 100), 0, K_MAX)
    }
    guardDecay(by, out, env, percent, current)
    for (const [id, k] of Object.entries(out.positions)) out.values[id] = knobValue(by.get(Number(id)), k)
  }

  // 3. macro assignments: only with the toggle. The amount of each existing target moves, the parameters a macro points at never change.
  if (opts.macros && percent > 0) {
    ;(patch.macros ?? []).forEach((mac, m) => {
      const sys = meta.macros?.[m]?.system
      ;(mac.targets ?? []).forEach((t, ti) => {
        if (sys || prot.has(t.param) || locks.has(t.param)) return
        const target = hi16(drawAt(stream(seed, engineId, KIND_MACRO, (m << 16) | ti), 0))
        const c = clamp(Math.round(((Number.isFinite(t.amount) ? t.amount : 0) + 1) * 32767.5), 0, K_MAX)
        const pos = clamp(c + roundDiv((target - c) * percent, 100), 0, K_MAX)
        out.macros.push({ macro: m, target: ti, amount: Math.fround((2 * pos - K_MAX) / K_MAX) })
      })
    })
  }
  out.touched = Object.keys(out.values).length + out.macros.length
  return out
}

// Keep the note audible, part 2 (on the result): an amp envelope that ends up with almost no sustain gets a decay of at least
// GUARD.decayMin so it still rings (at partial Amount the decay travels toward that floor, and is never made shorter than it is).
function guardDecay(by, out, env, percent, current) {
  if (!env) return
  const s = env.sustain, d = env.decay
  if (s === undefined || d === undefined || !(d in out.positions)) return
  const frac = (id) => {
    if (id in out.positions) return out.positions[id]
    const p = by.get(Number(id))
    if (!(p.max > p.min)) return K_MAX
    const v = id in out.values ? out.values[id] : current(id, p)
    return Math.round(((v - p.min) * K_MAX) / (p.max - p.min))
  }
  if (frac(s) >= GUARD.sustainFloor) return
  const c = knobOf(by.get(d), current(d, by.get(d)))
  const need = percent >= 100 ? GUARD.decayMin : c + roundDiv((Math.max(c, GUARD.decayMin) - c) * percent, 100) // 100% is the floor itself, from any start
  out.positions[d] = Math.max(out.positions[d], need)
}
