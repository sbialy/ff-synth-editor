// Seeds (public/seed.js, FROZEN): the 64 bit value, its Crockford base32 text with a check symbol, the Seed field rules and the text hash.
// The vectors in this file are fixed forever: the same text has to mean the same seed in every later version of the editor.
import { expect, test } from "bun:test"
import { ALPHABET, checkOf, fnv1a64, formatSeed, isSeed, looksLikeSeedCode, newSeed, parseSeed, parseSeedCode, toSeed } from "../public/seed.js"

const MAX = 0xffffffffffffffffn
const samples = [0n, 1n, 31n, 32n, MAX, 0x0123456789abcdefn, 0xdeadbeefcafef00dn, 0x8000000000000000n, 0x9e3779b97f4a7c15n]
// deterministic pseudo random seeds for the sweeps below (no Math.random: the test must give the same result every time)
let x = 12345n
const next = () => (x = (x * 6364136223846793005n + 1442695040888963407n) & MAX)
for (let i = 0; i < 40; i++) samples.push(next())

test("the alphabet is Crockford's: 32 symbols, no I L O U", () => {
  expect(ALPHABET).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
  expect(new Set(ALPHABET).size).toBe(32)
  for (const c of "ILOU") expect(ALPHABET.includes(c)).toBe(false)
})

test("fixed vectors: the text of a seed never changes", () => {
  expect(formatSeed(0n, 2)).toBe("2-0000-0000-0000-0Z")
  expect(formatSeed(1n, 2)).toBe("2-0000-0000-0000-1X")
  expect(formatSeed(MAX, 2)).toBe("2-FZZZ-ZZZZ-ZZZZ-Z2")
  expect(formatSeed(0x0123456789abcdefn, 2)).toBe("2-028T-5CY4-TQKF-FV")
  expect(formatSeed(0n)).toBe("0000-0000-0000-00")
  expect(formatSeed(1n)).toBe("0000-0000-0000-12")
  expect(formatSeed(MAX)).toBe("FZZZ-ZZZZ-ZZZZ-ZX")
  expect(formatSeed(0x0123456789abcdefn)).toBe("028T-5CY4-TQKF-F4")
  expect(parseSeedCode("2-028T-5CY4-TQKF-FV")).toEqual({ seed: 0x0123456789abcdefn, algo: 2 })
  expect(parseSeedCode("FZZZ-ZZZZ-ZZZZ-ZX")).toEqual({ seed: MAX, algo: null })
})

test("every 64 bit seed round-trips through its text, versioned or bare", () => {
  for (const seed of samples) {
    for (const algo of [undefined, 1, 2, 31]) {
      const text = formatSeed(seed, algo)
      expect(text).toMatch(algo === undefined ? /^[0-9A-Z]{4}(-[0-9A-Z]{4}){2}-[0-9A-Z]{2}$/ : /^[0-9A-Z]-[0-9A-Z]{4}(-[0-9A-Z]{4}){2}-[0-9A-Z]{2}$/)
      expect(parseSeedCode(text)).toEqual({ seed, algo: algo ?? null })
    }
  }
  expect(() => formatSeed(MAX + 1n, 2)).toThrow()
  expect(() => formatSeed(-1n, 2)).toThrow()
  expect(() => formatSeed(1n, 0)).toThrow()
  expect(() => formatSeed(1n, 32)).toThrow()
})

test("input is case-insensitive, hyphens are decoration, O reads as 0 and I or L as 1", () => {
  const seed = 0x0123456789abcdefn, text = formatSeed(seed, 2)
  expect(parseSeedCode(text.toLowerCase()).seed).toBe(seed)
  expect(parseSeedCode(text.replace(/-/g, "")).seed).toBe(seed)
  expect(parseSeedCode(" " + text.replace(/-/g, "").toLowerCase() + "\n").seed).toBe(seed)
  expect(parseSeedCode(text.replace(/-/g, "--")).seed).toBe(seed)
  const withZero = formatSeed(0n, 2) // 2-0000-0000-0000-0Z
  expect(parseSeedCode(withZero.replace(/0/g, "O")).seed).toBe(0n)
  const withOne = formatSeed(0x1111111111111111n, 2).replace(/1/g, "I") // the 1s typed as I
  expect(parseSeedCode(withOne).seed).toBe(0x1111111111111111n)
  expect(parseSeedCode(formatSeed(0x1111111111111111n, 2).replace(/1/g, "l")).seed).toBe(0x1111111111111111n)
})

test("the check symbol catches every single wrong symbol and every swap of two different symbols", () => {
  let tested = 0
  for (const seed of samples) {
    const text = formatSeed(seed, 2).replace(/-/g, "")
    const swapChars = (t: string, i: number, j: number) => { const a = [...t]; [a[i], a[j]] = [a[j], a[i]]; return a.join("") }
    for (let i = 0; i < text.length; i++) {
      for (const c of ALPHABET) {
        if (c === text[i]) continue
        expect(() => parseSeedCode(text.slice(0, i) + c + text.slice(i + 1))).toThrow() // check symbol, or the 64 bit range, or version 0
        tested++
      }
      for (let j = i + 1; j < text.length; j++) {
        if (text[i] === text[j]) continue
        expect(() => parseSeedCode(swapChars(text, i, j))).toThrow()
        tested++
      }
    }
  }
  expect(tested).toBeGreaterThan(25_000)
  // the first symbol of the value only has 4 bits: a larger one is no 64 bit seed even with a matching check
  const digits = [2, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  const text = digits.concat(checkOf(digits)).map((d) => ALPHABET[d]).join("")
  expect(() => parseSeedCode(text)).toThrow(/64 bits/)
  // version 0 does not exist
  const d0 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  expect(() => parseSeedCode(d0.concat(checkOf(d0)).map((d) => ALPHABET[d]).join(""))).toThrow(/version/)
  expect(() => parseSeedCode("2-028T-5CY4-TQKF-F")).toThrow() // too short
  expect(() => parseSeedCode("2-028T-5CY4-TQKF-FVV")).toThrow() // too long
  expect(() => parseSeedCode("2-028T-5CU4-TQKF-FV")).toThrow() // U is not a symbol
})

test("text hash: FNV-1a 64 over the UTF-8 bytes, the published vectors", () => {
  expect(fnv1a64("")).toBe(0xcbf29ce484222325n)
  expect(fnv1a64("a")).toBe(0xaf63dc4c8601ec8cn)
  expect(fnv1a64("foobar")).toBe(0x85944171f73967e8n)
  expect(fnv1a64("poly-editor")).toBe(0x9ee09f71353f70dfn)
  expect(fnv1a64("héllo ✓")).toBe(0xcab09e47690f70e7n) // two and three byte UTF-8 sequences
})

test("the Seed field: blank, plain numbers, seed codes, free text", () => {
  expect(parseSeed("")).toBeNull()
  expect(parseSeed("   ")).toBeNull()
  expect(parseSeed(null)).toBeNull()
  // old plain numbers still parse, as the number itself
  expect(parseSeed("12345")).toEqual({ seed: 12345n, algo: null, kind: "number" })
  expect(parseSeed(" 0 ")).toEqual({ seed: 0n, algo: null, kind: "number" })
  expect(parseSeed("4294967295")).toEqual({ seed: 4294967295n, algo: null, kind: "number" })
  expect(parseSeed("4294967296")?.kind).toBe("text") // over what the first versions took: hashed as text, as before
  expect(parseSeed("99999999999")?.seed).toBe(fnv1a64("99999999999"))
  // seed codes: versioned or bare
  expect(parseSeed("2-028t-5cy4-tqkf-fv")).toEqual({ seed: 0x0123456789abcdefn, algo: 2, kind: "code" })
  expect(parseSeed("028T5CY4TQKFF4")).toEqual({ seed: 0x0123456789abcdefn, algo: null, kind: "code" })
  expect(() => parseSeed("2-028T-5CY4-TQKF-FW")).toThrow(/check symbol/)
  // free text is hashed
  expect(parseSeed("hello")).toEqual({ seed: fnv1a64("hello"), algo: null, kind: "text" })
  expect(parseSeed("  hello  ")?.seed).toBe(fnv1a64("hello")) // trimmed, nothing else changes
  expect(parseSeed("Hello")?.seed).not.toBe(parseSeed("hello")?.seed) // no case folding
  expect(parseSeed("hello world")?.seed).toBe(fnv1a64("hello world"))
  expect(parseSeed("poly-editor")?.seed).toBe(0x9ee09f71353f70dfn)
  // a phrase that looks like a seed code is read as one: "text:" forces free text
  expect(looksLikeSeedCode("mypassword1234")).toBe(true)
  expect(() => parseSeed("mypassword1234")).toThrow(/check symbol/)
  expect(parseSeed("text:mypassword1234")).toEqual({ seed: fnv1a64("mypassword1234"), algo: null, kind: "text" })
  expect(parseSeed("TEXT: hello")?.seed).toBe(fnv1a64("hello"))
  expect(parseSeed("text:")).toBeNull()
})

test("toSeed and newSeed", () => {
  expect(toSeed(5n)).toBe(5n)
  expect(toSeed(5)).toBe(5n)
  expect(toSeed("2-028T-5CY4-TQKF-FV")).toBe(0x0123456789abcdefn)
  expect(() => toSeed(-1)).toThrow()
  expect(() => toSeed(1.5)).toThrow()
  expect(() => toSeed(MAX + 1n)).toThrow()
  expect(() => toSeed({} as any)).toThrow()
  const seen = new Set<bigint>()
  for (let i = 0; i < 100; i++) { const s = newSeed(); expect(isSeed(s)).toBe(true); seen.add(s) }
  expect(seen.size).toBe(100)
})
