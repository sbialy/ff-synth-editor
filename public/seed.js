// FROZEN. A seed code typed or pasted today has to mean the same 64 bit value forever. Once released this file is never edited: a
// change is a new file with a new format character, and this one stays. test/frozen-files.test.ts fails when a byte of it
// changes, test/randomize-golden.test.ts pins the vectors.
//
// A seed is a 64 bit unsigned integer (BigInt in the code).
//
// Seed code (what the page shows and what recipes and roll codes carry):
//   13 symbols of Crockford base32 (https://www.crockford.com/base32.html), most significant first. The alphabet is
//   0123456789ABCDEFGHJKMNPQRSTVWXYZ (no I, L, O, U). 13 x 5 bits = 65 bits, so the first symbol only goes up to F (4 bits).
//   Then ONE check symbol from the same alphabet. The check is a Reed-Solomon style sum over GF(2^5) (x^5 + x^2 + 1, primitive):
//     c = 0; for each symbol d in order: c = alpha * (c XOR d)       (alpha is x, so "alpha * y" is y << 1, XOR 0x25 when bit 5 is set)
//   that is c = sum of alpha^(n-i) * d_i with n weights that are all different. It catches EVERY single wrong symbol and EVERY swap of
//   two symbols (adjacent or not), the two typo kinds; other mistakes slip through one time in 32.
//   Versioned form (what the page shows): the algorithm version as one symbol (1..31) in front of the 13, inside the check:
//   "2-0123-4567-89AB-CD" is 1 + 13 + 1 = 15 symbols, the first says "randomizer algorithm 2". A bare 14 symbol code has no version
//   (it means the editor's current algorithm). Hyphens are decoration: written in groups of 4 after the version, ignored on input.
//   Input is case-insensitive, O reads as 0 and I or L as 1 (Crockford's rule).
//
// What the Seed field accepts (parseSeed):
//   blank                              no seed: the page draws a new one
//   1..10 digits, at most 4294967295   the number itself (what the first versions of the field took)
//   a seed code (14 or 15 symbols)     checked, a wrong check symbol is an error (a typo), not a different seed
//   anything else                      free text: seed = FNV-1a 64 of its UTF-8 bytes (trimmed, otherwise exactly as typed, no case
//                                      folding and no Unicode normalisation, so no Unicode table is involved)
//   "text:" in front forces free text (for a phrase that happens to look like a seed code)
// FNV-1a 64: h = 0xcbf29ce484222325, for each byte: h = (h XOR byte) * 0x100000001b3 mod 2^64 (Fowler, Noll, Vo).

const MASK = (1n << 64n) - 1n
export const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
export const CODE_LENGTH = 13 // symbols of the value, without version and check

/** FNV-1a 64 of the UTF-8 bytes of a string (BigInt). */
export function fnv1a64(text) {
  let h = 0xcbf29ce484222325n
  for (const b of new TextEncoder().encode(text)) h = ((h ^ BigInt(b)) * 0x100000001b3n) & MASK
  return h
}

const timesAlpha = (x) => {
  x <<= 1
  return x & 32 ? x ^ 0x25 : x
}
/** The check symbol (0..31) of a list of symbol values (0..31). */
export function checkOf(digits) {
  let c = 0
  for (const d of digits) c = timesAlpha(c ^ d)
  return c
}

/** A 64 bit value -> its 13 symbol values (0..31). */
function digitsOf(seed) {
  const out = []
  for (let i = CODE_LENGTH - 1; i >= 0; i--) out.push(Number((seed >> BigInt(5 * i)) & 31n))
  return out
}

/** Is `seed` a BigInt in 0..2^64-1. */
export const isSeed = (seed) => typeof seed === "bigint" && seed >= 0n && seed <= MASK

/**
 * The text of a seed. With `algo` (1..31) the versioned form "2-0123-4567-89AB-CD", without it the bare form "0123-4567-89AB-CD".
 */
export function formatSeed(seed, algo) {
  if (!isSeed(seed)) throw new Error("a seed is a BigInt of 64 bits")
  const digits = digitsOf(seed)
  if (algo !== undefined && algo !== null) {
    if (!Number.isInteger(algo) || algo < 1 || algo > 31) throw new Error("the algorithm version must be a whole number 1..31")
    digits.unshift(algo)
  }
  digits.push(checkOf(digits))
  const text = digits.map((d) => ALPHABET[d]).join("")
  const body = algo === undefined || algo === null ? text : text.slice(1)
  const groups = body.match(/.{1,4}/g).join("-")
  return algo === undefined || algo === null ? groups : text[0] + "-" + groups
}

const ALIAS = { O: "0", I: "1", L: "1" }
/** Symbol values of a seed code text, or null when it has a character that is not in the alphabet. */
function symbols(text) {
  const out = []
  for (const ch of text.toUpperCase()) {
    const i = ALPHABET.indexOf(ALIAS[ch] ?? ch)
    if (i < 0) return null
    out.push(i)
  }
  return out
}

/** Does this text have the shape of a seed code (14 or 15 symbols of the alphabet, hyphens ignored)? */
export function looksLikeSeedCode(text) {
  const s = symbols(String(text).trim().replace(/-/g, ""))
  return !!s && (s.length === CODE_LENGTH + 1 || s.length === CODE_LENGTH + 2)
}

/**
 * Read a seed code. @returns { seed (BigInt), algo (1..31 or null for a bare code) }
 * @throws Error when it is not a seed code or the check symbol does not match (a typo)
 */
export function parseSeedCode(text) {
  const s = symbols(String(text).trim().replace(/-/g, ""))
  if (!s || (s.length !== CODE_LENGTH + 1 && s.length !== CODE_LENGTH + 2)) throw new Error("not a seed code (13 symbols and a check symbol, 15 with the algorithm version in front)")
  const check = s.pop()
  if (checkOf(s) !== check) throw new Error("the check symbol of this seed code does not match: a character is mistyped")
  const algo = s.length === CODE_LENGTH + 1 ? s.shift() : null
  if (algo === 0) throw new Error("the algorithm version of this seed code is 0, which does not exist")
  if (s[0] > 15) throw new Error("this seed code is larger than 64 bits")
  let seed = 0n
  for (const d of s) seed = (seed << 5n) | BigInt(d)
  return { seed, algo }
}

/**
 * The Seed field text -> { seed (BigInt), algo (number or null), kind: "number" | "code" | "text" }, or null when it is blank.
 * @throws Error for a seed code with a wrong check symbol or a bad version
 */
export function parseSeed(text) {
  let t = String(text ?? "").trim()
  if (!t) return null
  if (/^text:/i.test(t)) {
    t = t.slice(5).trim()
    if (!t) return null
    return { seed: fnv1a64(t), algo: null, kind: "text" }
  }
  if (/^\d{1,10}$/.test(t) && Number(t) <= 0xffffffff) return { seed: BigInt(t), algo: null, kind: "number" }
  if (looksLikeSeedCode(t)) return { ...parseSeedCode(t), kind: "code" }
  return { seed: fnv1a64(t), algo: null, kind: "text" }
}

/** A BigInt seed, or a whole number 0..2^53, or a seed code text -> BigInt seed. */
export function toSeed(x) {
  if (typeof x === "bigint") {
    if (!isSeed(x)) throw new Error("a seed is 64 bits (0..2^64-1)")
    return x
  }
  if (typeof x === "number") {
    if (!Number.isSafeInteger(x) || x < 0) throw new Error("a numeric seed must be a whole number of 0 or more")
    return BigInt(x)
  }
  if (typeof x === "string") return parseSeedCode(x).seed
  throw new Error("not a seed")
}

/** A fresh random seed (64 bits from the browser's crypto). */
export function newSeed() {
  const a = new BigUint64Array(1)
  globalThis.crypto.getRandomValues(a)
  return a[0]
}
