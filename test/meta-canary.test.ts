// The engine metadata canary: the algorithm reads the engine's parameters (ids, ranges, curves, stepped flags, sections, macros) from
// the host. This compares what the host says NOW with test/fixtures/meta-canary.json (what it said when the canary was last written).
//
// Unlike the golden vectors (test/randomize-golden.test.ts, which carry their own frozen copy of the metadata and may never be
// regenerated), THIS fixture may be regenerated: `bun scripts/golden-gen.ts canary`. A failure here is not a bug in the randomizer, it
// is the news that the firmware or the vendored engines changed. Recipes made before the change replay on the new metadata, end in
// other patch bytes and show the "other patch bytes" warning (the result hash in the recipe, public/recipe.js). Read the diff, then
// regenerate.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { newHost } from "./helpers"
import { SERVED_ENGINES as ENGINES } from "./helpers"
import { ENGINES as ALL_SERVER_ENGINES } from "../server/engines"
import { relevantInit, relevantMeta } from "./golden-lib.js"
import type { HostClient } from "../server/host"

let host: HostClient
beforeAll(async () => { host = await newHost() }, 300_000)
afterAll(() => host.close())

test("the engines have the metadata the canary recorded (a change here changes what old recipes replay to)", async () => {
  const canary = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/meta-canary.json"), "utf8"))
  // the canary holds all eighteen engines, a build without the private runtime modules (PHZ, PLK) checks the rest
  expect(Object.keys(canary).sort()).toEqual(ALL_SERVER_ENGINES.slice().sort())
  expect([...ENGINES].every((e) => e in canary)).toBe(true)
  for (const name of ENGINES) {
    const meta = await host.request({ cmd: "meta", engine: name })
    const now = { meta: relevantMeta(meta), init: relevantInit(meta) }
    const was = canary[name]
    // parameter by parameter, so the message names what moved
    for (const [i, p] of now.meta.params.entries()) expect({ engine: name, ...p }).toEqual({ engine: name, ...was.meta.params[i] })
    expect(now.meta.params.length).toBe(was.meta.params.length)
    expect(now).toEqual(was)
  }
}, 120_000)
