// Master inserts of the main page (public/inserts.js): the Mixer stage and the two insert slots on the wasm host's chain.
//  - the page's chain (InsertChain, as the worklet and the per-note render run it) gives bit for bit what modules.html's path gives: the engine's
//    live block through ph_block with the inserts set in the host (host/modules.cpp ffmChain)
//  - slot 1 then slot 2 equals each module alone (exact when the first one leaves the int16 grid alone, else within the one int16 step of the cut)
//  - the device's int16 bus fixtures (test/fixtures/inserts, the .plg run in the SDK emulator) through the page's chain
//  - the Mixer: Hard Clip and an empty chain leave the block untouched, Soft Clip and Soft Knee are the firmware's saturate() (compiled from the
//    firmware sources where they are at hand) in both track mixers after the part's soft clip, and they act in front of the inserts
//  - the stored state: unknown mixers fall back, a module that is not installed stays in the slot and plays empty
// Needs emscripten (scripts/build-wasm.ts) and the module sets of modules.lock.json (scripts/modules.ts --from): skipped without them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EMSDK, buildWasm, outDir } from "../scripts/build-wasm"
import { fetchModules, fromDir, lock, setDir } from "../scripts/modules"
import { useTempModules } from "./temp-modules"
import * as ff from "../public/ffmod.js"
import { startServer } from "../server/index"
import { ensureBuilt } from "./helpers"
import { InsertChain, MIXERS, clampParam, defaults, emptyState, normalizeState, parseFloatWav } from "../public/inserts.js"

const haveEmsdk = existsSync(join(EMSDK, "upstream/emscripten/em++"))
const haveSets = existsSync(fromDir(lock.sets["effects-os"]!)) && existsSync(fromDir(lock.sets["engines-os"]!)) // the public sets are enough, the private inserts (Console, Tube) are tested where their set is installed
const fx = join(import.meta.dir, "fixtures/inserts")
type M = any
const SET: Record<string, string> = { phz: "engines", pluck: "engines", console: "effects", tube: "effects", dirt: "effects-os", tape: "effects-os", lofi: "effects-os", bbd: "effects-os", phaser: "effects-os" }
const setOf = (id: string) => SET[id] ?? "engines-os"
const haveMod = (id: string) => existsSync(join(setDir(setOf(id)), `${id}.wasm`))
const bytesOf = (id: string) => new Uint8Array(readFileSync(join(setDir(setOf(id)), `${id}.wasm`)))
const manOf = (id: string) => JSON.parse(readFileSync(join(setDir(setOf(id)), `${id}.json`), "utf8"))
const INSERTS = ["dirt", "tape", "lofi", "bbd", "phaser", "console", "tube"]
const factory = async (): Promise<(o?: object) => Promise<M>> => (await import(join(outDir("runtime"), "poly.mjs"))).default
const req = (m: M, o: object) => JSON.parse(m.UTF8ToString(m.ccall("ph_request", "number", ["string"], [JSON.stringify(o)])))
const f32 = (p: string) => new Float32Array(readFileSync(p).buffer.slice(0))
const hostOf = async () => ff.hostAbi(await (await factory())())

/** InsertChain over a fresh runtime host with the given modules compiled from the installed modules. */
async function chainWith(ids: string[]): Promise<InsertChain> {
  const f = await factory()
  const host = await WebAssembly.compile(readFileSync(join(outDir("runtime"), "poly.wasm")))
  const inserts = await Promise.all(ids.map(async (id) => ({ module: await WebAssembly.compile(bytesOf(id)), man: manOf(id) })))
  return InsertChain.create(f, host, inserts)
}
/** The master values with the limiter out of the path: these tests are about the Mixer and the inserts (the page starts with the limiter on, see the fx page test). */
const offFx = () => { const f = emptyState().fx; f.limiter.on = 0; return f }
const state = (mixer: number, a?: [string, number[]?], b?: [string, number[]?]) => {
  const s = emptyState()
  s.fx = offFx()
  s.mixer = mixer
  for (const [i, x] of [a, b].entries()) if (x) s.slots[i] = { name: manOf(x[0]).name, values: x[1] ?? defaults(manOf(x[0])) }
  return s
}
const maxDiff = (a: Float32Array, b: Float32Array) => { let d = a.length === b.length ? 0 : Infinity; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i])); return d }

/** The engine's mono live blocks of a fixed script: JU6 from its runtime module (public set), notes and a knob turn, `blocks` blocks of 128. */
async function engineBlocks(blocks: number, withState?: (m: M) => void): Promise<{ mono: Float32Array; stereo: Float32Array }> {
  const f = await factory(), m = await f()
  const bytes = bytesOf("ju6"), man = manOf("ju6")
  await ff.verify(bytes, man, ff.hostAbi(m), "synth")
  ff.attachSynth(m, ff.loadModule(m, bytes, man))
  withState?.(m)
  const script: [number, object][] = [[0, { cmd: "live.open", engine: "JU6", voices: 4 }], [0, { cmd: "live.note", on: true, note: 48, velocity: 120 }],
    [30, { cmd: "live.note", on: true, note: 55, velocity: 110 }], [90, { cmd: "live.param", param: 4, knob: 0.6 }], [150, { cmd: "live.note", on: false, note: 48 }],
    [200, { cmd: "live.note", on: true, note: 62, velocity: 127 }]]
  const mono = new Float32Array(blocks * 128), stereo = new Float32Array(blocks * 256)
  for (let b = 0; b < blocks; b++) {
    for (const [at, line] of script) if (at === b) expect(req(m, line).ok).toBe(true)
    const p = m._ph_block() >> 2
    mono.set(m.HEAPF32.subarray(p, p + 128), b * 128) // L is the engine's mono block when the chain does nothing, else the chain's left side
    stereo.set(m.HEAPF32.subarray(p, p + 256), b * 256)
  }
  return { mono, stereo }
}

describe.skipIf(!haveEmsdk || !haveSets)("master inserts on the main page", () => {
  let restoreModules = () => {}
  beforeAll(async () => {
    restoreModules = useTempModules() // the modules are installed in a temp directory, build/modules stays as it is
    await buildWasm("runtime")
    fetchModules(true, { optional: true, downloadIfStale: true })
  }, 600_000)
  afterAll(() => restoreModules())

  test("the page's chain is the modules page chain: engine blocks through InsertChain equal ph_block with the same inserts set in the host, bit for bit", async () => {
    const cases: { name: string; ids: string[]; mixer: number; params?: Record<string, number[]> }[] = [
      { name: "dirt + tape, hard clip", ids: ["dirt", "tape"], mixer: 0 },
      { name: "phaser + lofi, hard clip", ids: ["phaser", "lofi"], mixer: 0 },
      { name: "bbd alone in insert 2, soft clip", ids: ["", "bbd"], mixer: 1 },
      { name: "dirt (drive 90, hard) + phaser, soft knee", ids: ["dirt", "phaser"], mixer: 2, params: { dirt: [1, 90, 16, 1, 100, 100] } },
      { name: "no insert, soft clip", ids: [], mixer: 1 },
      { name: "no insert, soft knee", ids: [], mixer: 2 },
    ]
    if (haveMod("console") && haveMod("tube")) cases.push({ name: "console (private) + tube (private), hard clip", ids: ["console", "tube"], mixer: 0 })
    const blocks = 320
    const raw = await engineBlocks(blocks) // the engine alone: no chain, the block is mono on both sides
    expect(maxDiff(raw.stereo.filter((_, i) => i % 256 < 128), raw.mono)).toBe(0)
    let peak = 0
    for (const v of raw.mono) peak = Math.max(peak, Math.abs(v))
    expect(peak).toBeGreaterThan(0.05) // a signal, not silence
    for (const c of cases) {
      const ids = c.ids.filter(Boolean)
      // modules.html: the host's own chain in ph_block
      const ref = await engineBlocks(blocks, (m) => {
        m._ffm_mixer_set(c.mixer)
        c.ids.forEach((id, slot) => {
          if (!id) return
          const man = manOf(id)
          ff.setInsert(m, slot, ff.loadModule(m, bytesOf(id), man))
          const vals = c.params?.[id] ?? defaults(man)
          vals.forEach((v, i) => m._ffm_insert_param(slot, i, v))
        })
      })
      // the main page: the same engine blocks (raw) through InsertChain
      const chain = await chainWith(ids)
      const st = emptyState()
      st.fx = offFx()
      st.mixer = c.mixer
      c.ids.forEach((id, slot) => { if (id) st.slots[slot] = { name: manOf(id).name, values: c.params?.[id] ?? defaults(manOf(id)) } })
      chain.apply(st)
      const L = new Float32Array(raw.mono.length), R = new Float32Array(raw.mono.length)
      chain.processMono(raw.mono, L, R)
      const refL = ref.stereo.filter((_, i) => i % 256 < 128), refR = ref.stereo.filter((_, i) => i % 256 >= 128)
      expect(maxDiff(L, refL)).toBe(0)
      expect(maxDiff(R, refR)).toBe(0)
      if (c.ids.length || c.mixer) expect(maxDiff(L, raw.mono)).toBeGreaterThan(0) // the chain did something to this signal
      console.log(`${c.name}: page chain equals ph_block over ${blocks} blocks, moved the engine signal by ${maxDiff(L, raw.mono).toFixed(5)}`)
    }
  }, 300_000)

  test("hard clip with both slots empty hands the engine block through untouched, in both channels", async () => {
    const chain = await chainWith(["dirt"])
    expect(chain.active).toBe(false)
    const x = Float32Array.from({ length: 256 }, (_, i) => Math.sin(i * 0.37) * 1.7 + 0.123456789) // beyond full scale too: no clamp, no int16 rounding
    const L = new Float32Array(256), R = new Float32Array(256)
    chain.processMono(x, L, R)
    expect(maxDiff(L, x)).toBe(0)
    expect(maxDiff(R, x)).toBe(0)
    chain.apply(state(0, ["dirt"]))
    expect(chain.active).toBe(true)
    chain.apply(state(0))
    expect(chain.active).toBe(false)
    chain.apply(state(2))
    expect(chain.active).toBe(true) // a Mixer other than Hard Clip works with both slots empty
    chain.apply(emptyState())
    expect(chain.active).toBe(true) // a new state has the limiter on, as the device
  }, 60_000)

  test("slot 1 then slot 2 equals each module run alone: exact after Dirt (its output is on the int16 grid), within 2 int16 steps after the others (the cut between the two runs)", async () => {
    const raw = await engineBlocks(320)
    const run = async (ids: string[], st: ReturnType<typeof emptyState>, input: Float32Array) => {
      const c = await chainWith(ids)
      c.apply(st)
      const L = new Float32Array(input.length), R = new Float32Array(input.length)
      c.processMono(input, L, R)
      return { L, R }
    }
    const pairs: [string, string][] = [["dirt", "tape"], ["dirt", "phaser"], ["tape", "lofi"], ["lofi", "bbd"], ["bbd", "dirt"]]
    if (haveMod("console") && haveMod("tube")) pairs.push(["dirt", "console"], ["console", "tube"])
    for (const [a, b] of pairs) {
      const both = await run([a, b], state(0, [a], [b]), raw.mono)
      const first = await run([a], state(0, [a]), raw.mono)
      const second = await run([b], state(0, [b]), first.L) // slot 2's module alone, fed with what slot 1 gave (mono: L and R of an engine chain are equal only for mono inserts)
      // stereo inserts (BBD, Phaser, ...) give different sides: feed each side through the second module as a stereo pair via the stereo path
      const c2 = await chainWith([b])
      c2.apply(state(0, [b]))
      let worst = 0
      for (let o = 0; o < raw.mono.length; o += 128) {
        const l = Float32Array.from(first.L.subarray(o, o + 128)), r = Float32Array.from(first.R.subarray(o, o + 128))
        c2.processStereo(l, r)
        for (let i = 0; i < 128; i++) worst = Math.max(worst, Math.abs(l[i] - both.L[o + i]), Math.abs(r[i] - both.R[o + i]))
      }
      void second
      const lsb = worst * 32768
      console.log(`${a} then ${b}: two slots vs each alone, worst ${lsb} LSB`)
      expect(lsb).toBeLessThanOrEqual(a === "dirt" ? 0 : 2) // the cut to the int16 grid between the two runs is up to one step, a second module can carry it to two
    }
  }, 300_000)

  for (const id of INSERTS) {
    test(`${id} through the page's chain against the device ${id}.plg in the SDK emulator (int16 bus fixture): within 1 LSB`, async () => {
      if (!haveMod(id)) return // a private module that is not installed here
      const ref = JSON.parse(readFileSync(join(fx, `${id}.json`), "utf8")), sc = ref.scenarios.bus
      const inp = f32(join(fx, `${id}-bus.in.f32`)), out = f32(join(fx, `${id}-bus.out.f32`))
      const chain = await chainWith([id])
      const man = manOf(id)
      const st = state(0, [id], undefined)
      for (const [i, v] of sc.params) st.slots[0].values[i] = v
      chain.apply(st)
      const trunc = (x: number) => Math.max(-32768, Math.min(32767, Math.trunc(Math.fround(x * 32768))))
      let max = 0
      for (let b = 0; b < ref.blocks; b++) {
        for (const [at, i, v] of sc.param_at) if (at === b) { st.slots[0].values[i] = v; chain.apply(st) }
        const l = Float32Array.from(inp.subarray(b * 256, b * 256 + 128)), r = Float32Array.from(inp.subarray(b * 256 + 128, b * 256 + 256))
        chain.processStereo(l, r)
        for (let i = 0; i < 128; i++) {
          max = Math.max(max, Math.abs(l[i] * 32768 - trunc(out[b * 256 + i])), Math.abs(r[i] * 32768 - trunc(out[b * 256 + 128 + i])))
        }
      }
      console.log(`${id} (${man.name}) bus, page chain vs emulated .plg: max ${max} LSB`)
      expect(max).toBeLessThanOrEqual(1)
      if (id !== "dirt") expect(max).toBe(0) // Dirt alone differs by a known fused multiply-add of the ARM build
    }, 120_000)
  }

  test("the Mixer is the firmware's saturate() in both track mixers: the engine block is soft clipped to int16 by the part, then Soft Clip or Soft Knee act on the dry sum and again on the sum with the returns", async () => {
    const chain = await chainWith([])
    const xs: number[] = []
    for (let k = -70000; k <= 70000; k += 37) xs.push(k) // int16 units, beyond full scale both ways
    for (const k of [0, 1, -1, 23196, 23197, 23198, -23197, -23198, 32767, -32768, 32768, 100000, -100000, 524288, -524288]) xs.push(k)
    // two silent blocks are appended: the engine block meets the mixers two passes later (the panning amplifier is updated before the part, see docs/fx-device-facts.md)
    const sig = Float32Array.from({ length: Math.ceil(xs.length / 128) * 128 + 256 }, (_, i) => (i < xs.length ? xs[i] / 32768 : 0))
    const run = (mixer: number) => {
      const c = { L: new Float32Array(sig.length), R: new Float32Array(sig.length) }
      chain.apply({ mixer, slots: [{ name: null, values: [] }, { name: null, values: [] }], fx: offFx() })
      chain.processMono(sig, c.L, c.R)
      return c.L.map((v) => Math.round(v * 32768) + 0) // + 0: no negative zero
    }
    // the references, written from the firmware text. PolySynth::update: saturateSoftClip(buf, 0 dB) in float32 and * INT16_MAX truncated; the mixers: dspApplyGain.cpp saturate()
    // on the int32 sum (the unity gain of one input changes nothing), sat_softknee.h
    const f = Math.fround
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
    const part = (x: number) => { // the part's tap, int16
      const s = f(clamp(x, -1.5, 1.5)), t = f(s - f(f(f(s * s) * s) * f(1 / 6.72)))
      return Math.trunc(f(clamp(t, -1, 1) * 32767))
    }
    const clamp16 = (v: number) => clamp(v, -32768, 32767)
    const mul = (x: number, y: number, z: number) => Number((BigInt(x) * BigInt(y)) >> BigInt(31 - z))
    const soft = (i: number) => clamp16(i - mul(mul(mul(i, i, 16), i, 16), Math.trunc(65536 / 6.72), 15))
    const knee = (i: number) => {
      const a = Math.abs(i), K = 23197, R = 32767 - K
      if (a <= K) return i
      const y = K + R - Math.floor((R * R) / (R + a - K))
      return i < 0 ? -y : y
    }
    const hard = run(0), sc = run(1).slice(256), sk = run(2).slice(256)
    const taps = Array.from(sig.subarray(0, sig.length - 256), (v) => part(v))
    taps.forEach((s0, i) => {
      expect(hard[i]).toBe(Math.trunc(f(sig[i] * 32768))) // Hard Clip, no insert and no send: the chain does nothing (no clamp, no rounding, no delay), the host's block as it is
      expect(sc[i]).toBe(soft(soft(s0)) + 0)
      expect(sk[i]).toBe(knee(knee(s0)) + 0)
    })
    // sanity: the model and the chain agree at full scale, silence stays silence
    expect(sc[xs.indexOf(32767)]).toBe(soft(soft(part(32767 / 32768))) + 0)
    expect(sk[xs.indexOf(0)]).toBe(0)
    const poly = [process.env.POLY_REPO ?? ""].find((d) => d && existsSync(join(d, "synth-open/sat_softknee.h")))
    if (!poly) return
    const dir = mkdtempSync(join(tmpdir(), "poly-editor-sat-"))
    const src = join(dir, "ref.cpp")
    await Bun.write(src, `#include "sat_softknee.h"
#include <cstdio>
#include <cstdint>
static int32_t mul(int32_t x, int32_t y, int z) { return (int32_t)(((int64_t)x * y) >> (31 - z)); }
static int16_t sat16(int32_t v) { return v > 32767 ? 32767 : (v < -32768 ? -32768 : v); }
int main() { int32_t x; while (scanf("%d", &x) == 1) { int32_t o = x - mul(mul(mul(x, x, 16), x, 16), (int32_t)((1 << 16) / 6.72f), 15); printf("%d %d %d\\n", sat16(x), sat16(o), softknee::apply(x)); } }
`)
    const exe = join(dir, "ref")
    const cc = Bun.spawnSync(["c++", "-std=c++20", "-O1", "-I", join(poly, "synth-open"), src, "-o", exe])
    expect(cc.exitCode).toBe(0)
    const pass = (ints: number[]) => Bun.spawnSync([exe], { stdin: new TextEncoder().encode(ints.join("\n") + "\n") }).stdout.toString().trim().split("\n").map((l) => l.split(" ").map(Number))
    const one = pass(taps), softOnce = one.map((r) => r[1]), kneeOnce = one.map((r) => r[2])
    const two = pass(softOnce), three = pass(kneeOnce)
    expect(two.length).toBe(taps.length)
    taps.forEach((_, i) => { expect(sc[i]).toBe(two[i][1]); expect(sk[i]).toBe(three[i][2]) })
    console.log(`Mixer (two passes) against the firmware sources (${poly}): ${taps.length} samples, 0 LSB`)
  }, 120_000)

  test("the Mixer stands in front of the inserts: a hot signal is cut to the int16 bus first, the insert hears the cut one", async () => {
    const hot = Float32Array.from({ length: 640 }, (_, i) => Math.sin(i * 0.2) * 3) // five blocks: the first two only fill the mixers' pipeline
    const withIns = await chainWith(["tape"]), alone = await chainWith([])
    withIns.apply(state(1, ["tape", [0, 0, 0, 100]]))   // Tape at Drive 0, Wow 0, Flutter 0, Mix 100: close to transparent
    alone.apply(state(1))
    const a = [new Float32Array(640), new Float32Array(640)], b = [new Float32Array(640), new Float32Array(640)]
    withIns.processMono(hot, a[0], a[1])
    alone.processMono(hot, b[0], b[1])
    let peak = 0
    for (const v of a[0].subarray(384)) peak = Math.max(peak, Math.abs(v))
    expect(peak).toBeLessThanOrEqual(1) // nothing above full scale got into the insert
    // the insert heard the Soft Clip output (about 0.85 at most), not the raw 3.0: its output stays in that range
    expect(peak).toBeGreaterThan(0.2)
  }, 60_000)

  test("state: unknown mixers fall back to Hard Clip, values are cut to the module's ranges and steps, a module that is not installed stays in its slot and plays empty", async () => {
    const mods = [{ man: manOf("dirt") }, { man: manOf("tape") }]
    expect(normalizeState(null, mods)).toEqual(emptyState())
    // the limiter is on in a new state and in any stored one: an older session stored on 0 (it was off by default), that is not read back, its other values are
    expect(emptyState().fx.limiter.on).toBe(1)
    const old = normalizeState({ mixer: 0, slots: [], fx: { limiter: { on: 0, mode: 1, attack: 300, release: 40, threshold: 60 } } }, mods)
    expect(old.fx.limiter).toEqual({ mode: 1, attack: 300, release: 40, threshold: 60, on: 1 })
    expect(normalizeState({ mixer: 0, slots: [], fx: { limiter: { on: 1 } } }, mods).fx.limiter.on).toBe(1)
    expect(normalizeState({ mixer: 7, slots: [] }, mods).mixer).toBe(0)
    expect(normalizeState({ mixer: 2, slots: [] }, mods).mixer).toBe(2)
    const n = normalizeState({ mixer: 1, slots: [{ name: "Dirt", values: [9, 500, -3] }, { name: "Gone", values: [1, 2] }] }, mods)
    expect(n.slots[0]).toEqual({ name: "Dirt", values: [3, 100, 4, 1, 100, 100] }) // Type 3 (Asym) at most, Drive 100, Bits 4, the rest at their defaults
    expect(n.slots[1]).toEqual({ name: "Gone", values: [1, 2] })
    expect(clampParam(manOf("dirt").params[2], 9.4)).toBe(9)
    expect(MIXERS).toEqual(["Hard Clip", "Soft Clip", "Soft Knee"])
    // the chain: a name it does not have leaves the slot empty, nothing throws
    const chain = await chainWith(["dirt"])
    expect(chain.has("Dirt")).toBe(true)
    expect(chain.has("Gone")).toBe(false)
    n.fx.limiter.on = 0 // the limiter would move the signal too
    chain.apply(n)
    const x = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i * 0.1) * 0.5)
    const L = new Float32Array(128), R = new Float32Array(128)
    chain.processMono(x, L, R)
    expect(maxDiff(L, x)).toBeGreaterThan(0) // Dirt in slot 1 works, the missing one does not
    chain.apply({ mixer: 0, slots: [{ name: "Gone", values: [] }, { name: null, values: [] }], fx: offFx() })
    chain.processMono(x, L, R)
    expect(maxDiff(L, x)).toBe(0)
  }, 60_000)

  test("a float WAV (the server's render with float:true) parses, anything else does not", () => {
    const w = new Uint8Array(44 + 8)
    const dv = new DataView(w.buffer)
    w.set(new TextEncoder().encode("RIFF"), 0); dv.setUint32(4, 36 + 8, true); w.set(new TextEncoder().encode("WAVEfmt "), 8)
    dv.setUint32(16, 16, true); dv.setUint16(20, 3, true); dv.setUint16(22, 1, true); dv.setUint32(24, 44117, true); dv.setUint32(28, 44117 * 4, true)
    dv.setUint16(32, 4, true); dv.setUint16(34, 32, true); w.set(new TextEncoder().encode("data"), 36); dv.setUint32(40, 8, true); dv.setFloat32(44, 0.25, true); dv.setFloat32(48, -0.5, true)
    expect(parseFloatWav(w.buffer)).toEqual({ rate: 44117, samples: Float32Array.from([0.25, -0.5]) })
    dv.setUint16(20, 1, true)
    expect(parseFloatWav(w.buffer)).toBeNull()
  })

  test("the per-note render of the page: /api/render with float:true gives a float32 mono WAV the chain takes, without it the 16 bit WAV as before", async () => {
    await ensureBuilt()
    const srv = await startServer({ port: 0, dir: mkdtempSync(join(tmpdir(), "poly-editor-ins-render-")) })
    try {
      const post = async (extra: object) => {
        const r = await fetch(srv.url + "/api/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "ACD", patch: (await (await fetch(srv.url + "/api/meta/ACD")).json()).init, note: 57, velocity: 100, seconds: 0.6, hold: 0.4, ...extra }) })
        expect(r.status).toBe(200)
        return r.arrayBuffer()
      }
      const plain = await post({}), flt = await post({ float: true })
      expect(new DataView(plain).getUint16(20, true)).toBe(1) // PCM 16 bit, as the page's decodeAudioData path always had
      const w = parseFloatWav(flt)
      expect(w).not.toBeNull()
      expect(w!.rate).toBe(44100) // the render's own rate (kOutRate), the chain works on its blocks as they come
      expect(w!.samples.length).toBe((plain.byteLength - 44) / 2)
      let peak = 0
      for (const v of w!.samples) peak = Math.max(peak, Math.abs(v))
      expect(peak).toBeGreaterThan(0.01)
      // and through the chain: Dirt changes it, bit for bit what the chain gives for these very samples on a second run
      const chain = await chainWith(["dirt"])
      chain.apply(state(0, ["dirt", [1, 90, 16, 1, 100, 100]]))
      const L = new Float32Array(w!.samples.length), R = new Float32Array(w!.samples.length)
      chain.processMono(w!.samples, L, R)
      expect(maxDiff(L, w!.samples)).toBeGreaterThan(0.01)
      const again = await chainWith(["dirt"])
      again.apply(state(0, ["dirt", [1, 90, 16, 1, 100, 100]]))
      const L2 = new Float32Array(L.length), R2 = new Float32Array(L.length)
      again.processMono(w!.samples, L2, R2)
      expect(maxDiff(L2, L)).toBe(0)
      // reset() starts a render from the module's initial state: the second render through the same chain equals the first
      chain.reset(); chain.apply(state(0, ["dirt", [1, 90, 16, 1, 100, 100]]))
      const L3 = new Float32Array(L.length), R3 = new Float32Array(L.length)
      chain.processMono(w!.samples, L3, R3)
      expect(maxDiff(L3, L)).toBe(0)
    } finally { srv.stop() }
  }, 120_000)
})
