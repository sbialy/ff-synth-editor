// Typing a value into a slider's readout and stepping a focused slider with the arrow keys.
// The pure part (number and name parsing, step sizes) is shared with the server (server/typed.ts) and tested without a page; the DOM part is the
// small widget app.js hangs on every value text and every range input. Not one of the frozen randomizer files: it does not draw random numbers.

/** Positions of a continuous parameter: the knob 0..1 as the randomizer sees it, 65535 steps (public/curve.js K_MAX). One step is the finest move. */
export const K_STEPS = 65535

const MINUS = /[−–—]/g // a typographic minus is a minus

/**
 * The first number of a readout and what follows it: "440 Hz" -> { num: 440, unit: "hz" }, "-12.5 dB", "35 %", "1,5 kHz", "L12" -> -12, "R5" -> 5,
 * "-inf dB" -> -Infinity. null when the text starts with no number.
 */
export function parseNumber(str) {
  let s = String(str ?? "").replace(MINUS, "-").trim()
  if (!s) return null
  const inf = /^([+-]?)\s*inf(?:inity)?\b\s*(.*)$/i.exec(s)
  if (inf) return { num: inf[1] === "-" ? -Infinity : Infinity, unit: inf[2].trim().toLowerCase() }
  let side = 0
  const lr = /^([lr])\s*(\d.*|[.,]\d.*)$/i.exec(s) // the pan readout: L12 is -12, R5 is 5
  if (lr) { side = lr[1].toLowerCase() === "l" ? -1 : 1; s = lr[2] }
  const m = /^([+-]?)\s*(\d+(?:[.,]\d+)?|[.,]\d+)\s*(.*)$/.exec(s)
  if (!m) return null
  let num = parseFloat(m[2].replace(",", "."))
  if (m[1] === "-") num = -num
  if (side) num = side * Math.abs(num)
  return { num, unit: m[3].trim().toLowerCase() }
}

/**
 * A readout as a number in a fixed base unit, so that "1.20 kHz" and "800 Hz" compare: frequencies in Hz, times in ms, everything else as it is. A plain number is
 * in the base unit (Hz, ms). null when there is no number.
 */
export function canonNumber(str) {
  const p = parseNumber(str)
  if (!p) return null
  const u = p.unit.replace(/\.$/, "")
  if (u === "khz" || u === "k") return p.num * 1000
  if (u === "s" || u === "sec" || u === "secs") return p.num * 1000
  return p.num
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim()

/**
 * The index of the name that a typed text means: the whole name (any case, spaces folded), else a plain number that is a stored value (base = the value of the first name),
 * else the only name that starts with the text. null when none or several do.
 */
export function matchName(names, str, base = 0) {
  const t = norm(str)
  if (!t) return null
  const exact = names.findIndex((n) => norm(n) === t)
  if (exact >= 0) return exact
  if (/^[+-]?\d+$/.test(t)) { const i = Number(t) - base; return i >= 0 && i < names.length ? i : null }
  const starts = names.map((n, i) => (norm(n).startsWith(t) ? i : -1)).filter((i) => i >= 0)
  return starts.length === 1 ? starts[0] : null
}

/** A number with at most `decimals` decimals and no trailing zeros: 49.606299 -> "49.6". */
export const fmtNum = (v, decimals = 1) => String(Number(Number(v).toFixed(decimals)))

/**
 * The macro readout. A macro is a 0..100 % position, not a parameter, so the host has no text for it: this is its one format, one decimal. Neutral bipolar macros
 * (CC 63 of 127 = 49.606...) and MIDI controllers (cc * 100 / 127) land on values with many digits, the stored value keeps them, the readout never shows them.
 */
export const MACRO_DECIMALS = 1
export const macroText = (v) => `${fmtNum(v, MACRO_DECIMALS)} %`

/** Steps between the two ends of a slider: 65535 for a continuous one, the count of values less one for a stepped one. */
export const stepsOf = (p) => (p.names ? p.names.length - 1 : p.stepped ? Math.round(p.max - p.min) : K_STEPS)

/** The coarse arrow step (Shift) in positions: 1/100 of the travel when there are plenty of positions, else 10 (but at most a quarter of the travel, at least 1). */
export const coarseOf = (steps) => (steps >= 1000 ? Math.round(steps / 100) : Math.min(10, Math.max(1, Math.floor(steps / 4))))

/** The page step (PageUp, PageDown): a tenth of the travel, not less than the coarse step. */
export const pageOf = (steps) => Math.max(coarseOf(steps), Math.round(steps / 10))

/** A position moved by one key press. dir is +1 or -1, size is "fine" (the smallest step), "coarse" or "page". Stays between 0 and steps. */
export function movePosition(pos, dir, steps, size = "fine") {
  const by = size === "page" ? pageOf(steps) : size === "coarse" ? coarseOf(steps) : 1
  return Math.min(steps, Math.max(0, Math.round(pos) + dir * by))
}

/**
 * The smallest move from knob position `pos` in direction `dir` (+1 up, -1 down) that changes the readout text, for a continuous slider whose 65535 positions
 * are finer than its readout (0.1 dB, 1 Hz, 1 ms ...). `textAt(i)` is the readout text of position i (sync or a promise), `steps` the last position. `avoid` is a
 * text that must not be landed on either (the one on screen, when the position reads otherwise because the stored value sits between two positions).
 * Resolves { pos, text } of the first position that reads differently, or null when none does up to the end of the travel. A readout is monotone in the
 * position, so it gallops away from `pos` (1, 2, 4 ... positions) and then halves the gap: about 2 log2(gap) reads, a plateau of a few hundred positions is ~20.
 */
export async function nextTextPosition(textAt, pos, dir, steps, avoid) {
  pos = Math.min(steps, Math.max(0, Math.round(pos)))
  const limit = dir > 0 ? steps : 0
  if (pos === limit) return null
  const t0 = await textAt(pos)
  const memo = new Map([[pos, t0]])
  const read = async (i) => { if (!memo.has(i)) memo.set(i, await textAt(i)); return memo.get(i) }
  const differs = async (i) => { const t = await read(i); return t !== t0 && t !== avoid }
  let same = pos, far = null
  for (let d = 1; ; d *= 2) {
    const j = dir > 0 ? Math.min(limit, pos + d) : Math.max(limit, pos - d)
    if (await differs(j)) { far = j; break }
    same = j
    if (j === limit) return null
  }
  while (Math.abs(far - same) > 1) {
    const mid = same + Math.trunc((far - same) / 2)
    if (await differs(mid)) far = mid; else same = mid
  }
  return { pos: far, text: await read(far) }
}

/** The slider value that is `dir` presses away, on the slider's own step grid (the step attribute, else 1/65535 of the travel). */
export function nativeNudge(min, max, step, value, dir, size = "fine") {
  const st = step > 0 ? step : (max - min) / K_STEPS
  const steps = Math.max(1, Math.round((max - min) / st))
  const i = movePosition((value - min) / st, dir, steps, size)
  return Math.min(max, Math.max(min, Number((min + i * st).toPrecision(12))))
}

/** A typed number on a slider's own grid: clamped to the range, rounded to the step. */
export function snapToGrid(min, max, step, v) {
  const x = Math.min(max, Math.max(min, v))
  return step > 0 ? Math.min(max, Math.max(min, Number((min + Math.round((x - min) / step) * step).toPrecision(12)))) : x
}

/** A typed text on a plain numeric readout (insert and FX parameters, Tempo, macros, Amount): the number, in the readout's unit. null when unreadable. */
export function parsePlain(str, { min, max, step = 0, unit = "" }) {
  const p = parseNumber(str)
  if (!p || Number.isNaN(p.num)) return null
  // a Hz or ms readout also reads "5 kHz" and "1.5 s"
  const num = unit === "Hz" || unit === "ms" ? canonNumber(str) : p.num
  if (!Number.isFinite(num)) return num < 0 ? min : max
  return snapToGrid(min, max, step, num)
}

/** The value of a table driven readout in dB (the Delay and Reverb Send and Level, the Limiter Threshold): `gain(v)` is the linear gain of value v in 0..max. */
export function dbOf(gain, v) { const g = gain(v); return g > 0 ? 20 * Math.log10(g) : -Infinity }
export function parseDb(str, { min, max }, gain) {
  const p = parseNumber(str)
  if (!p || (p.unit && p.unit !== "db")) return null
  let best = min, bestD = Infinity
  for (let v = min; v <= max; v++) {
    const d = dbOf(gain, v), dist = d === p.num ? 0 : Number.isFinite(d) && Number.isFinite(p.num) ? Math.abs(d - p.num) : Infinity
    if (dist < bestD) { best = v; bestD = dist }
  }
  return bestD === Infinity ? (p.num === -Infinity ? min : null) : best
}

/** The limiter times are shown as value / 1000 s: a typed "0.512", "0.512 s" or "512 ms" is the value 512. */
export function parseMilli(str, { min, max, step = 0 }) {
  const p = parseNumber(str)
  if (!p || !Number.isFinite(p.num)) return null
  const x = p.unit === "ms" ? p.num : p.num * 1000
  return snapToGrid(min, max, step, x)
}

/**
 * MIX slot knobs (a layout knob { kind: lin | exp | int | enum, lo, hi, unit, names }): the knob value 0..1 for a typed readout, the inverse of the page's knobText.
 * A percent readout is typed as percent, a Hz readout in Hz (or kHz). null when unreadable. Out of range clamps.
 */
export function parseSlotKnob(q, str) {
  const clamp01 = (n) => Math.min(1, Math.max(0, n))
  if (q.kind === "enum") {
    const i = matchName(q.names, str, 0)
    return i === null ? null : q.names.length > 1 ? i / (q.names.length - 1) : 0
  }
  const p = parseNumber(str)
  if (!p || Number.isNaN(p.num)) return null
  let v = q.unit === "pct" ? p.num / 100 : q.unit === "hz" ? canonNumber(str) : p.num
  if (!Number.isFinite(v)) return v < 0 ? 0 : 1
  if (q.kind === "int") v = Math.round(v)
  if (q.kind === "exp") return v > 0 ? clamp01(Math.log(v / q.lo) / Math.log(q.hi / q.lo)) : 0
  return q.hi > q.lo ? clamp01((v - q.lo) / (q.hi - q.lo)) : 0
}
/** Positions between the ends of a slot knob: whole steps for int and enum, else the 65535 of any continuous knob. */
export const slotKnobSteps = (q) => (q.kind === "int" ? Math.round(q.hi - q.lo) : q.kind === "enum" ? q.names.length - 1 : K_STEPS)

// ---- DOM

const NON_TEXT_INPUTS = new Set(["range", "checkbox", "radio", "button", "submit", "reset", "color", "file", "image"])
/**
 * Is `el` somewhere characters are typed (a text, number or search field, a text area, content editable)? Only there the computer keys are text and not notes.
 * A slider, a checkbox, a button, a select or a readout that is not being edited is not: the note keys play with the focus on them.
 */
export function isTypingTarget(el) {
  if (!el) return false
  if (el.tagName === "TEXTAREA" || el.isContentEditable) return true
  return el.tagName === "INPUT" && !NON_TEXT_INPUTS.has(el.type)
}

const ARROWS = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 1, PageDown: -1 }

/**
 * Arrow keys on a focused range input. `move(dir, size)` does the work ("fine": the smallest step, "coarse": Shift, "page": PageUp / PageDown). The key is
 * consumed here: it does not scroll the page, and no global shortcut or note key sees it.
 */
export function attachArrows(input, move) {
  input.addEventListener("keydown", (e) => {
    const dir = ARROWS[e.key]
    if (!dir || e.ctrlKey || e.metaKey || e.altKey) return
    e.preventDefault(); e.stopPropagation()
    move(dir, e.key.startsWith("Page") ? "page" : e.shiftKey ? "coarse" : "fine")
  })
}

/** Arrow keys for a range input that is a plain number (its step attribute is the finest move): the value moves and the usual "input" event follows. */
export function attachNativeArrows(input) {
  attachArrows(input, (dir, size) => {
    const v = nativeNudge(Number(input.min), Number(input.max), Number(input.step) || 0, Number(input.value), dir, size)
    if (v === Number(input.value)) return
    input.value = String(v)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

/**
 * Makes a readout editable. A click (or Enter / F2 with the readout focused) turns it into a text field holding the shown text. Enter or leaving the field commits,
 * Escape cancels. `o.text()` is the text to start from, `o.commit(text)` applies it and resolves true when it did (anything else, or a throw, puts the old
 * readout back and says why through `o.fail`). The readout carries data-editing while the field is open: the page must not repaint it then.
 */
export function attachValueEdit(val, o) {
  val.tabIndex = 0
  val.classList.add("editable")
  val.setAttribute("role", "button")
  let field = null
  const open = () => {
    if (field || val.classList.contains("disabled")) return
    const saved = val.innerHTML
    field = document.createElement("input")
    field.type = "text"; field.className = "valedit"; field.value = o.text(); field.spellcheck = false; field.autocomplete = "off"
    field.setAttribute("aria-label", o.label ?? "Value")
    val.dataset.editing = "1"
    val.replaceChildren(field)
    field.focus(); field.select()
    let done = false
    const leave = () => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur() }
    const close = async (commit) => {
      if (done) return
      done = true
      const text = field.value
      field = null
      delete val.dataset.editing
      val.innerHTML = saved
      if (!commit || text.trim() === "") return
      try {
        const ok = await o.commit(text)
        if (ok !== true) o.fail?.(typeof ok === "string" ? ok : `Cannot read "${text}"`)
      } catch (e) { o.fail?.(String(e?.message ?? e)) }
    }
    field.addEventListener("keydown", (e) => {
      e.stopPropagation() // no note key, no undo of the page, no roll: the field is a text field
      // Enter and Escape let go of the focus altogether: the computer keys play notes again at once
      if (e.key === "Enter") { e.preventDefault(); close(true); leave() }
      else if (e.key === "Escape") { e.preventDefault(); close(false); leave() }
    })
    field.addEventListener("blur", () => close(true))
  }
  val.addEventListener("click", open)
  val.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === "F2") && e.target === val) { e.preventDefault(); e.stopPropagation(); open() } })
  return { open }
}
