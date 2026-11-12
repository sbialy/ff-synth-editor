// Typing into a readout and the arrow steps (public/valuefield.js): the number and name parsing, the finest and the coarse step of every kind of slider,
// and the read-back of what the page shows (insert / FX / limiter / MIX slot readouts) through its own format.
import { expect, test } from "bun:test"
import { filterNames } from "../public/combobox.js"
import { K_STEPS, isTypingTarget, fmtNum, macroText, MACRO_DECIMALS, canonNumber, coarseOf, dbOf, matchName, movePosition, nextTextPosition, nativeNudge, pageOf, parseDb, parseMilli, parseNumber, parsePlain, parseSlotKnob, slotKnobSteps, snapToGrid, stepsOf } from "../public/valuefield.js"
import { knobOf, knobValue } from "../public/curve.js"
import { limiter as LIMITER, sends as SENDS } from "../public/fx-tables.js"
import { FX_PARAMS, LIMITER_PARAMS } from "../public/inserts.js"

test("parseNumber reads the shown unit forms", () => {
  expect(parseNumber("440 Hz")).toEqual({ num: 440, unit: "hz" })
  expect(parseNumber("  -12.5dB ")).toEqual({ num: -12.5, unit: "db" })
  expect(parseNumber("35 %")).toEqual({ num: 35, unit: "%" })
  expect(parseNumber("1,5 kHz")).toEqual({ num: 1.5, unit: "khz" })
  expect(parseNumber("−12 st")).toEqual({ num: -12, unit: "st" })
  expect(parseNumber("L12")?.num).toBe(-12)
  expect(parseNumber("R5")?.num).toBe(5)
  expect(parseNumber("-inf dB")?.num).toBe(-Infinity)
  expect(parseNumber(".5")?.num).toBe(0.5)
  expect(parseNumber("")).toBeNull()
  expect(parseNumber("abc")).toBeNull()
})

test("canonNumber puts frequencies in Hz and times in ms, a plain number is in the base unit", () => {
  expect(canonNumber("1.20 kHz")).toBe(1200)
  expect(canonNumber("800 Hz")).toBe(800)
  expect(canonNumber("800")).toBe(800)
  expect(canonNumber("1.25 s")).toBe(1250)
  expect(canonNumber("156 ms")).toBe(156)
  expect(canonNumber("35%")).toBe(35)
  expect(canonNumber("nope")).toBeNull()
})

test("matchName: the whole name, a stored value, a unique prefix", () => {
  const names = ["Sine", "Saw", "Square", "Noise"]
  expect(matchName(names, "square")).toBe(2)
  expect(matchName(names, "  NOISE ")).toBe(3)
  expect(matchName(names, "1")).toBe(1)
  expect(matchName(names, "4")).toBeNull()
  expect(matchName(names, "n")).toBe(3)
  expect(matchName(names, "s")).toBeNull() // Sine, Saw and Square
  expect(matchName(names, "sq")).toBe(2)
  expect(matchName(["Off", "On"], "1", 0)).toBe(1)
  expect(matchName(["A", "B", "C"], "6", 5)).toBe(1) // a value counts from the first name's value
  expect(matchName(names, "")).toBeNull()
})

test("the smallest step: one knob position for a continuous parameter, one value for a stepped one, one name for an enum", () => {
  expect(stepsOf({ min: 20, max: 20000 })).toBe(K_STEPS)
  expect(stepsOf({ min: -36, max: 36, stepped: true })).toBe(72)
  expect(stepsOf({ min: 0, max: 5, names: ["a", "b", "c", "d", "e", "f"] })).toBe(5)
  for (const steps of [5, 72, 1000, K_STEPS]) {
    expect(movePosition(3, 1, steps)).toBe(4)
    expect(movePosition(3, -1, steps)).toBe(2)
    expect(movePosition(0, -1, steps)).toBe(0) // clamps at the ends
    expect(movePosition(steps, 1, steps)).toBe(steps)
  }
  // the coarse step is 1/100 of the travel when there is plenty, else 10 positions at most and never zero
  expect(coarseOf(K_STEPS)).toBe(655)
  expect(coarseOf(72)).toBe(10)
  expect(coarseOf(5)).toBe(1)
  expect(coarseOf(1)).toBe(1)
  expect(pageOf(K_STEPS)).toBe(6554)
  expect(movePosition(100, 1, K_STEPS, "coarse")).toBe(755)
  expect(movePosition(100, -1, K_STEPS, "page")).toBe(0)
})

test("nativeNudge: a slider with a step moves by that step, one without by 1/65535, on its own grid", () => {
  expect(nativeNudge(100, 20000, 100, 5000, 1)).toBe(5100) // Delay Filter
  expect(nativeNudge(100, 20000, 100, 5000, -1)).toBe(4900)
  expect(nativeNudge(0, 100, 0.5, 37.5, 1)).toBe(38) // a macro
  expect(nativeNudge(0, 100, 0.5, 37.5, 1, "coarse")).toBe(42.5)
  expect(nativeNudge(0, 100, 1, 100, 1)).toBe(100)
  expect(nativeNudge(0, 100, 1, 0, -1)).toBe(0)
  expect(nativeNudge(0, 1, 0, 32768 / K_STEPS, 1)).toBeCloseTo(32769 / K_STEPS, 10)
  expect(nativeNudge(0, 0.1, 0.01, 0.07, 1)).toBe(0.08) // no float noise in the result
})

test("snapToGrid clamps to the range and rounds to the step", () => {
  expect(snapToGrid(0, 100, 1, 37.6)).toBe(38)
  expect(snapToGrid(0, 100, 1, 500)).toBe(100)
  expect(snapToGrid(100, 20000, 100, 12345)).toBe(12300)
  expect(snapToGrid(0, 1, 0, 0.123456)).toBe(0.123456)
})

// the page's own readouts, written back
const fmtPlain = (v: number, unit?: string) => `${v}${unit ? " " + unit : ""}`
test("a plain readout reads back: every value of every Delay, Reverb and tempo slider with a unit", () => {
  for (const p of [...FX_PARAMS.delay, ...FX_PARAMS.reverb].filter((q: any) => !q.enum && !q.unit?.match(/^(send|level)$/))) {
    for (let v = p.min; v <= p.max; v += p.step * Math.max(1, Math.floor((p.max - p.min) / p.step / 40))) expect(parsePlain(fmtPlain(v, p.unit), p)).toBe(v)
    expect(parsePlain("-99999", p)).toBe(p.min)
    expect(parsePlain("99999 " + (p.unit ?? ""), p)).toBe(p.max)
    expect(parsePlain("word", p)).toBeNull()
  }
})

test("a dB readout (Send, Level, Threshold) reads back to the same step, -inf is step 0, a plain number is dB", () => {
  const p = { min: 0, max: 100 }
  const text = (g: (v: number) => number, v: number) => (v <= 0 ? "-inf dB" : `${dbOf(g, v).toFixed(2)} dB`)
  for (const g of [(v: number) => SENDS[v], (v: number) => LIMITER[v] / 32767]) {
    for (let v = 1; v <= 100; v++) {
      const t = text(g, v)
      if (!Number.isFinite(dbOf(g, v))) continue
      expect(parseDb(t, p, g)).toBe(v)
      expect(parseDb(t.replace(" dB", ""), p, g)).toBe(v)
    }
    expect(parseDb("-inf dB", p, g)).toBe(0)
    expect(parseDb("0 dB", p, g)).toBeGreaterThanOrEqual(99)
    expect(parseDb("-500", p, g)).toBe(1) // below the first finite step: that step
    expect(parseDb("12 Hz", p, g)).toBeNull()
  }
})

test("the limiter times are shown as value / 1000 s and read back from s or ms", () => {
  const p = LIMITER_PARAMS.find((q: any) => q.key === "attack")!
  for (const v of [1, 7, 100, 512, 1000]) {
    const text = `${(v / 1000).toFixed(3)} s`
    expect(parseMilli(text, p)).toBe(v)
    expect(parseMilli(`${v} ms`, p)).toBe(v)
  }
  expect(parseMilli("5 s", p)).toBe(1000)
  expect(parseMilli("0", p)).toBe(1)
})

test("a round trip of knob positions through the frozen curves: the readout of every curve kind maps back to its position", () => {
  // the parameters' own readout is the host's (see typed.test.ts); here the maths of the curves the page steps through
  for (const p of [{ min: 20, max: 20000, curve: "exp" }, { min: -1, max: 1, curve: "linear" }, { min: 0, max: 3, curve: "power" }, { min: 0, max: 10, curve: "expSteep" }]) {
    for (const K of [0, 1, 17, 1000, 32768, 65534, 65535]) expect(knobOf(p, knobValue(p, K))).toBe(K)
    // one arrow press is one position: it changes the value, and by the least amount the 16 bit knob can
    const v0 = knobValue(p, 30000), v1 = knobValue(p, movePosition(30000, 1, K_STEPS))
    expect(v1).toBeGreaterThan(v0)
    expect(knobOf(p, v1) - knobOf(p, v0)).toBe(1)
  }
})

test("MIX slot knobs: a readout reads back for every kind", () => {
  const lin = { kind: "lin", lo: -1, hi: 1, unit: "x" }, pct = { kind: "lin", lo: 0, hi: 1, unit: "pct" }
  const hz = { kind: "exp", lo: 20, hi: 20000, unit: "hz" }, int = { kind: "int", lo: 1, hi: 16, unit: "int" }, en = { kind: "enum", names: ["Sine", "Saw", "Pulse"] }
  expect(parseSlotKnob(lin, "0.50")).toBeCloseTo(0.75, 12)
  expect(parseSlotKnob(pct, "35 %")).toBeCloseTo(0.35, 12)
  expect(parseSlotKnob(pct, "35")).toBeCloseTo(0.35, 12)
  expect(parseSlotKnob(pct, "500 %")).toBe(1)
  expect(parseSlotKnob(hz, "1 kHz")).toBeCloseTo(Math.log(50) / Math.log(1000), 12)
  expect(parseSlotKnob(hz, "440 Hz")).toBeCloseTo(Math.log(22) / Math.log(1000), 12)
  expect(parseSlotKnob(hz, "0")).toBe(0)
  expect(Math.round(parseSlotKnob(int, "5")! * 15)).toBe(4)
  expect(parseSlotKnob(int, "99")).toBe(1)
  expect(parseSlotKnob(en, "pulse")).toBe(1)
  expect(parseSlotKnob(en, "1")).toBe(0.5)
  expect(parseSlotKnob(en, "triangle")).toBeNull()
  expect(parseSlotKnob(lin, "??")).toBeNull()
  expect(slotKnobSteps(int)).toBe(15)
  expect(slotKnobSteps(en)).toBe(2)
  expect(slotKnobSteps(hz)).toBe(K_STEPS)
})

// ---- the arrow key on a continuous slider: the smallest knob move that changes the readout text
const dbText = (i: number) => `${(-60 + (i / K_STEPS) * 66).toFixed(1)} dB` // 66 dB over 65535 positions: 0.1 dB is ~993 positions
const hzText = (i: number) => `${Math.round(knobValue({ min: 20, max: 20000, curve: "exp" }, i))} Hz`

test("nextTextPosition: the first position that reads differently, up and down, linear and exp readouts", async () => {
  for (const [textAt, at] of [[dbText, 30000], [dbText, 12345], [hzText, 30000], [hzText, 3000]] as const) {
    for (const dir of [1, -1]) {
      const r = await nextTextPosition(textAt, at, dir, K_STEPS)
      expect(r).not.toBeNull()
      expect(r!.text).toBe(textAt(r!.pos))
      expect(r!.text).not.toBe(textAt(at))
      // the smallest move: the position just short of it still reads like the start
      expect(textAt(r!.pos - dir)).toBe(textAt(at))
      expect(Math.sign(r!.pos - at)).toBe(dir)
    }
  }
  // a stepping chain: every press shows the next text, none is skipped and none repeats
  const seen: string[] = [dbText(20000)]
  let pos = 20000
  for (let i = 0; i < 12; i++) { const r = (await nextTextPosition(dbText, pos, 1, K_STEPS))!; pos = r.pos; seen.push(r.text) }
  expect(new Set(seen).size).toBe(13)
  const cents = seen.map((t) => Math.round(parseFloat(t) * 10))
  cents.slice(1).forEach((c, i) => expect(c - cents[i]).toBe(1)) // 0.1 dB at a time
  // and back down the same texts
  for (let i = 11; i >= 0; i--) { const r = (await nextTextPosition(dbText, pos, -1, K_STEPS))!; pos = r.pos; expect(r.text).toBe(seen[i]) }
})

test("nextTextPosition: a readout that falls with the position, async readouts, the end of the travel, a text to avoid", async () => {
  const falling = (i: number) => `${Math.round(50 - (i / K_STEPS) * 50)} ms`
  const up = (await nextTextPosition(falling, 30000, 1, K_STEPS))!
  expect(parseInt(up.text)).toBe(parseInt(falling(30000)) - 1)
  const asyncText = async (i: number) => hzText(i)
  expect((await nextTextPosition(asyncText, 40000, -1, K_STEPS))!.pos).toBe((await nextTextPosition(hzText, 40000, -1, K_STEPS))!.pos)
  // at the ends and on a plateau that runs to the end nothing changes
  expect(await nextTextPosition(dbText, K_STEPS, 1, K_STEPS)).toBeNull()
  expect(await nextTextPosition(dbText, 0, -1, K_STEPS)).toBeNull()
  expect(await nextTextPosition(() => "same", 100, 1, K_STEPS)).toBeNull()
  expect(await nextTextPosition(() => "same", 100, -1, K_STEPS)).toBeNull()
  // one step from the end still moves there
  expect((await nextTextPosition((i) => (i < K_STEPS ? "a" : "b"), K_STEPS - 1, 1, K_STEPS))!.pos).toBe(K_STEPS)
  // the position reads "441 Hz" while the screen says "440 Hz" (the stored value sits between two positions): down must not land on "440 Hz"
  const shown = hzText(30000)
  let at = 30000
  while (hzText(at + 1) === shown) at++
  const next = hzText(at + 1)
  const down = (await nextTextPosition(hzText, at + 1, -1, K_STEPS, shown))!
  expect(down.text).not.toBe(shown); expect(down.text).not.toBe(next)
  // a text that needs a few hundred reads would be a bug: the reads of one press stay near 2 log2(gap)
  let reads = 0
  await nextTextPosition((i) => { reads++; return dbText(i) }, 30000, 1, K_STEPS)
  expect(reads).toBeLessThan(40)
  // an out of range or fractional start is clamped and rounded
  expect((await nextTextPosition(dbText, 70000, -1, K_STEPS))!.pos).toBeLessThan(K_STEPS)
  expect((await nextTextPosition(dbText, 100.4, 1, K_STEPS))!.pos).toBeGreaterThan(100)
})

test("the macro readout is one decimal at most, whatever float the position is", () => {
  expect(MACRO_DECIMALS).toBe(1)
  expect(macroText((63 * 100) / 127)).toBe("49.6 %") // the bipolar neutral position, was 49.60629921259842 %
  expect(macroText((1 * 100) / 127)).toBe("0.8 %")
  expect(macroText(0)).toBe("0 %")
  expect(macroText(100)).toBe("100 %")
  expect(macroText(37.5)).toBe("37.5 %")
  expect(macroText(0.04)).toBe("0 %")
  for (let cc = 0; cc <= 127; cc++) expect(macroText((cc * 100) / 127)).toMatch(/^\d+(\.\d)? %$/)
  expect(fmtNum(0.1 + 0.2, 3)).toBe("0.3")
  expect(fmtNum(12.3456, 2)).toBe("12.35")
})

test("only a text typing field takes the note keys away", () => {
  const input = (type: string) => ({ tagName: "INPUT", type })
  for (const type of ["text", "number", "search", "email", "url", "password"]) expect(isTypingTarget(input(type))).toBe(true)
  for (const type of ["range", "checkbox", "radio", "button", "submit", "color"]) expect(isTypingTarget(input(type))).toBe(false)
  expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true)
  expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true)
  for (const tagName of ["SELECT", "BUTTON", "DIV", "BODY"]) expect(isTypingTarget({ tagName, isContentEditable: false })).toBe(false)
  expect(isTypingTarget(null)).toBe(false)
})

test("the patch search keeps names that contain every word, any case, the ones that start with the first word first", () => {
  const names = ["Acid Bass", "Bass Drum", "Deep Bass", "Lead", "bassline"]
  expect(filterNames(names, "")).toEqual(names)
  expect(filterNames(names, "  ")).toEqual(names)
  expect(filterNames(names, "bass")).toEqual(["Bass Drum", "bassline", "Acid Bass", "Deep Bass"])
  expect(filterNames(names, "BASS acid")).toEqual(["Acid Bass"])
  expect(filterNames(names, "zzz")).toEqual([])
  expect(filterNames(names, "e")).toEqual(["Deep Bass", "Lead", "bassline"]) // none starts with it: list order
})
