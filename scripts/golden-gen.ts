// Writes the golden vectors of a randomizer algorithm version, ONCE (test/fixtures/golden-algo<N>.json), and the metadata canary.
//
//   bun scripts/golden-gen.ts algo 2     first release of algorithm 2 vectors. REFUSES when the file exists: the vectors of a released
//                                        algorithm version are never regenerated (that is the whole point of them). A new algorithm
//                                        version gets its own file, it never overwrites an old one.
//   bun scripts/golden-gen.ts canary     rewrites test/fixtures/meta-canary.json from the host: the metadata the engines have NOW.
//                                        This one MAY be regenerated (after a firmware change), the golden vectors may not.
import { existsSync } from "node:fs"
import { join } from "node:path"
import { HostClient } from "../server/host"
import { build } from "./build"
import { ENGINES } from "../server/engines"
import { casesFor, hexOfPatch, relevantInit, relevantMeta, runCase } from "../test/golden-lib.js"

const dir = join(import.meta.dir, "../test/fixtures")
const [mode, arg] = process.argv.slice(2)
await build()
const host = new HostClient()
const metas: Record<string, any> = {}
for (const e of ENGINES) metas[e] = await host.request({ cmd: "meta", engine: e })
host.close()

if (mode === "canary") {
  const out = Object.fromEntries(ENGINES.map((e) => [e, { meta: relevantMeta(metas[e]), init: relevantInit(metas[e]) }]))
  await Bun.write(join(dir, "meta-canary.json"), JSON.stringify(out))
  console.log("wrote meta-canary.json for", ENGINES.length, "engines")
} else if (mode === "algo" && /^\d+$/.test(arg ?? "")) {
  const file = join(dir, `golden-algo${arg}.json`)
  if (existsSync(file)) {
    console.error(`${file} exists. The golden vectors of algorithm ${arg} are frozen and are never regenerated. Refusing.`)
    process.exit(1)
  }
  if (arg !== "2") {
    console.error("casesFor() in test/golden-lib.ts builds seeds with algorithm 2: adapt it for a new version first")
    process.exit(1)
  }
  const out: any = { algo: Number(arg), note: "FROZEN. Never regenerate. See the header of test/randomize-golden.test.ts.", engines: {} }
  for (const e of ENGINES) {
    const meta = relevantMeta(metas[e]), init = relevantInit(metas[e])
    out.engines[e] = { meta, init, cases: casesFor(meta).map((c) => ({ ...c, hex: hexOfPatch(runCase(meta, init, c.steps)) })) }
  }
  await Bun.write(file, JSON.stringify(out))
  console.log("wrote", file)
} else {
  console.error("usage: bun scripts/golden-gen.ts algo <N> | canary")
  process.exit(1)
}
