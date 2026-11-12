// Runtime modules (public/ffmod.js, host/modules.cpp): engines and master inserts that arrive as .wasm files instead of being linked in.
// Four sets, one loader (modules.lock.json): "engines-os" and "effects-os" (public: the OpenTracker engines such as JU6 and the OpenTracker inserts), "engines" (private
// repository: PHZ and PLK) and "effects" (private repository: console and tube).
//  - PHZ, PLK and JU6 (a public engine) loaded at run time into the "runtime" wasm host render bit identical to the same engines linked into the
//    "linked" wasm host (offline renders of many patches and the live block path), and the runtime host has no code of them
//  - every insert .wasm (dirt tape lofi bbd phaser from the public set, console and tube from the private one) against its device twin .plg, whose
//    ARM code the firmware SDK's emulator ran (test/fixtures/inserts, scripts/insert-ref.py): within 1 LSB, Dirt's known cause below
//  - the master chain engine -> insert 1 -> insert 2 with the device's int16 bus math
//  - modules with a wrong ABI, a wrong hash, a wrong kind or wrong numbers are refused, and a set cannot vouch for a module of another visibility
// Needs emscripten (scripts/build-wasm.ts, EMSDK) and the module sets of modules.lock.json (scripts/modules.ts --from): skipped without them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EMCC_VERSION, EMSDK, RUNTIME_ENGINES, buildWasm, common, missingPrivateSource, outDir } from "../scripts/build-wasm"
import { compatProblems, fetchModules, fromDir, lock, modulesDir, setDir } from "../scripts/modules"
import { useTempModules } from "./temp-modules"
import * as ff from "../public/ffmod.js"
import { applyPlan, randomize } from "../public/randomize.js"

const root = join(import.meta.dir, "..")
const haveEmsdk = existsSync(join(EMSDK, "upstream/emscripten/em++"))
// the "linked" wasm host is the dev-only reference with PHZ and PLK compiled in: it needs their unpublished source (POLY_PRIVATE_SOURCE=1 scripts/vendor.sh)
const haveLinked = missingPrivateSource().length === 0
const testL = haveLinked ? test : test.skip
const haveSets = Object.values(lock.sets).every((s) => existsSync(fromDir(s)))
const fx = join(import.meta.dir, "fixtures/inserts")

type M = any
const host = async (t: "linked" | "runtime"): Promise<M> => (await import(join(outDir(t), "poly.mjs"))).default()
const req = (m: M, o: object) => JSON.parse(m.UTF8ToString(m.ccall("ph_request", "number", ["string"], [JSON.stringify(o)])))
// where each module comes from (modules.lock.json): the two public sets are the OpenTracker ports (engines-os, effects-os), the other two hold the FF modules
const SET: Record<string, string> = { phz: "engines", pluck: "engines", console: "effects", tube: "effects", dirt: "effects-os", tape: "effects-os", lofi: "effects-os", bbd: "effects-os", phaser: "effects-os" }
const setOf = (id: string) => SET[id] ?? "engines-os"
const modBytes = (id: string) => new Uint8Array(readFileSync(join(setDir(setOf(id)), `${id}.wasm`)))
const manOf = (id: string) => JSON.parse(readFileSync(join(setDir(setOf(id)), `${id}.json`), "utf8"))
/** The engines that arrive at run time: picker name, module id, a note for the live test, a parameter to turn. */
const ENGINES = [{ name: "PHZ", id: "phz", knob: 19 }, { name: "PLK", id: "pluck", knob: 2 }, { name: "JU6", id: "ju6", knob: 4 }]
const INSERTS = ["dirt", "tape", "lofi", "bbd", "phaser", "console", "tube"]
function wavPcm(m: M, path: string): Float32Array {
  const buf = Buffer.from(m.FS.readFile(path))
  for (let o = 12; o < buf.length; ) {
    const id = buf.toString("ascii", o, o + 4), n = buf.readUInt32LE(o + 4)
    if (id === "data") return new Float32Array(buf.buffer.slice(buf.byteOffset + o + 8, buf.byteOffset + o + 8 + n))
    o += 8 + n
  }
  throw new Error("no data chunk")
}
const maxDiff = (a: Float32Array, b: Float32Array) => { let d = a.length === b.length ? 0 : Infinity; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i])); return d }

async function runtimeWith(...ids: string[]): Promise<M> {
  const m = await host("runtime")
  for (const id of ids) {
    const bytes = modBytes(id), man = manOf(id)
    await ff.verify(bytes, man, ff.hostAbi(m), "synth")
    ff.attachSynth(m, ff.loadModule(m, bytes, man))
  }
  return m
}
async function withInsert(m: M, slot: number, name: string) {
  const bytes = modBytes(name), man = manOf(name)
  await ff.verify(bytes, man, ff.hostAbi(m), "master")
  const loaded = ff.loadModule(m, bytes, man)
  ff.setInsert(m, slot, loaded)
  return loaded
}

// the public SDK example insert (tilt.c), built here with the module runtime of host/sdk, once as it should be and once claiming module ABI 2
const tiltDir = mkdtempSync(join(tmpdir(), "poly-editor-tilt-"))
async function buildTilt(name: string, extra: string[]) {
  const em = (t: string) => join(EMSDK, "upstream/emscripten", t)
  const env = { ...process.env, EM_CACHE: join(EMSDK, "upstream/emscripten/cache") }
  const flags = ["-O2", "-fPIC", "-fvisibility=hidden", "-sSIDE_MODULE=2", "-I", join(root, "host/sdk")]
  for (const [src, o, more] of [[join(import.meta.dir, "fixtures/modules/tilt.c"), "t.o", []], [join(root, "host/sdk/plug_rt_wasm.c"), "rt.o", ["-fno-builtin", ...extra]]] as const) {
    const p = Bun.spawnSync([em("emcc"), ...flags, ...more, "-c", src, "-o", join(tiltDir, name + o)], { env })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
  }
  const wasm = join(tiltDir, name + ".wasm")
  const l = Bun.spawnSync([em("emcc"), "-O2", "-g0", "-sSIDE_MODULE=2", "-sEXPORTED_FUNCTIONS=_plug_entry,_plug_wasm_abi", join(tiltDir, name + "t.o"), join(tiltDir, name + "rt.o"), "-o", wasm], { env })
  if (l.exitCode !== 0) throw new Error(l.stderr.toString())
  const bytes = new Uint8Array(readFileSync(wasm))
  const man = { format: "ffmod", format_version: 1, id: "org.example.fx.tilt", kind: "master", name: "Tilt", version: "1.0.0", abi: "1.1", min_host: 1,
    wasm_abi: extra.length ? "2.0" : "1.0", files: { wasm: { name: name + ".wasm", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } },
    params: [{ name: "Gain" }, { name: "Tilt" }, { name: "Pivot" }] }
  return { bytes, man }
}

describe.skipIf(!haveEmsdk || !haveSets)("runtime modules", () => {
  let restoreModules = () => {}
  beforeAll(async () => {
    restoreModules = useTempModules() // the modules are installed in a temp directory, build/modules stays as it is
    if (haveLinked) await buildWasm("linked")
    await buildWasm("runtime")
    fetchModules(true)
  }, 600_000)
  afterAll(() => restoreModules())

  testL("the runtime host carries no code of PHZ, PLK or JU6: the sources are not compiled, their parameter names are not in the binary, they are listed only once attached", async () => {
    const objs = readdirSync(join(root, "build/wasm/obj-runtime"))
    const bin = (t: string) => readFileSync(join(outDir(t as any), "poly.wasm")).toString("latin1")
    const bare = await host("runtime"), l = await host("linked")
    const names = req(bare, { cmd: "engines" }).engines.map((e: any) => e.name)
    for (const e of ENGINES) {
      for (const src of RUNTIME_ENGINES[e.name]) expect(objs.some((o) => o.includes(src.replace(/[\/.]/g, "_")))).toBe(false)
      // parameter names the linked host has and the runtime host lacks (a name another engine shares is in both, it proves nothing)
      const params: string[] = req(l, { cmd: "meta", engine: e.name }).params.map((p: any) => p.name)
      const only = params.filter((n) => bin("linked").includes(n) && !bin("runtime").includes(n))
      expect(only.length).toBeGreaterThanOrEqual(3)
      expect(names).not.toContain(e.name)
      expect(req(bare, { cmd: "meta", engine: e.name })).toMatchObject({ ok: false, error: `unknown engine '${e.name}'` })
    }
    expect(objs.some((o) => /engine_phz|engine_pluck|engine_ju6|ot-synths_ju6|ot_synths_ju6/.test(o))).toBe(false)
    const m = await runtimeWith(...ENGINES.map((e) => e.id))
    expect(req(m, { cmd: "engines" })).toEqual(req(l, { cmd: "engines" }))
    for (const e of ENGINES) expect(req(m, { cmd: "meta", engine: e.name })).toEqual(req(l, { cmd: "meta", engine: e.name }))
    expect(req(m, { cmd: "firmware" })).toEqual(req(l, { cmd: "firmware" }))
  }, 120_000)

  for (const E of ENGINES) {
    testL(`${E.name} loaded at run time (${setOf(E.id)} set) renders bit identical to the linked-in one: init, every parameter at its min and max, 16 random patches`, async () => {
      const m = await runtimeWith(E.id), l = await host("linked")
      const meta = req(l, { cmd: "meta", engine: E.name })
      const patches: { name: string; patch: any }[] = [{ name: "init", patch: meta.init }]
      meta.params.forEach((p: any, i: number) => {
        for (const v of [p.min, p.max]) { const q = structuredClone(meta.init); q.values[i] = v; patches.push({ name: `${p.name}=${v}`, patch: q }) }
      })
      for (let s = 1; s <= 16; s++) patches.push({ name: `seed ${s}`, patch: applyPlan(meta.init, randomize(meta, meta.init, { seed: s, percent: 100, macros: true })) })
      let silent = 0
      for (const { name, patch } of patches) {
        const r = { cmd: "render", patch, note: 45 + (name.length % 24), velocity: 100, seconds: 0.6, hold: 0.4, voices: Math.min(3, meta.maxVoices ?? 3), float: true, out: "/x.wav" }
        const a = req(l, r), b = req(m, r)
        expect(b.ok).toBe(true)
        const d = maxDiff(wavPcm(l, "/x.wav"), wavPcm(m, "/x.wav"))
        if (d !== 0) throw new Error(`${E.name} ${name}: max abs diff ${d}`)
        expect(b.peak).toBe(a.peak)
        if (!(a.peak > 0)) silent++
        expect(req(m, { cmd: "encode", patch })).toEqual(req(l, { cmd: "encode", patch }))
      }
      expect(patches.length).toBe(1 + 2 * meta.params.length + 16)
      expect(silent).toBeLessThan(patches.length / 4) // the comparison is of sound, not of silence
    }, 300_000)

    testL(`${E.name} live block path: notes, knob turns and a patch switch, 600 blocks, bit identical, and no insert leaves the block untouched`, async () => {
      const m = await runtimeWith(E.id), l = await host("linked")
      const meta = req(l, { cmd: "meta", engine: E.name })
      const p2 = applyPlan(meta.init, randomize(meta, meta.init, { seed: 77, percent: 100 }))
      const script: [number, object][] = [[0, { cmd: "live.open", engine: E.name, voices: 4 }], [0, { cmd: "live.note", on: true, note: 48, velocity: 110 }],
        [20, { cmd: "live.note", on: true, note: 55, velocity: 90 }], [60, { cmd: "live.param", param: E.knob, knob: 0.3 }], [120, { cmd: "live.note", on: false, note: 48 }],
        [200, { cmd: "live.patch", patch: p2 }], [210, { cmd: "live.note", on: true, note: 60, velocity: 100 }], [400, { cmd: "live.panic" }]]
      for (const h of [m, l]) h.blocks = []
      for (let b = 0; b < 600; b++) {
        for (const [at, line] of script) if (at === b) for (const h of [m, l]) expect(req(h, line).ok).toBe(true)
        for (const h of [m, l]) { const p = h._ph_block() >> 2; h.blocks.push(Float32Array.from(h.HEAPF32.subarray(p, p + 256))) }
      }
      let peak = 0
      for (let b = 0; b < 600; b++) {
        expect(maxDiff(m.blocks[b], l.blocks[b])).toBe(0)
        for (let i = 0; i < 128; i++) { expect(m.blocks[b][128 + i]).toBe(m.blocks[b][i]); peak = Math.max(peak, Math.abs(m.blocks[b][i])) }
      }
      expect(peak).toBeGreaterThan(0.05)
    }, 120_000)
  }

  testL("all three engines at once in one runtime host: still bit identical to the linked host, each in its own slot", async () => {
    const m = await runtimeWith(...ENGINES.map((e) => e.id)), l = await host("linked")
    for (const E of ENGINES) {
      const meta = req(l, { cmd: "meta", engine: E.name })
      const r = { cmd: "render", patch: meta.init, note: 52, velocity: 100, seconds: 0.5, hold: 0.3, voices: 2, float: true, out: "/x.wav" }
      expect(req(l, r).ok).toBe(true)
      expect(req(m, r).ok).toBe(true)
      expect(maxDiff(wavPcm(l, "/x.wav"), wavPcm(m, "/x.wav"))).toBe(0)
    }
  }, 120_000)

  const fixture = (id: string) => JSON.parse(readFileSync(join(fx, `${id}.json`), "utf8"))
  const f32 = (p: string) => new Float32Array(readFileSync(p).buffer.slice(0))

  for (const id of INSERTS) {
    test(`${id}.wasm (${setOf(id)} set) against the device ${id}.plg run in the SDK emulator: within 1 LSB, and the reference is that very .plg`, async () => {
      const ref = fixture(id)
      expect(ref.plg_sha256).toBe(manOf(id).files.plg.sha256)
      let worst = 0
      for (const [name, sc] of Object.entries<any>(ref.scenarios)) {
        if (sc.int16_input) continue
        const m = await host("runtime")
        await withInsert(m, 0, id)
        for (const [i, v] of sc.params) m._ffm_insert_param(0, i, v)
        const inp = f32(join(fx, `${id}-${name}.in.f32`)), out = f32(join(fx, `${id}-${name}.out.f32`))
        const L = m._ffm_buf(0) >> 2, R = m._ffm_buf(1) >> 2
        let max = 0, n = 0
        for (let b = 0; b < ref.blocks; b++) {
          for (const [at, i, v] of sc.param_at) if (at === b) m._ffm_insert_param(0, i, v)
          m.HEAPF32.set(inp.subarray(b * 256, b * 256 + 128), L)
          m.HEAPF32.set(inp.subarray(b * 256 + 128, b * 256 + 256), R)
          m._ffm_insert_process_raw(0)
          for (let i = 0; i < 128; i++) for (const [o, k] of [[L, 0], [R, 128]]) {
            const d = Math.abs(m.HEAPF32[o + i] - out[b * 256 + k + i]) * 32768
            max = Math.max(max, d)
            n += d ? 1 : 0
          }
        }
        // Dirt: the ARM build of ff_dirt_ctl.cpp (-Os, GCC's default contraction) fuses 1 + 15 d^2 into one vfma, wasm has no fused multiply-add:
        // Coef::pre can be one ulp apart, which moves a few output samples by one int16 step (with that ARM object built unfused: 0 difference)
        console.log(`${id} ${name}: max ${max} LSB, ${n} of ${inp.length} samples differ`)
        expect(max).toBeLessThanOrEqual(1)
        expect(n).toBeLessThan(inp.length / 100)
        worst = Math.max(worst, max)
      }
      if (id !== "dirt") expect(worst).toBeLessThanOrEqual(1)
    }, 120_000)

    test(`${id}: the device's int16 bus math in the chain (int16 in, int16 out), within 1 LSB of the emulated device`, async () => {
      const ref = fixture(id), sc = ref.scenarios.bus
      const inp = f32(join(fx, `${id}-bus.in.f32`)), out = f32(join(fx, `${id}-bus.out.f32`))
      const m = await host("runtime")
      await withInsert(m, 0, id)
      for (const [i, v] of sc.params) m._ffm_insert_param(0, i, v)
      const L = m._ffm_buf(0) >> 2
      const trunc = (x: number) => { const v = Math.trunc(Math.fround(x * 32768)); return Math.max(-32768, Math.min(32767, v)) }
      let max = 0
      for (let b = 0; b < ref.blocks; b++) {
        for (const [at, i, v] of sc.param_at) if (at === b) m._ffm_insert_param(0, i, v)
        m.HEAPF32.set(inp.subarray(b * 256, b * 256 + 256), L) // L and R are adjacent in ffm_buf
        m._ffm_chain_buf()
        for (let i = 0; i < 256; i++) max = Math.max(max, Math.abs(m.HEAPF32[L + i] * 32768 - trunc(out[b * 256 + i])))
      }
      console.log(`${id} bus (chain): max ${max} LSB`)
      expect(max).toBeLessThanOrEqual(1)
    }, 120_000)
  }

  test("master chain: insert 2 runs on the output of insert 1 (Dirt, then Console from the private set, then the SDK example Tilt), bypass and empty slots", async () => {
    const ref = fixture("dirt"), sc = ref.scenarios.bus
    const inp = f32(join(fx, "dirt-bus.in.f32"))
    const m = await host("runtime")
    await withInsert(m, 0, "dirt")
    for (const [i, v] of sc.params) m._ffm_insert_param(0, i, v)
    const L = m._ffm_buf(0) >> 2
    const chained: Float32Array[] = []
    for (let b = 0; b < ref.blocks; b++) {
      m.HEAPF32.set(inp.subarray(b * 256, b * 256 + 256), L)
      m._ffm_chain_buf()
      chained.push(Float32Array.from(m.HEAPF32.subarray(L, L + 256)))
    }
    // insert 2 runs on what insert 1 gave: Dirt then X equals Dirt alone followed by X alone (Dirt's output is on the int16 grid already)
    const tilt = await buildTilt("tilt", [])
    const second: [string, (h: M) => Promise<void>][] = [
      ["console", async (h) => { await withInsert(h, 1, "console"); h._ffm_insert_param(1, 0, 80) }],   // Console Drive 80 %
      ["tilt", async (h) => { ff.setInsert(h, 1, ff.loadModule(h, tilt.bytes, tilt.man)); h._ffm_insert_param(1, 1, 4) }],   // Tilt +4 dB
    ]
    for (const [name, put] of second) {
      const two = await host("runtime"), one = await host("runtime")
      await withInsert(two, 0, "dirt")
      await put(two)
      // the same module alone in slot 0 of a second host (put() fills slot 1: move it by loading into slot 0 there)
      if (name === "console") { await withInsert(one, 0, "console"); one._ffm_insert_param(0, 0, 80) }
      else { ff.setInsert(one, 0, ff.loadModule(one, tilt.bytes, tilt.man)); one._ffm_insert_param(0, 1, 4) }
      for (const [i, v] of sc.params) two._ffm_insert_param(0, i, v)
      let maxOrder = 0, moved = 0
      for (let b = 0; b < ref.blocks; b++) {
        const a = two._ffm_buf(0) >> 2, c = one._ffm_buf(0) >> 2
        two.HEAPF32.set(inp.subarray(b * 256, b * 256 + 256), a)
        two._ffm_chain_buf()
        one.HEAPF32.set(chained[b], c)
        one._ffm_chain_buf()
        for (let i = 0; i < 256; i++) { maxOrder = Math.max(maxOrder, Math.abs(two.HEAPF32[a + i] - one.HEAPF32[c + i])); moved = Math.max(moved, Math.abs(two.HEAPF32[a + i] - chained[b][i])) }
      }
      expect(maxOrder).toBe(0)
      expect(moved).toBeGreaterThan(0.001) // the second slot did something
    }
    // bypassed and empty: the block passes untouched (no int16 rounding either)
    m._ffm_insert_bypass(0, 1)
    const x = Float32Array.from({ length: 256 }, (_, i) => Math.sin(i * 0.1) * 0.123456789)
    m.HEAPF32.set(x, L)
    m._ffm_chain_buf()
    expect(maxDiff(Float32Array.from(m.HEAPF32.subarray(L, L + 256)), x)).toBe(0)
  }, 120_000)

  test("refused: module ABI 2 (by the manifest, and by plug_wasm_abi() when the manifest lies), plugin ABI 2, a wrong hash, a wrong kind, a late engine, a second attach", async () => {
    const m = await host("runtime"), h = ff.hostAbi(m)
    expect(h).toEqual({ abi: "1.1", wasmAbi: "1.0", level: 1 })
    const bad = await buildTilt("tilt2", ["-DPLUG_RT_WASM_ABI=((2<<16)|0)"])
    await expect(ff.verify(bad.bytes, bad.man, h, "master")).rejects.toThrow("module ABI 2.0, this host loads 1.0")
    const lie = { ...bad.man, wasm_abi: "1.0" }
    await ff.verify(bad.bytes, lie, h, "master") // the manifest alone passes
    expect(() => ff.loadModule(m, bad.bytes, lie)).toThrow("plug_wasm_abi() says 2.0, this host loads 1.0")
    expect(() => ff.loadModule(m, bad.bytes, null)).toThrow("plug_wasm_abi() says 2.0")
    // the same refusals for a module of each set
    for (const id of ["phz", "ju6"]) {
      const bytes = modBytes(id), man = manOf(id)
      await expect(ff.verify(bytes, { ...man, abi: "2.0" }, h, "synth")).rejects.toThrow("plugin ABI 2.0, this host has 1.1")
      await expect(ff.verify(bytes, { ...man, wasm_abi: "2.0" }, h, "synth")).rejects.toThrow("module ABI 2.0, this host loads 1.0")
      await expect(ff.verify(bytes, { ...man, min_host: 2 }, h, "synth")).rejects.toThrow("needs host level 2")
      await expect(ff.verify(bytes, man, h, "master")).rejects.toThrow("a synth module, not a master")
      const tampered = bytes.slice(); tampered[tampered.length - 9] ^= 1
      await expect(ff.verify(tampered, man, h, "synth")).rejects.toThrow("sha256")
    }
    for (const id of ["console", "dirt"]) await expect(ff.verify(modBytes(id), manOf(id), h, "synth")).rejects.toThrow("a master module, not a synth")
    const phz = modBytes("phz"), pm = manOf("phz")
    const loaded = ff.loadModule(m, phz, pm)
    expect(() => ff.setInsert(m, 0, loaded)).toThrow("not a master insert")
    ff.attachSynth(m, loaded)
    expect(() => ff.attachSynth(m, ff.loadModule(m, phz, pm))).toThrow("this engine is attached already")
    // an engine this host has no slot for: a module claiming FM4's numbers (FM4 is a public engine the runtime host links in)
    expect(() => ff.attachSynth(m, ff.loadModule(m, modBytes("fm4"), manOf("fm4")))).toThrow("this host has no slot for this engine")
    req(m, { cmd: "engines" }) // the list is read: too late for an engine
    expect(() => ff.attachSynth(m, ff.loadModule(m, modBytes("pluck"), manOf("pluck")))).toThrow("the engine list is in use")
    if (!haveLinked) return
    const l = await host("linked")
    expect(() => ff.attachSynth(l, ff.loadModule(l, phz, pm))).toThrow("this host has no slot for this engine")
  }, 120_000)

  test("every engine module was built with this host's engine flags and emcc (else bit identity is luck), whichever repository built it", () => {
    for (const E of ENGINES) {
      const man = manOf(E.id)
      expect(man.build.cxxflags).toBe(common.join(" "))
      expect(man.build.emcc).toContain(` ${EMCC_VERSION} `)
      expect(man.build.moduleflags).toContain("-sSIDE_MODULE=2")
    }
    // a private repository's manifest and the public one agree on the build contract (same emcc, same module and runtime flags)
    expect(manOf("phz").build.rtflags).toBe(manOf("ju6").build.rtflags)
    expect(manOf("phz").build.linkflags).toBe(manOf("ju6").build.linkflags)
    expect(manOf("pluck").build.emcc).toBe(manOf("ju6").build.emcc)
  })

  test("visibility: a set vouches only for modules of its own kind of repository, every manifest says where it was built", () => {
    for (const id of ["phz", "pluck"]) expect(manOf(id)).toMatchObject({ visibility: "private", source_repo: "ff-engines" })
    for (const id of ["console", "tube"]) expect(manOf(id)).toMatchObject({ visibility: "private", source_repo: "ff-effects" })
    for (const id of ["ju6", "fm4"]) expect(manOf(id)).toMatchObject({ visibility: "public", source_repo: "tracker-engines-os" })
    for (const id of ["dirt", "tape", "lofi", "bbd", "phaser"]) expect(manOf(id)).toMatchObject({ visibility: "public", source_repo: "tracker-effects-os" })
    expect(lock.sets["engines-os"].visibility).toBe("public")
    expect(lock.sets["effects-os"].visibility).toBe("public")
    expect(lock.sets.engines.visibility).toBe("private")
    expect(lock.sets.effects.visibility).toBe("private")
    expect(compatProblems(manOf("phz"), "public")).toEqual(["the manifest says private, the set is public"])
    expect(compatProblems(manOf("ju6"), "private")).toEqual(["the manifest says public, the set is private"])
    // the public sets hold every public module of the firmware's engines.json and none of the private ones
    const wasms = (n: string) => Object.keys(lock.sets[n]!.files).filter((f) => f.endsWith(".wasm")).map((f) => f.slice(0, -5)).sort()
    expect(wasms("engines-os")).toEqual(["arc", "atype", "btype", "cstype", "dtype", "eight", "fm4", "hand", "ju6", "ttype"])
    expect(wasms("effects-os")).toEqual(["bbd", "dirt", "lofi", "phaser", "tape"])
    expect(Object.keys(lock.sets.engines.files).filter((f) => f.endsWith(".wasm")).sort()).toEqual(["phz.wasm", "pluck.wasm"])
    expect(Object.keys(lock.sets.effects.files).filter((f) => f.endsWith(".wasm")).sort()).toEqual(["console.wasm", "tube.wasm"])
    // notices ship with every set
    for (const s of Object.values(lock.sets)) expect(Object.keys(s.files)).toContain("NOTICE.md")
  })

  test("the compat check of scripts/modules.ts against vendor/FIRMWARE.json and engine_list.h, for every module of every set", () => {
    const idx = JSON.parse(readFileSync(join(modulesDir(), "index.json"), "utf8"))
    expect(idx.modules.length).toBe(15 + 4)
    for (const mod of idx.modules) expect(compatProblems(JSON.parse(readFileSync(join(modulesDir(), mod.manifest), "utf8")), mod.visibility)).toEqual([])
    const pm = manOf("phz"), dm = manOf("dirt"), km = manOf("pluck")
    expect(compatProblems({ ...pm, synth: { ...pm.synth, stored: 9 } }, "private")[0]).toContain("numbers 9/130/130")
    expect(compatProblems({ ...km, synth: { ...km.synth, type_id: 139 } }, "private")[0]).toContain("numbers 18/139/138")
    expect(compatProblems({ ...pm, name: "ZZZ" }, "private")).toContain("ZZZ is not an engine of tracker-ff 1.2.0")
    expect(compatProblems({ ...dm, wasm_abi: "3.0" }, "public")).toEqual(["module ABI 3.0, this editor loads 1.x"])
  })
})
