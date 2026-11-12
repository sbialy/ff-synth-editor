// The Tracker's master delay and reverb in the editor (host/fx.cpp around the firmware files of vendor/fx):
//  - the vendored files are the ones PROVENANCE.md lists, and the two stand-ins that replace files with Cortex-M4 assembly differ from the originals in nothing but that
//  - the portable stand-ins of the DSP instructions (host/fx/utility/dspinst.h) are the instructions' definitions, checked against 64 bit integer arithmetic
//  - the graph compiled for arm64 with -ffp-contract=off (the firmware files through MixerAndFxs, build/fx/fx_tool) and the same graph compiled to wasm (the host the
//    page runs) give the same int16 bus bit for bit, over delay, reverb, ping pong, tempo sync, Soft Clip, Soft Knee and parameter moves while playing
//  - the topology of the device: nothing changes with both sends at 0, a send changes the output, the first echo comes one delay time after the dry sound, the reverb rings on
//  - public/fx-tables.js is the firmware's level tables
// Needs emscripten (scripts/build-wasm.ts) and clang for the native tool: skipped without emscripten.
import { beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EMSDK, buildWasm, outDir } from "../scripts/build-wasm"
import { buildFx, fxToolPath } from "../scripts/build-fx"
import { table } from "../scripts/gen-fx-tables"
import { levels, sends } from "../public/fx-tables.js"
import { DEF, RUNS, SR, hostParams, signal, type P, type Run } from "./fx-helpers"

const root = join(import.meta.dir, "..")
const haveEmsdk = existsSync(join(EMSDK, "upstream/emscripten/em++"))
type M = any
const factory = async (): Promise<(o?: object) => Promise<M>> => (await import(join(outDir("runtime"), "poly.mjs"))).default
const tmp = mkdtempSync(join(tmpdir(), "poly-editor-fx-"))

describe("vendored firmware sources", () => {
  test("every file of vendor/fx/PROVENANCE.md is there with its sha256, and nothing else is in vendor/fx", () => {
    const rows = [...readFileSync(join(root, "vendor/fx/PROVENANCE.md"), "utf8").matchAll(/^\| (\S+)( \(as (\S+)\))? \| ([0-9a-f]{64}) \|$/gm)]
    expect(rows.length).toBeGreaterThanOrEqual(25)
    for (const [, path, , asPath, sha] of rows) {
      const f = join(root, "vendor/fx", asPath ? asPath.replace("vendor/fx/", "") : path)
      expect(existsSync(f)).toBe(true)
      expect(createHash("sha256").update(readFileSync(f)).digest("hex")).toBe(sha)
    }
    const files = Bun.spawnSync(["find", join(root, "vendor/fx"), "-type", "f", "-not", "-name", "PROVENANCE.md"]).stdout.toString().trim().split("\n")
    expect(files.length).toBe(rows.length)
    // byte for byte means the firmware's CRLF line endings too
    expect(readFileSync(join(root, "vendor/fx/core/libs/Audio/effect_shortDelay.cpp"), "utf8")).toContain("\r\n")
  })

  test("host/fx/util.h is the firmware's Polyverb util.h with Clip16 in C, host/fx/utility/dspinst.h keeps every function of the original", () => {
    const orig = readFileSync(join(root, "vendor/fx/arm/util.h"), "utf8").replace(/\r\n/g, "\n")
    const mine = readFileSync(join(root, "host/fx/util.h"), "utf8")
    const strip = (t: string) => t.replace(/inline int32_t Clip16\(int32_t x\)\n\{[\s\S]*?\n\}\n/, "").split("\n").filter((l) => !l.startsWith("// Stand-in") && !l.startsWith("// file, only Clip16")).join("\n")
    expect(strip(mine)).toBe(strip(orig))
    expect(orig).toContain('__asm("ssat')
    expect(mine).not.toContain("__asm")
    const fns = (t: string) => new Set([...t.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/static inline \w+ (\w+)\(/g)].map((m) => m[1]).filter((n) => !["sat", "lo16", "hi16", "pack"].includes(n)))
    const o = fns(readFileSync(join(root, "vendor/fx/arm/utility/dspinst.h"), "utf8")), m = fns(readFileSync(join(root, "host/fx/utility/dspinst.h"), "utf8"))
    for (const n of o) expect(m.has(n)).toBe(true)
  })

  test("the level tables of public/fx-tables.js are the firmware header's, and the wasm host exports the same floats", async () => {
    expect(sends).toEqual(table("sendsAmpLogValues"))
    expect(levels).toEqual(table("mixAmpLogValues"))
    if (!haveEmsdk) return
    await buildWasm("runtime")
    const m = await (await factory())()
    for (const [w, t] of [[0, sends], [1, levels]] as const) {
      const p = m._ffm_fx_table(w) >> 2
      for (let i = 0; i < 101; i++) expect(m.HEAPF32[p + i]).toBe(Math.fround(t[i]))
    }
  }, 120_000)
})

describe("the portable DSP instructions", () => {
  test("every stand-in of host/fx/utility/dspinst.h equals the Cortex-M4 instruction's definition (random and edge operands)", async () => {
    const src = join(tmp, "instr.cpp")
    writeFileSync(src, `#include "dspinst.h"
#include <cstdio>
#include <cstdlib>
int main() {
  uint32_t seed = 12345;
  auto rnd = [&]() { seed = seed * 1664525u + 1013904223u; return seed; };
  const uint32_t edge[] = { 0, 1, 0xFFFFFFFFu, 0x7FFFFFFFu, 0x80000000u, 0x8000u, 0x7FFFu, 0xFFFF8000u, 0x00007FFFu, 0x80008000u, 0x7FFF7FFFu, 0xFFFF0001u, 0x12345678u };
  for (int n = 0; n < 4000; n++) {
    uint32_t a = n < 169 ? edge[(n / 13) % 13] : rnd(), b = n < 169 ? edge[n % 13] : rnd(), c = rnd();
    int32_t sa = (int32_t)a, sb = (int32_t)b, sc = (int32_t)c;
    int bits = 1 + (c % 31), sh = (c >> 8) % 20;
    printf("%d %d %d %d %d %d %d %d %d %d %d %d %d %d\\n", signed_saturate_rshift(sa, bits, sh), (int)saturate16(sa), signed_multiply_32x16b(sa, b), signed_multiply_32x16t(sa, b),
      multiply_32x32_rshift32(sa, sb), multiply_32x32_rshift32_rounded(sa, sb), multiply_accumulate_32x32_rshift32_rounded(sc, sa, sb), multiply_subtract_32x32_rshift32_rounded(sc, sa, sb),
      (int)pack_16t_16t(sa, sb), (int)pack_16t_16b(sa, sb), (int)pack_16b_16b(sa, sb), (int)signed_add_16_and_16(a, b), (int)signed_subtract_16_and_16(sa, sb), multiply_32x32_rshift(sa, sb, sh));
    printf("%d %d %d %d %d %d %d %d %d %d %d\\n", (int)signed_halving_add_16_and_16(sa, sb), (int)signed_halving_subtract_16_and_16(sa, sb), signed_multiply_accumulate_32x16b(sc, sa, b),
      signed_multiply_accumulate_32x16t(sc, sa, b), multiply_16tx16t_add_16bx16b(a, b), multiply_16tx16b_add_16bx16t(a, b), multiply_16bx16b(a, b), multiply_16bx16t(a, b),
      multiply_16tx16b(a, b), multiply_16tx16t(a, b), substract_32_saturate(a, b));
    printf("%lld %lld\\n", (long long)multiply_accumulate_16tx16t_add_16bx16b((int64_t)sc << 20, a, b), (long long)multiply_accumulate_16tx16b_add_16bx16t((int64_t)sc << 20, a, b));
  }
}
`)
    const exe = join(tmp, "instr")
    const cc = Bun.spawnSync(["c++", "-std=c++20", "-O1", "-I", join(root, "host/fx/utility"), src, "-o", exe])
    expect(cc.stderr.toString()).toBe("")
    const out = Bun.spawnSync([exe]).stdout.toString().trim().split("\n")
    // the definitions, in BigInt, from the ARMv7-M architecture reference manual
    let seed = 12345
    const rnd = () => { seed = Number((BigInt(seed) * 1664525n + 1013904223n) & 0xffffffffn); return seed >>> 0 }
    const edge = [0, 1, 0xFFFFFFFF, 0x7FFFFFFF, 0x80000000, 0x8000, 0x7FFF, 0xFFFF8000, 0x00007FFF, 0x80008000, 0x7FFF7FFF, 0xFFFF0001, 0x12345678]
    const s32 = (x: number) => x | 0
    const B = (x: number) => BigInt(s32(x))
    const sat = (v: bigint, bits: number) => { const hi = (1n << BigInt(bits - 1)) - 1n, lo = -(1n << BigInt(bits - 1)); return v > hi ? hi : v < lo ? lo : v }
    const w32 = (v: bigint) => Number(BigInt.asIntN(32, v))
    const lo16 = (x: number) => BigInt(((x & 0xffff) << 16) >> 16), hi16 = (x: number) => BigInt(s32(x) >> 16)
    const u = (x: number) => x >>> 0
    const pk = (hi: bigint, lo: bigint) => w32(((BigInt.asUintN(16, hi)) << 16n) | BigInt.asUintN(16, lo))
    for (let n = 0; n < 4000; n++) {
      const a = n < 169 ? edge[Math.floor(n / 13) % 13] : rnd(), b = n < 169 ? edge[n % 13] : rnd(), c = rnd()
      const bits = 1 + (c % 31), sh = (c >>> 8) % 20
      const exp1 = [
        w32(sat(B(a) >> BigInt(sh), bits)), w32(sat(B(a), 16)), w32((B(a) * lo16(b)) >> 16n), w32((B(a) * hi16(b)) >> 16n),
        w32((B(a) * B(b)) >> 32n), w32((B(a) * B(b) + 0x80000000n) >> 32n), w32(((B(c) << 32n) + B(a) * B(b) + 0x80000000n) >> 32n), w32(((B(c) << 32n) - B(a) * B(b) + 0x80000000n) >> 32n),
        w32(BigInt(u(a) & 0xffff0000) | BigInt(u(b) >>> 16)), w32(BigInt(u(a) & 0xffff0000) | BigInt(u(b) & 0xffff)), w32(BigInt.asUintN(32, BigInt(u(a) << 16 >>> 0)) | BigInt(u(b) & 0xffff)),
        pk(sat(hi16(a) + hi16(b), 16), sat(lo16(a) + lo16(b), 16)), pk(sat(hi16(a) - hi16(b), 16), sat(lo16(a) - lo16(b), 16)), w32((B(a) * B(b)) >> BigInt(31 - sh)),
      ]
      expect(out[n * 3].split(" ").map(Number)).toEqual(exp1)
      const exp2 = [
        pk((hi16(a) + hi16(b)) >> 1n, (lo16(a) + lo16(b)) >> 1n), pk((hi16(a) - hi16(b)) >> 1n, (lo16(a) - lo16(b)) >> 1n), w32(B(c) + ((B(a) * lo16(b)) >> 16n)), w32(B(c) + ((B(a) * hi16(b)) >> 16n)),
        w32(lo16(a) * lo16(b) + hi16(a) * hi16(b)), w32(lo16(a) * hi16(b) + hi16(a) * lo16(b)), w32(lo16(a) * lo16(b)), w32(lo16(a) * hi16(b)), w32(hi16(a) * lo16(b)), w32(hi16(a) * hi16(b)),
        w32(sat(B(a) - B(b), 32)),
      ]
      expect(out[n * 3 + 1].split(" ").map(Number)).toEqual(exp2)
      const acc = BigInt.asIntN(64, B(c) << 20n)
      const exp3 = [BigInt.asIntN(64, acc + lo16(a) * lo16(b) + hi16(a) * hi16(b)), BigInt.asIntN(64, acc + lo16(a) * hi16(b) + hi16(a) * lo16(b))]
      expect(out[n * 3 + 2].split(" ").map(BigInt)).toEqual(exp3)
    }
  }, 120_000)
})

// ---- the graph, native and wasm
function native(run: Run): Int16Array {
  const inp = join(tmp, `${run.name.replace(/\W+/g, "_")}.f32`), out = inp.replace(".f32", ".s16")
  const sig = signal(run.blocks, run.seed)
  writeFileSync(inp, sig)
  const args = [inp, out, ...Object.entries(run.p).map(([k, v]) => `${k}=${v}`)]
  const stdin = (run.at ?? []).map(([b, p]) => `@${b} ${Object.entries(p).map(([k, v]) => `${k}=${v}`).join(" ")}`).join("\n") + "\n"
  const r = Bun.spawnSync([fxToolPath, ...args], { stdin: new TextEncoder().encode(stdin) })
  expect(r.exitCode).toBe(0)
  return new Int16Array(readFileSync(out).buffer.slice(0))
}
async function wasm(run: Run): Promise<Int16Array> {
  const m = await (await factory())()
  const P = m._ffm_fx_params() >> 2
  const cur: P = { ...DEF, ...run.p }
  const apply = () => {
    m.HEAPF32.set(hostParams(cur), P)
    m._ffm_fx_apply()
    m._ffm_mixer_set(cur.mixer === 1 ? 1 : cur.mixer === 10 ? 2 : 0)
  }
  apply()
  const L = m._ffm_buf(0) >> 2, R = m._ffm_buf(1) >> 2
  const sig = signal(run.blocks, run.seed)
  const out = new Int16Array(run.blocks * 256)
  for (let b = 0; b < run.blocks; b++) {
    for (const [at, p] of run.at ?? []) if (at === b) { Object.assign(cur, p); apply() }
    m.HEAPF32.set(sig.subarray(b * 128, b * 128 + 128), L)
    m._ffm_engine_block()
    for (let i = 0; i < 128; i++) { out[(b * 128 + i) * 2] = Math.round(m.HEAPF32[L + i] * 32768); out[(b * 128 + i) * 2 + 1] = Math.round(m.HEAPF32[R + i] * 32768) }
  }
  return out
}
const same = (a: Int16Array, b: Int16Array) => { let d = a.length === b.length ? 0 : Infinity, n = 0; for (let i = 0; i < a.length; i++) { const x = Math.abs(a[i] - b[i]); if (x) n++; d = Math.max(d, x) } return { maxDiff: d, differing: n } }

describe.skipIf(!haveEmsdk)("the delay and reverb graph: arm64 native against wasm", () => {
  beforeAll(async () => {
    await buildWasm("runtime")
    await buildFx()
  }, 600_000)

  for (const r of RUNS) {
    test(`${r.name}: native and wasm give the same int16 bus, bit for bit`, async () => {
      const a = native(r), b = await wasm(r)
      let peak = 0
      for (const v of a) peak = Math.max(peak, Math.abs(v))
      expect(peak).toBeGreaterThan(500) // a signal
      const d = same(a, b)
      console.log(`${r.name}: ${a.length / 256} blocks, peak ${peak}, differing samples ${d.differing}, max diff ${d.maxDiff} LSB`)
      expect(d.maxDiff).toBe(0)
    }, 120_000)
  }

  test("with both sends at 0 and Hard Clip the engine block passes untouched, a send above 0 changes the output, and the wet part is the effect", async () => {
    const m = await (await factory())()
    const P = m._ffm_fx_params() >> 2
    const set = (o: Partial<P>) => { m.HEAPF32.set(hostParams({ ...DEF, ...o }), P); m._ffm_fx_apply() }
    const L = m._ffm_buf(0) >> 2, R = m._ffm_buf(1) >> 2
    const sig = signal(300)
    const play = (blocks: number) => {
      const out = new Float32Array(blocks * 128)
      for (let b = 0; b < blocks; b++) { m.HEAPF32.set(sig.subarray(b * 128, b * 128 + 128), L); m._ffm_engine_block(); out.set(m.HEAPF32.subarray(L, L + 128), b * 128) }
      return out
    }
    set({})
    expect(m._ffm_engine_active()).toBe(0)
    const dry = play(300)
    expect(dry).toEqual(sig.subarray(0, 300 * 128)) // untouched, even the samples beyond full scale
    set({ delaySend: 1 })
    expect(m._ffm_engine_active()).toBe(1)
    const wet = play(300)
    expect(wet).not.toEqual(dry)
    // both sends back to 0: the graph stays engaged while its tail rings, the output keeps the signal on the int16 grid
    set({})
    expect(m._ffm_engine_active()).toBe(1)
    void R
  }, 60_000)

  describe("the master limiter", () => {
    const sine = (blocks: number, amp: number) => { const o = new Float32Array(blocks * 128); for (let i = 0; i < o.length; i++) o[i] = Math.sin(2 * Math.PI * 220 * i / SR) * amp; return o }
    async function engine(p: Partial<P>) {
      const m = await (await factory())()
      const P_ = m._ffm_fx_params() >> 2
      m.HEAPF32.set(hostParams({ ...DEF, ...p }), P_); m._ffm_fx_apply()
      const L = m._ffm_buf(0) >> 2, R = m._ffm_buf(1) >> 2
      const run = (sig: Float32Array) => {
        const l = new Float32Array(sig.length), r = new Float32Array(sig.length)
        for (let b = 0; b < sig.length / 128; b++) { m.HEAPF32.set(sig.subarray(b * 128, b * 128 + 128), L); m._ffm_engine_block(); l.set(m.HEAPF32.subarray(L, L + 128), b * 128); r.set(m.HEAPF32.subarray(R, R + 128), b * 128) }
        return { l, r }
      }
      return { m, run, apply: (q: Partial<P>) => { m.HEAPF32.set(hostParams({ ...DEF, ...p, ...q }), P_); m._ffm_fx_apply() } }
    }
    const peak = (a: Float32Array, from = 0) => { let v = 0; for (let i = from; i < a.length; i++) v = Math.max(v, Math.abs(a[i])); return v }

    test("off, the engine block passes untouched and the graph is not engaged, on it is", async () => {
      const e = await engine({})
      expect(e.m._ffm_engine_active()).toBe(0)
      const sig = sine(50, 0.9)
      expect(e.run(sig).l).toEqual(sig)
      e.apply({ limiterOn: 1 })
      expect(e.m._ffm_engine_active()).toBe(1)
    }, 60_000)

    test("a sustained hot signal is held at the threshold of the firmware's table (Extreme: the attack and release are per sample fractions of value / 1000), a quiet one is left alone", async () => {
      // threshold raw 16384 -> step 50 of limiterThresholdValues
      const idx = Math.trunc(16384 * 100 / 32767)
      const e = await engine({ limiterOn: 1, limiterMode: 1, limiterAttack: 500, limiterRelease: 20, limiterThreshold: 16384 })
      const hot = e.run(sine(400, 0.95)).l
      const table = [...readFileSync(join(root, "vendor/fx/core/AudioEngine/ConstantValues/ampLogarythmicValues.h"), "utf8").match(/limiterThresholdValues\[AMP_LOG_VALUES\] = \{([^}]*)\}/)![1].split(",").map(Number)]
      const limit = table[idx] / 32768
      console.log(`limiter: hot sine 0.95 -> tail peak ${peak(hot, 300 * 128).toFixed(4)}, threshold step ${idx} = ${limit.toFixed(4)}`)
      expect(peak(hot, 300 * 128)).toBeLessThan(limit * 1.3)
      expect(peak(hot, 300 * 128)).toBeGreaterThan(limit * 0.5)
      // the highest threshold on a quiet signal: nothing to limit, the output is the input delayed by the look-ahead of 5 samples (the int16 grid aside)
      const q = await engine({ limiterOn: 1, limiterThreshold: 32767 })
      const quiet = sine(100, 0.02) // the part's soft clip (x - x^3 / 6.72) and the int16 grid stay under 3 LSB here
      const out = q.run(quiet).l
      // two passes of the audio library (256 frames) plus the limiter's 5 sample look-ahead
      for (let i = 400; i < 6000; i++) expect(Math.abs(out[i + 256 + 5] - quiet[i])).toBeLessThan(3 / 32768)
    }, 60_000)

    test("Subtle attack 100 is slow, Extreme 500 fast: the same burst is cut harder by the second", async () => {
      const burst = sine(60, 0.95)
      const subtle = (await engine({ limiterOn: 1, limiterAttack: 100, limiterThreshold: 8000 })).run(burst).l
      const extreme = (await engine({ limiterOn: 1, limiterMode: 1, limiterAttack: 500, limiterThreshold: 8000 })).run(burst).l
      expect(peak(extreme)).toBeLessThan(peak(subtle))
    }, 60_000)

    test("reset gives the state of a fresh graph: a render after a loud one is the same as on its own", async () => {
      const p = { limiterOn: 1, limiterMode: 1 as const, limiterAttack: 500, limiterRelease: 900, limiterThreshold: 6000 }
      const a = await engine(p), b = await engine(p)
      a.run(sine(200, 0.95)) // loud, the gain is pulled down and the release is slow
      a.m._ffm_fx_reset()
      const sig = signal(300)
      const x = a.run(sig).l, y = b.run(sig).l
      expect(x).toEqual(y)
    }, 60_000)
  })

  test("the first echo comes one delay time after the dry sound and the dry sound and the return meet in the same block", async () => {
    // an impulse, no feedback, 100 ms, no filter: one echo. The dry impulse leaves the graph after the 2 passes of the device's update order.
    const imp = new Float32Array(300 * 128); imp[0] = 0.5
    const inp = join(tmp, "imp.f32"), out = join(tmp, "imp.s16")
    writeFileSync(inp, imp)
    const r = Bun.spawnSync([fxToolPath, inp, out, "delaySend=100", "delayFeedback=0", "delayTime=100", "delayFilter=20000", "delayVolume=100"], { stdin: new TextEncoder().encode("\n") })
    expect(r.exitCode).toBe(0)
    const s = new Int16Array(readFileSync(out).buffer.slice(0))
    const left = s.filter((_, i) => i % 2 === 0)
    const peaks = [...left.keys()].filter((i) => Math.abs(left[i]) > 200)
    expect(peaks[0]).toBe(256) // the dry impulse: 2 blocks after it went in
    const echo = peaks.find((i) => i > 1000)!
    const delaySamples = Math.trunc(100 * 44.1)
    console.log(`dry at ${peaks[0]}, echo at ${echo}, distance ${echo - peaks[0]} samples (delay time ${delaySamples})`)
    // the delay sees the send one pass after the dry sound enters the mixers' pipeline: it is aligned to within the 128 sample block
    expect(Math.abs(echo - peaks[0] - delaySamples)).toBeLessThanOrEqual(128)
  }, 60_000)
})
