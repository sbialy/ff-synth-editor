// The frozen knob curves (public/curve.js): deterministic ln / exp, endpoints, monotonic, the inverse, fixed vectors, and agreement with
// the firmware's own curve through the host (to a float32 unit in the last place or two).
import { afterAll, beforeAll, expect, test } from "bun:test"
import { K_MAX, exp, knobOf, knobValue, ln } from "../public/curve.js"
import { newHost } from "./helpers"
import { SERVED_ENGINES as ENGINES } from "./helpers"
import type { HostClient } from "../server/host"

const f32bits = (v: number) => { const dv = new DataView(new ArrayBuffer(4)); dv.setFloat32(0, v); return dv.getUint32(0).toString(16).padStart(8, "0") }

test("ln and exp are accurate to about 1e-15 without Math.log / Math.exp", () => {
  let worst = 0
  for (const x of [1e-6, 1e-3, 0.5, 0.9999, 1, 1.0001, 1.5, 2, 7, 20, 1000, 20000, 123456.789, 1e9]) worst = Math.max(worst, Math.abs(ln(x) - Math.log(x)) / Math.max(1, Math.abs(Math.log(x))))
  for (let x = -30; x <= 30; x += 0.37) worst = Math.max(worst, Math.abs(exp(x) / Math.exp(x) - 1))
  expect(worst).toBeLessThan(1e-14)
  expect(ln(1)).toBe(0)
  expect(exp(0)).toBe(1)
})

test("fixed vectors: the float32 bits of a knob value never change", () => {
  const exp1 = { min: 20, max: 20000, curve: "exp" }
  expect(f32bits(knobValue(exp1, 12345))).toBe("4292f3eb")
  expect(f32bits(knobValue(exp1, 1))).toBe("41a00451")
  expect(f32bits(knobValue({ min: 0.001, max: 10, curve: "exp" }, 40000))).toBe("3e8d7c6b")
  expect(f32bits(knobValue({ min: -1, max: 1, curve: "linear" }, 31337))).toBe("bd32d0b3")
  expect(f32bits(knobValue({ min: 0, max: 3, curve: "power" }, 50000))).toBe("3fdf8635")
  expect(f32bits(knobValue({ min: 0, max: 1, curve: "expSteep" }, 60000))).toBe("3f4475b9")
  expect(f32bits(knobValue({ min: -24, max: 24, curve: "exp" }, 20000))).toBe("c19c3c72") // min <= 0: the power curve, like the firmware
  expect(f32bits(ln(7))).toBe("3ff91395")
})

test("the ends are exactly min and max, a position is clamped, the result is a float32 inside the range", () => {
  for (const p of [{ min: 20, max: 20000, curve: "exp" }, { min: -1, max: 1, curve: "linear" }, { min: 0.1, max: 3, curve: "power" }, { min: 0, max: 1, curve: "expSteep" }]) {
    expect(knobValue(p, 0)).toBe(Math.fround(p.min))
    expect(knobValue(p, K_MAX)).toBe(Math.fround(p.max))
    expect(knobValue(p, -5)).toBe(Math.fround(p.min))
    expect(knobValue(p, 70000)).toBe(Math.fround(p.max))
    for (const K of [1, 2, 100, 30000, 65534]) {
      const v = knobValue(p, K)
      expect(v).toBe(Math.fround(v))
      expect(v).toBeGreaterThanOrEqual(Math.fround(p.min))
      expect(v).toBeLessThanOrEqual(Math.fround(p.max))
    }
  }
})

let host: HostClient
const metas: Record<string, any> = {}
beforeAll(async () => {
  host = await newHost()
  for (const e of ENGINES) metas[e] = await host.request({ cmd: "meta", engine: e })
}, 300_000)
afterAll(() => host.close())

test("every continuous parameter of every engine: monotonic in the knob, and the inverse finds the position back", () => {
  for (const name of ENGINES) {
    for (const p of metas[name].params) {
      if (p.stepped || p.names || !(p.max > p.min)) continue
      let prev = -Infinity
      for (let K = 0; K <= K_MAX; K += 257) {
        const v = knobValue(p, K)
        expect(v).toBeGreaterThanOrEqual(prev)
        prev = v
      }
      for (const K of [0, 1, 17, 1000, 32767, 32768, 50000, 65534, 65535]) {
        const back = knobOf(p, knobValue(p, K))
        expect(knobValue(p, back)).toBe(knobValue(p, K)) // the same value: a position is only ambiguous where several have one float32 (the start of a cubic curve)
        expect(back).toBeLessThanOrEqual(K)
        if (K > 20000) expect(Math.abs(back - K)).toBeLessThanOrEqual(1)
      }
      expect(knobOf(p, p.min - 100)).toBe(0)
      expect(knobOf(p, p.max + 100)).toBe(K_MAX)
    }
  }
})

test("it agrees with the firmware's own curve through the host to a few float32 units in the last place", async () => {
  let worst = 0, n = 0
  for (const name of ENGINES) {
    const meta = metas[name]
    const ids = meta.params.map((_: any, i: number) => i).filter((i: number) => !meta.params[i].stepped && !meta.params[i].names && meta.params[i].max > meta.params[i].min)
    for (const K of [0, 1, 777, 16384, 32768, 49151, 65000, 65535]) {
      const r = await host.request({ cmd: "knobs", engine: name, items: ids.map((id: number) => ({ param: id, knob: K / K_MAX })), patch: meta.init })
      ids.forEach((id: number, i: number) => {
        const p = meta.params[id], mine = knobValue(p, K), theirs = r.values[i]
        const err = Math.abs(mine - theirs) / Math.max(Math.abs(theirs), (p.max - p.min) * 1e-3)
        worst = Math.max(worst, err); n++
        expect(err).toBeLessThan(5e-6)
      })
    }
  }
  console.log(`knob curve vs host: ${n} values, worst relative difference ${worst.toExponential(2)}`)
}, 120_000)
