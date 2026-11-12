// Writes test/fixtures/pluck-1.0-goldens.json, ONCE, from a checkout whose engines set still holds the PLK 1.0 module (see test/pluck-golden-lib.ts).
// Run it from such a checkout after copying test/pluck-golden-lib.ts, test/fixtures/pluck and this file there. REFUSES to overwrite.
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { goldenHashes, goldenPatches } from "../test/pluck-golden-lib"
import { newHost } from "../test/helpers"

const file = join(import.meta.dir, "../test/fixtures/pluck-1.0-goldens.json")
if (existsSync(file)) { console.error(`${file} exists: the PLK 1.0 goldens are frozen`); process.exit(1) }
const host = await newHost()
const m = await host.request({ cmd: "meta", engine: "PLK" })
if (m.params.length !== 9) { console.error(`this checkout's PLK has ${m.params.length} parameters, the goldens come from PLK 1.0 with 9`); process.exit(1) }
const tmp = mkdtempSync(join(tmpdir(), "plk-golden-"))
const hashes = await goldenHashes(await goldenPatches(host, tmp, m))
host.close()
writeFileSync(file, JSON.stringify({ _comment: "sha256 of the live stream PCM of PLK 1.0 (engines set tag engines-v1.2.0, pluck.wasm sha256 fc10abf705fc8b66a125ef696a5911b522c0083a91b871a4ebe5a7dcc10b435a), key patch|note|velocity", hashes }, null, 1) + "\n")
console.log("wrote", Object.keys(hashes).length, "hashes")
