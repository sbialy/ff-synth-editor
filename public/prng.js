// FROZEN. This file is part of what a seed means: a seed has to give the same patch forever, on any browser, OS or JS engine.
// Once released it is never edited. A change is a new file (prng2.js) used by a new algorithm version, and this one stays for the old
// recipes. test/frozen-files.test.ts fails when a byte of it changes, test/randomize-golden.test.ts pins what it computes.
//
// Specification (integers only, 64 bit unsigned, every operation is mod 2^64, no floating point anywhere):
//   GAMMA   = 0x9E3779B97F4A7C15
//   mix64(z)   the SplitMix64 finaliser (Steele, Lea, Flood, "Fast splittable pseudorandom number generators", 2014):
//                z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9
//                z = (z ^ (z >> 27)) * 0x94D049BB133111EB
//                return z ^ (z >> 31)
//   absorb(h, x) = mix64((h ^ x) + GAMMA)       for a fixed x a bijection of h
//   stream(seed, engineId, kind, key) = absorb(absorb(absorb(mix64(seed + GAMMA), engineId), kind), key)
//   draw64(seed, engineId, kind, key, index) = absorb(stream(seed, engineId, kind, key), index)
//   The seed is whitened first (mix64(seed + GAMMA), a bijection). Without it (seed XOR engineId) would be the same number for seed 0 on
//   engine 0 and seed 1 on engine 1, and two small seeds would share streams. Every later h is a mixed 64 bit value, so the XOR
//   with a small field cannot collide in any structured way.
//     seed      the 64 bit seed
//     engineId  the engine's id in the .patch file (field 1 of the file), a fixed number per engine
//     kind      1 = a parameter, 2 = a macro target
//     key       kind 1: the parameter's slot in the .patch file (the ParamValue number, meta.params[i].id), never its position in a
//               list that could be reordered and never its display name, so adding, removing or reordering parameters in a later
//               engine version leaves every other parameter's draws unchanged. kind 2: (macro number << 16) | target number
//     index     the draw number inside that stream, a counter: 0, 1, 2 ... (no state is carried from one draw to the next, so a draw
//               never depends on how many other draws happened before it)
// BigInt is exact and the same in every engine that has it (all browsers since 2020, bun, node).

const MASK = (1n << 64n) - 1n
const GAMMA = 0x9e3779b97f4a7c15n

export const KIND_PARAM = 1
export const KIND_MACRO = 2

/** The SplitMix64 finaliser of a 64 bit BigInt. */
export function mix64(z) {
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK
  return z ^ (z >> 31n)
}

/** h and x are 64 bit BigInts. */
export function absorb(h, x) {
  return mix64(((h ^ x) + GAMMA) & MASK)
}

/** One output of the SplitMix64 generator (the reference sequence): state += GAMMA, output mix64(state). Returns [output, newState]. */
export function splitmix64Next(state) {
  const s = (state + GAMMA) & MASK
  return [mix64(s), s]
}

const field = (n, what) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`prng: ${what} must be a whole number of 0 or more`)
  return BigInt(n)
}

/** The stream (seed, engineId, kind, key) as the 64 bit state draws are taken from. seed is a BigInt in 0..2^64-1. */
export function stream(seed, engineId, kind, key) {
  if (typeof seed !== "bigint" || seed < 0n || seed > MASK) throw new Error("prng: the seed must be a BigInt of 64 bits")
  return absorb(absorb(absorb(mix64((seed + GAMMA) & MASK), field(engineId, "engineId")), field(kind, "kind")), field(key, "key"))
}

/** The 64 bit draw number `index` of a stream: absorb(stream, index). */
export function drawAt(streamState, index) {
  return absorb(streamState, field(index, "index"))
}

/** The 64 bit draw number `index` of the stream (seed, engineId, kind, key). seed is a BigInt in 0..2^64-1. */
export function draw64(seed, engineId, kind, key, index) {
  return drawAt(stream(seed, engineId, kind, key), index)
}

/** The top 32 bits of a draw as a number 0..4294967295. */
export const hi32 = (v) => Number(v >> 32n)
/** The top 16 bits of a draw as a number 0..65535. */
export const hi16 = (v) => Number(v >> 48n)
