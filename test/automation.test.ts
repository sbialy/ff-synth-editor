// tracker-ff 1.2.0 .patch field 64 (synth automation, open_patchdata.h ModSlot): the editor keeps the block raw and does not show or render it.
// A patch with automation loads, its block travels in the patch's "extra" bytes, and saving it writes the same file byte for byte.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newHost } from "./helpers"
import type { HostClient } from "../server/host"

let host: HostClient
let tmp: string
beforeAll(async () => {
  host = await newHost()
  tmp = mkdtempSync(join(tmpdir(), "poly-editor-auto-"))
}, 300_000)
afterAll(() => {
  host?.close()
  rmSync(tmp, { recursive: true, force: true })
})

// field 64 (tag 0x82 0x04, length delimited): {1 version 1, 2 Slot{1 type 1 (LFO), 3 index 2, 6 amount sint32 40}}
const slot = [0x08, 0x01, 0x18, 0x02, 0x30, 0x50]
const body = [0x08, 0x01, 0x12, slot.length, ...slot]
const block = Buffer.from([0x82, 0x04, body.length, ...body])

for (const engine of ["ACD", "WTFM", "CHIP"]) {
  test(`${engine}: a patch with automation (field 64) loads and saves byte for byte, the block kept raw`, async () => {
    const m = await host.request({ cmd: "meta", engine })
    mkdirSync(join(tmp, engine), { recursive: true })
    const plain = join(tmp, engine, "plain.patch")
    await host.request({ cmd: "save", path: plain, patch: m.init })
    const withAuto = Buffer.concat([readFileSync(plain), block]) // field 64 is the highest field number: last in the file, as the firmware writes it
    const src = join(tmp, engine, "auto.patch")
    writeFileSync(src, withAuto)
    const l = await host.request({ cmd: "load", path: src, engine })
    expect(l.patch.engine).toBe(engine)
    expect(l.patch.values).toEqual(m.init.values) // the sound's own values are untouched
    expect(l.patch.extra.hex).toContain(block.toString("hex")) // the block rides along raw
    const out = join(tmp, engine, "resaved.patch")
    await host.request({ cmd: "save", path: out, patch: l.patch })
    expect(readFileSync(out).equals(withAuto)).toBe(true)
    expect(await host.request({ cmd: "roundtrip", path: src })).toMatchObject({ loaded: true, identical: true, engine })
    // a patch without automation is as before: no field 64 written
    expect(readFileSync(plain).includes(Buffer.from([0x82, 0x04]))).toBe(false)
  })
}
