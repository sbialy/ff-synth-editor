// A value typed into a parameter's readout, mapped back to the stored value. The readout text comes from the engine's own formatter in the host (Hz, kHz, ms, s,
// %, dB, st, c, L/R pan, names ...), so the one honest inverse is to ask the host: the knob 0..1 -> value + text call (cmd "knob", the firmware edit curve) is
// searched for the position whose text reads as the typed one. The curve of the parameter (linear, power, expSteep, exp) is therefore never re-implemented here.
import { canonNumber, matchName, nextTextPosition, K_STEPS } from "../public/valuefield.js"

type Host = { request<T = any>(req: Record<string, unknown>): Promise<T> }
export type Param = { id: number; name: string; min: number; max: number; curve: string; stepped?: boolean; names?: string[] }
export type Typed = { ok: true; value: number; text: string } | { ok: false; error: string }

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "")

/**
 * The stored value for `text` typed on parameter `p` of `patch`. Numbers are read in the unit of the readout, a plain number in Hz / ms for frequencies and times, in the
 * readout's own unit otherwise. Out of range clamps to the end of the range. Names (enums, switches) match by name or by stored value. Unreadable text is an error.
 */
export async function resolveTyped(host: Host, engine: string, p: Param, text: string, patch: unknown): Promise<Typed> {
  const raw = String(text ?? "").trim()
  if (!raw) return { ok: false, error: "nothing typed" }
  const span = p.max - p.min
  const at = async (knob: number) => host.request<{ value: number; text: string }>({ cmd: "knob", engine, param: p.id, knob, patch })
  const done = async (knob: number, exact?: number): Promise<Typed> => {
    const r = await at(knob)
    return { ok: true, value: exact ?? r.value, text: r.text }
  }
  if (p.names) {
    const i = matchName(p.names, raw, p.min)
    if (i === null) return { ok: false, error: `"${raw}" is not one of ${p.names.join(", ")}` }
    return { ok: true, value: p.min + i, text: p.names[i] }
  }
  const linear = p.curve === "linear"
  // a stepped parameter: whole values, one knob position each
  const stepped = !!p.stepped && linear && span > 0
  const knobOfStep = (v: number) => (v - p.min) / span
  const target = canonNumber(raw)
  if (target === null) {
    // not a number: a readout with words in it (a note name, a wave name). Only a stepped parameter has few enough values to read them all.
    if (!stepped) return { ok: false, error: `cannot read "${raw}" as a number` }
    const want = norm(raw), hits: number[] = []
    let prefix = -1, prefixN = 0
    for (let v = p.min; v <= p.max; v++) {
      const t = norm((await at(knobOfStep(v))).text)
      if (t === want) hits.push(v)
      else if (t.startsWith(want)) { prefix = v; prefixN++ }
    }
    if (hits.length) return done(knobOfStep(hits[0]), hits[0])
    if (prefixN === 1) return done(knobOfStep(prefix), prefix)
    return { ok: false, error: `cannot read "${raw}"` }
  }
  if (Number.isNaN(target)) return { ok: false, error: `cannot read "${raw}" as a number` }
  // The readout as a number, along the positions 0..n. The positions of a stepped parameter are its values, else the 65535 knob steps. A readout is
  // non-decreasing in the position, or non-increasing: the direction is read from the two ends.
  const n = stepped ? Math.round(span) : K_STEPS
  const knob = (i: number) => (stepped ? knobOfStep(p.min + i) : i / K_STEPS)
  const cache = new Map<number, number>()
  const key = async (i: number) => {
    if (cache.has(i)) return cache.get(i)!
    const k = canonNumber((await at(knob(i))).text)
    if (k === null) throw new Error("the readout of this parameter is not a number")
    cache.set(i, k)
    return k
  }
  const sign = (await key(0)) <= (await key(n)) ? 1 : -1
  const f = async (i: number) => sign * (await key(i))
  const t = sign * target
  // the first position that reads at or above the target
  let lo = 0, hi = n
  if ((await f(n)) < t) lo = n
  else while (lo < hi) { const mid = (lo + hi) >> 1; if ((await f(mid)) >= t) hi = mid; else lo = mid + 1 }
  let pick = lo
  if (lo > 0 && (await f(lo)) !== t) { // between two readouts: the nearer one (the lower on a tie)
    if (t - (await f(lo - 1)) <= (await f(lo)) - t) pick = lo - 1
  } else if (!stepped && (await f(lo)) === t) {
    // a plateau of equal readouts (440 Hz is a few hundred knob steps wide): the middle of it, so the stored value is the nearest to what was typed
    let a = lo, b = n
    while (a < b) { const mid = (a + b + 1) >> 1; if ((await f(mid)) <= t) a = mid; else b = mid - 1 }
    pick = (lo + a) >> 1
  }
  if (stepped) return done(knobOfStep(p.min + pick), p.min + pick)
  const r = await at(knob(pick))
  // a non-linear stepped parameter has whole values too
  if (p.stepped) { const v = Math.min(p.max, Math.max(p.min, Math.round(r.value))); return { ok: true, value: v, text: r.text } }
  return { ok: true, value: await tidy(host, engine, p, patch, r.value, r.text), text: r.text }
}

/**
 * The shortest number in the same readout: a knob step lands on 0.349996 for a typed 35 %, 0.35 reads the same and is what one expects in the file. The first
 * rounding (1 to 8 significant digits) that the host reads back as the same text wins, the value itself when none does.
 */
async function tidy(host: Host, engine: string, p: Param, patch: any, value: number, text: string): Promise<number> {
  if (!patch || !Array.isArray(patch.values)) return value
  for (let d = 1; d <= 8; d++) {
    const c = Math.min(p.max, Math.max(p.min, Math.fround(Number(value.toPrecision(d)))))
    const probe = { ...patch, values: patch.values.map((v: number, i: number) => (i === p.id ? c : v)) }
    const r = await host.request<{ texts: string[] }>({ cmd: "describe", engine, patch: probe, macroValues: [] })
    if (r.texts[p.id] === text) return c
  }
  return value
}

// Recent answers of nudgeText. A readout may depend on the other parameters of the patch, so the key holds all their values (this parameter's own value cannot change
// what its knob positions read, it is left out): stepping up and down again on a patch that did not change is a lookup.
const nudgeCache = new Map<string, { pos: number; text: string } | null>()
const NUDGE_CACHE_MAX = 2000

/**
 * The arrow key on a continuous slider: from knob position `pos` (0..65535) the nearest position in direction `dir` whose readout differs (0.1 dB, 1 Hz, 1 ms ...),
 * asked of the host's own readout like a typed value. `shown` is the text on screen. null when the readout cannot change that way (the end of the travel).
 */
export async function nudgeText(host: Host, engine: string, p: Param, pos: number, dir: number, shown: string | undefined, patch: any): Promise<{ pos: number; text: string } | null> {
  const values: unknown[] = Array.isArray(patch?.values) ? patch.values.map((v: number, i: number) => (i === p.id ? 0 : v)) : []
  const key = `${engine}|${p.id}|${pos}|${dir}|${shown ?? ""}|${values.join(",")}`
  if (nudgeCache.has(key)) return nudgeCache.get(key)!
  const textAt = async (i: number) => (await host.request<{ text: string }>({ cmd: "knob", engine, param: p.id, knob: i / K_STEPS, patch })).text
  const r = await nextTextPosition(textAt, pos, dir, K_STEPS, shown)
  if (nudgeCache.size >= NUDGE_CACHE_MAX) nudgeCache.delete(nudgeCache.keys().next().value!)
  nudgeCache.set(key, r)
  return r
}
