// The version lock, enforced: the files that define what a seed means are FROZEN once released. Their SHA-256 (line endings
// normalised to LF) is recorded in test/fixtures/frozen-files.json and must not change.
//
// If this fails you edited a released algorithm. Revert the edit. If the result of a seed has to change, add a NEW algorithm version
// (public/algo<N+1>.js, registered in ALGORITHMS in public/randomize.js, its own golden fixture) and add the new file here: a new
// line in frozen-files.json is fine, a changed hash of an existing line never is. This applies to the comments too: they are part of
// the file, and a recipe that says "algorithm 2" is replayed by exactly this text.
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ALGORITHMS } from "../public/randomize.js"

const root = join(import.meta.dir, "..")
const frozen: Record<string, string> = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/frozen-files.json"), "utf8"))
const sha = (path: string) => createHash("sha256").update(readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")).digest("hex")

test("the frozen files are byte for byte what was released", () => {
  for (const [path, hash] of Object.entries(frozen)) {
    if (sha(path) !== hash) throw new Error(`FROZEN FILE EDITED: ${path}. A released algorithm is never edited: revert, or write a new algorithm version (see the header of this test).`)
  }
})

test("every algorithm file, and the primitives under them, are in the list (a new version cannot skip the freeze)", () => {
  const algoFiles = readdirSync(join(root, "public")).filter((f) => /^algo\d+\.js$/.test(f)).map((f) => "public/" + f)
  expect(algoFiles.sort()).toEqual(Object.keys(ALGORITHMS).map((v) => `public/algo${v}.js`).sort())
  for (const f of algoFiles) expect(frozen[f]).toMatch(/^[0-9a-f]{64}$/)
  for (const f of ["public/prng.js", "public/seed.js", "public/curve.js"]) expect(frozen[f]).toMatch(/^[0-9a-f]{64}$/)
})

test("the frozen files use no transcendental Math function (the same bits on every JS engine)", () => {
  for (const path of Object.keys(frozen)) {
    const code = readFileSync(join(root, path), "utf8").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/**")).join("\n")
    for (const fn of ["exp", "log", "log2", "log10", "pow", "sin", "cos", "tan", "atan", "atan2", "sqrt", "cbrt", "expm1", "log1p", "sinh", "cosh", "tanh", "hypot", "random"]) {
      expect(code.includes(`Math.${fn}(`)).toBe(false)
    }
    expect(code.includes("**")).toBe(false) // no exponent operator either: it is Math.pow
  }
})
