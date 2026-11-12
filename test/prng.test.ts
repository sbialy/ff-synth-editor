// The frozen PRNG (public/prng.js): SplitMix64 reference vectors, a counter-based draw per (seed, engine, kind, slot, index), fixed vectors.
import { expect, test } from "bun:test"
import { absorb, draw64, drawAt, hi16, hi32, KIND_MACRO, KIND_PARAM, mix64, splitmix64Next, stream } from "../public/prng.js"

const MAX = 0xffffffffffffffffn

test("SplitMix64: the reference sequences (this is the published generator, not a variant)", () => {
  const run = (state: bigint, n: number) => { const out: bigint[] = []; for (let i = 0; i < n; i++) { const [v, s] = splitmix64Next(state); out.push(v); state = s } return out }
  expect(run(0n, 3)).toEqual([0xe220a8397b1dcdafn, 0x6e789e6aa1b965f4n, 0x06c45d188009454fn])
  expect(run(1234567n, 5)).toEqual([6457827717110365317n, 3203168211198807973n, 9817491932198370423n, 4593380528125082431n, 16408922859458223821n])
})

test("mix64 and draw64: fixed vectors", () => {
  expect(mix64(0n)).toBe(0n)
  expect(mix64(1n)).toBe(0x5692161d100b05e5n)
  expect(draw64(0n, 0, KIND_PARAM, 0, 0)).toBe(0x3ceea767acc0e20dn)
  expect(draw64(1n, 1, KIND_PARAM, 0, 0)).toBe(0x8c590fdf1f7e4108n)
  expect(draw64(0xdeadbeefcafef00dn, 6, KIND_PARAM, 83, 1)).toBe(0xf80d813c90a3f7f3n)
  expect(draw64(MAX, 0xa2, KIND_MACRO, (5 << 16) | 3, 0)).toBe(0xcbd2bb21402161a1n)
})

test("counter based: a draw is a function of its five inputs only, whatever was drawn before", () => {
  const a = draw64(42n, 3, KIND_PARAM, 7, 5)
  for (let i = 0; i < 50; i++) draw64(BigInt(i), i, KIND_PARAM, i, i)
  expect(draw64(42n, 3, KIND_PARAM, 7, 5)).toBe(a)
  expect(drawAt(stream(42n, 3, KIND_PARAM, 7), 5)).toBe(a)
  expect(absorb(stream(42n, 3, KIND_PARAM, 7), 5n)).toBe(a)
})

test("every input matters, and small seeds on different engines do not share streams (the seed is whitened first)", () => {
  const base = draw64(1n, 1, KIND_PARAM, 1, 0)
  expect(new Set([base, draw64(2n, 1, KIND_PARAM, 1, 0), draw64(1n, 2, KIND_PARAM, 1, 0), draw64(1n, 1, KIND_MACRO, 1, 0), draw64(1n, 1, KIND_PARAM, 2, 0), draw64(1n, 1, KIND_PARAM, 1, 1)]).size).toBe(6)
  // seed 0 on engine 0 against seed 1 on engine 1, 2 on 2 ...: an XOR of seed and engine id would repeat them
  const seen = new Set<bigint>()
  for (let s = 0; s < 64; s++) for (let e = 0; e < 64; e++) seen.add(draw64(BigInt(s), e, KIND_PARAM, 0, 0))
  expect(seen.size).toBe(64 * 64)
  // all the fields of the stream are distinct from each other for neighbouring values
  const keys = new Set<bigint>()
  for (let k = 0; k < 300; k++) for (let i = 0; i < 4; i++) keys.add(draw64(7n, 1, KIND_PARAM, k, i))
  expect(keys.size).toBe(1200)
})

test("inputs are checked", () => {
  expect(() => draw64(-1n, 0, 1, 0, 0)).toThrow()
  expect(() => draw64(MAX + 1n, 0, 1, 0, 0)).toThrow()
  expect(() => draw64(1 as any, 0, 1, 0, 0)).toThrow()
  expect(() => draw64(1n, -1, 1, 0, 0)).toThrow()
  expect(() => draw64(1n, 0, 1, 1.5, 0)).toThrow()
})

test("quality: the top bits are uniform and one flipped seed bit flips about half of the draw", () => {
  const buckets = new Array(16).fill(0)
  let flips = 0, n = 0
  for (let s = 0n; s < 20000n; s++) {
    const d = draw64(s, 1, KIND_PARAM, 5, 0)
    buckets[hi16(d) >> 12]++
    expect(hi32(d)).toBeLessThan(2 ** 32)
    flips += popcount(d ^ draw64(s ^ (1n << BigInt(Number(s % 64n))), 1, KIND_PARAM, 5, 0)); n++
  }
  for (const b of buckets) expect(Math.abs(b - 1250)).toBeLessThan(200) // 1250 expected, a 5 sigma band is about 170
  expect(Math.abs(flips / n - 32)).toBeLessThan(0.5)
})
const popcount = (v: bigint) => { let c = 0; while (v) { c += Number(v & 1n); v >>= 1n } return c }
