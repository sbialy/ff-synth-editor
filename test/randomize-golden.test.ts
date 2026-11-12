// GOLDEN VECTORS of the randomizer. THE FIXTURES IN test/fixtures/golden-algo<N>.json MUST NEVER BE REGENERATED FOR AN ALGORITHM
// VERSION THAT HAS BEEN RELEASED.
//
// They are the promise "a seed or a recipe gives the same patch forever, on any browser, OS or JS engine". For every engine: a few
// seeds x Amounts, a roll with macros, a roll with locks and sections switched on, and a chain of two rolls, each recorded as the exact
// float32 bits of every parameter value and every macro amount. The engine metadata the vectors were made on is stored inside the
// fixture, so they test the algorithm, not the firmware.
//
// If this test fails, the code of the algorithm (public/algo<N>.js, prng.js, seed.js, curve.js, recipe.js, randomize.js) changed what
// a seed means. The answer is NEVER to regenerate the fixture or edit the expectation. Revert the change. If the result of a seed
// really has to change, write a new algorithm version (algo<N+1>.js, registered in ALGORITHMS in public/randomize.js) with its own
// fixture (bun scripts/golden-gen.ts algo <N+1>) and leave this one alone: old recipes must keep replaying.
//
// The same vectors run on any JS engine without bun: `node scripts/verify-golden.mjs` (V8), `bun scripts/verify-golden.mjs` (JSC).
import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ALGORITHMS, ALGO } from "../public/randomize.js"
import { casesFor, hexOfPatch, runCase } from "./golden-lib.js"

const dir = join(import.meta.dir, "fixtures")
const files = readdirSync(dir).filter((f) => /^golden-algo\d+\.json$/.test(f)).sort()
const golden = files.map((f) => ({ file: f, algo: Number(f.match(/\d+/)![0]), data: JSON.parse(readFileSync(join(dir, f), "utf8")) }))

test("every algorithm version the editor can replay has its golden fixture, and the current one is among them", () => {
  expect(golden.map((g) => g.algo)).toEqual(Object.keys(ALGORITHMS).map(Number).sort((a, b) => a - b))
  expect(golden.map((g) => g.algo)).toContain(ALGO)
  for (const g of golden) expect(g.data.algo).toBe(g.algo)
})

for (const g of golden) {
  test(`algorithm ${g.algo}: all ${Object.keys(g.data.engines).length} engines x their cases give the recorded float32 bits`, () => {
    expect(Object.keys(g.data.engines).length).toBe(17)
    let n = 0
    for (const [name, e] of Object.entries<any>(g.data.engines)) {
      expect(e.cases.length).toBeGreaterThanOrEqual(8)
      for (const c of e.cases) {
        const got = hexOfPatch(runCase(e.meta, e.init, c.steps))
        if (got !== c.hex) {
          const a = got.split("|")[0], b = c.hex.split("|")[0]
          let first = -1
          for (let i = 0; i < a.length; i += 8) if (a.slice(i, i + 8) !== b.slice(i, i + 8)) { first = i / 8; break }
          throw new Error(`GOLDEN MISMATCH algorithm ${g.algo} ${name} "${c.name}": ${first >= 0 ? `parameter ${first} is ${a.slice(first * 8, first * 8 + 8)}, recorded ${b.slice(first * 8, first * 8 + 8)}` : "macro amounts differ"}. Do not regenerate the fixture: revert the change (see the header of this file).`)
        }
        n++
      }
    }
    expect(n).toBe(17 * 8)
  })

  test(`algorithm ${g.algo}: the cases are the ones the fixture lists (names, steps, seeds as codes), the roll codes inside are well formed`, () => {
    for (const [name, e] of Object.entries<any>(g.data.engines)) {
      const expected = casesFor(e.meta)
      expect(e.cases.map((c: any) => ({ name: c.name, steps: c.steps }))).toEqual(expected.map((c: any) => ({ name: c.name, steps: c.steps })))
      for (const c of e.cases) for (const s of c.steps) expect(s.seed).toMatch(/^\d-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{2}$/)
      expect(name.length).toBeGreaterThan(0)
    }
  })

  test(`algorithm ${g.algo}: the vectors are not trivial (every case moves parameters, different seeds differ, 100% ignores the start)`, () => {
    for (const [name, e] of Object.entries<any>(g.data.engines)) {
      const hexes = e.cases.map((c: any) => c.hex.split("|")[0])
      expect(new Set(hexes).size).toBe(hexes.length) // eight different outcomes
      const init = hexOfPatch({ values: e.init.values, macros: [] }).split("|")[0]
      for (const h of hexes) {
        let changed = 0
        for (let i = 0; i < h.length; i += 8) if (h.slice(i, i + 8) !== init.slice(i, i + 8)) changed++
        expect(changed).toBeGreaterThan(0)
      }
      // case 0 (A@100 from Init) and "A@100 then B@35" start the same way: the first roll is the same, the chain differs after the second
      expect(e.cases[6].steps[0]).toEqual(e.cases[0].steps[0])
      void name
    }
  })
}
