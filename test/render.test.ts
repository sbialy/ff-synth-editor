import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { POLYEND_AND_PLUCK, factoryDir, haveFactory, newHost, parseWav } from "./helpers"
import type { HostClient } from "../server/host"

let host: HostClient
let tmp: string
beforeAll(async () => {
  host = await newHost()
  tmp = mkdtempSync(join(tmpdir(), "poly-editor-render-"))
}, 300_000)
afterAll(() => {
  host.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe.each(POLYEND_AND_PLUCK)("render %s", (engine) => {
  test("default patch gives finite, non-silent 44.1 kHz audio", async () => {
    const out = join(tmp, `${engine}.wav`)
    const r = await host.request({ cmd: "render", engine, note: 57, velocity: 100, seconds: 2, hold: 1, out })
    expect(r.finite).toBe(true)
    expect(r.nonSilent).toBe(true)
    expect(r.peak).toBeGreaterThan(0.01)
    const wav = parseWav(readFileSync(out))
    expect(wav).toMatchObject({ format: 1, channels: 1, rate: 44100, bits: 16 })
    expect(wav.samples.length).toBe(r.frames)
    expect(r.frames).toBeGreaterThanOrEqual(88000)
    expect(wav.samples.every(Number.isFinite)).toBe(true)
    expect(wav.samples.some((s) => Math.abs(s) > 0.01)).toBe(true)
    // the note is held 1 s then released: the last 0.2 s is quieter than the first second
    const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length)
    expect(rms(wav.samples.subarray(wav.samples.length - 8820))).toBeLessThanOrEqual(rms(wav.samples.subarray(0, 44100)))
  })

  test("float32 output and a different note give different audio", async () => {
    const a = join(tmp, `${engine}-a.wav`), b = join(tmp, `${engine}-b.wav`)
    await host.request({ cmd: "render", engine, note: 45, seconds: 1, float: true, out: a })
    await host.request({ cmd: "render", engine, note: 69, seconds: 1, float: true, out: b })
    const wa = parseWav(readFileSync(a)), wb = parseWav(readFileSync(b))
    expect(wa.format).toBe(3)
    expect(wa.samples.length).toBe(wb.samples.length)
    expect(wa.samples.some((v, i) => Math.abs(v - wb.samples[i]) > 1e-3)).toBe(true)
  })
})

test("pitch follows the note: an octave up has twice the zero crossings (ACD saw)", async () => {
  const crossings = async (note: number) => {
    const out = join(tmp, `pitch${note}.wav`)
    await host.request({ cmd: "render", engine: "ACD", note, seconds: 0.5, hold: 0.5, float: true, out })
    const s = parseWav(readFileSync(out)).samples
    let n = 0
    for (let i = 1; i < s.length; i++) if (s[i - 1] <= 0 && s[i] > 0) n++
    return n
  }
  const lo = await crossings(45), hi = await crossings(57)
  expect(hi / lo).toBeGreaterThan(1.8)
  expect(hi / lo).toBeLessThan(2.2)
})

test.skipIf(!haveFactory)("a factory patch renders finite audio with its macros pushed", async () => {
  const patch = (await host.request({ cmd: "load", path: join(factoryDir, "VAP", "5th Analord.patch") })).patch
  const r = await host.request({ cmd: "render", engine: "VAP", patch, macroValues: [100, 100, 100, 100, 100, 100], note: 48, seconds: 1.5, hold: 1 })
  expect(r.finite).toBe(true)
  expect(r.nonSilent).toBe(true)
})
