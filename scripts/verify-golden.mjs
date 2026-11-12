// Checks the golden vectors (test/fixtures/golden-algo*.json) on whatever JS engine runs it, no bun needed:
//   node scripts/verify-golden.mjs      (V8)        bun scripts/verify-golden.mjs      (JavaScriptCore)
// Prints the engine, the number of vectors and PASS, or the first mismatch and exits 1. The same vectors run in `bun test` as
// test/randomize-golden.test.ts. Never regenerate them for a released algorithm version.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { hexOfPatch, runCase } from "../test/golden-lib.js"

const dir = join(fileURLToPath(new URL(".", import.meta.url)), "../test/fixtures")
const engine = typeof Bun !== "undefined" ? `bun ${Bun.version} (JavaScriptCore)` : `node ${process.version} (V8)`
let n = 0
for (const f of readdirSync(dir).filter((x) => /^golden-algo\d+\.json$/.test(x))) {
  const golden = JSON.parse(readFileSync(join(dir, f), "utf8"))
  for (const [name, e] of Object.entries(golden.engines)) {
    for (const c of e.cases) {
      const got = hexOfPatch(runCase(e.meta, e.init, c.steps))
      if (got !== c.hex) { console.error(`MISMATCH ${f} ${name} "${c.name}" on ${engine}`); process.exit(1) }
      n++
    }
  }
}
console.log(`${n} golden vectors PASS on ${engine}`)
