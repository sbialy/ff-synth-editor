import { test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { HostClient } from "../server/host"
import { build, hostBinary } from "../scripts/build"
import { firmware } from "../server/firmware"
import { WasmHost, privateModules } from "../server/wasm-host"
import { wasmStreamManual } from "../server/live"

/** PHZ and PLK are private: they exist in this build only when their runtime modules are installed (scripts/build-wasm.ts runtime, scripts/modules.ts). */
export const privateEngines: string[] = privateModules().map((m) => m.name).filter((n) => firmware.private.engines.includes(n))
export const havePrivate = (...names: string[]) => names.every((n) => privateEngines.includes(n))
/** test() for what needs the private engines (skipped in a public build without them) */
export const testPrivate = (...names: string[]) => (havePrivate(...names) ? test : test.skip)

export const factoryDir = process.env.POLY_FACTORY_DIR ?? ""
export const haveFactory = factoryDir !== "" && existsSync(join(factoryDir, "ACD"))
export const ENGINES = ["ACD", "FAT", "VAP", "WTFM", "PERC", "CHIP"] as const
export const PARAM_COUNTS: Record<string, number> = { ACD: 29, FAT: 25, VAP: 60, WTFM: 63, PERC: 84, CHIP: 25 }
/** The OpenTracker 3.x module engines (opentracker-synths): name -> parameters, display name on the OpenTracker Synth page */
/** the engines of the server list that this build has (PHZ and PLK only with their runtime modules) */
import { ENGINES as ALL_SERVER_ENGINES } from "../server/engines"
export const SERVED_ENGINES: string[] = ALL_SERVER_ENGINES.filter((e) => !firmware.private.engines.includes(e) || privateEngines.includes(e))
/** the engine names of a list that this build has */
export const available = (names: readonly string[]) => names.filter((e) => !firmware.private.engines.includes(e) || privateEngines.includes(e))
/** the private engines of the firmware release image and of the experimental set that this build has, in list order */
export const PHZ_ONLY: string[] = privateEngines.filter((e) => e === "PHZ")
export const PLK_ONLY: string[] = privateEngines.filter((e) => e === "PLK")
export const OT3_ENGINES = ["FM4", "JU6", "DTYPE", "CSTYPE", "ATYPE", "TTYPE", "8TYPE", "HANDTYPE", "BTYPE", "ARCTYPE"] as const
export const OT3_PARAM_COUNTS: Record<string, number> = { FM4: 43, JU6: 23, DTYPE: 35, CSTYPE: 67, ATYPE: 46, TTYPE: 73, "8TYPE": 56, HANDTYPE: 52, BTYPE: 27, ARCTYPE: 62 }
export const OT3_DISPLAY: Record<string, string> = { FM4: "FM4", JU6: "JU6", DTYPE: "D-Type", CSTYPE: "CS-Type", ATYPE: "A-Type", TTYPE: "T-Type", "8TYPE": "8-Type", HANDTYPE: "Hand-Type", BTYPE: "B-Type", ARCTYPE: "Arc-Type" }
export const ALL_ENGINES = [...ENGINES, ...OT3_ENGINES]
/** The experimental engine (in no tracker-ff release, vendored from the pluck ref): Pluck. Kept apart from ENGINES / ALL_ENGINES, which are the tag's. */
export const EXPERIMENTAL_ENGINES = ["PLK"] as const
export const PLK_PARAM_COUNT = 11
/** the per-engine loops of the OpenTracker 2.x and CHIP tests plus the experimental engine */
/** (Pluck is private: only present with its runtime module) */
export const POLYEND_AND_PLUCK = [...ENGINES, ...EXPERIMENTAL_ENGINES.filter((e) => privateEngines.includes(e))] as const

let ready: Promise<unknown> | null = null
export function ensureBuilt() {
  return (ready ??= build())
}

export async function newHost() {
  await ensureBuilt()
  return new HostClient()
}

/** Minimal WAV reader for the host output (PCM16 or float32, mono). */
export function parseWav(buf: Uint8Array) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const tag = (o: number) => String.fromCharCode(...buf.slice(o, o + 4))
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV")
  const format = dv.getUint16(20, true), channels = dv.getUint16(22, true), rate = dv.getUint32(24, true), bits = dv.getUint16(34, true)
  if (tag(36) !== "data") throw new Error("data chunk not at 36")
  const n = dv.getUint32(40, true) / (bits / 8)
  const samples = new Float32Array(n)
  for (let i = 0; i < n; i++) samples[i] = bits === 16 ? dv.getInt16(44 + 2 * i, true) / 32768 : dv.getFloat32(44 + 4 * i, true)
  return { format, channels, rate, bits, samples }
}

/** Frames of the host's --stream output: u32 magic, seq, cmdId, frames, voices (sounding), held (keys down), then f32 mono. */
export function parseFrames(buf: Uint8Array) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const frames: { seq: number; cmdId: number; voices: number; held: number; pcm: Float32Array }[] = []
  for (let o = 0; o + 24 <= buf.length; ) {
    if (dv.getUint32(o, true) !== 0x314d4350) throw new Error("bad frame magic at " + o)
    const n = dv.getUint32(o + 12, true)
    const pcm = new Float32Array(n)
    for (let i = 0; i < n; i++) pcm[i] = dv.getFloat32(o + 24 + 4 * i, true)
    frames.push({ seq: dv.getUint32(o + 4, true), cmdId: dv.getUint32(o + 8, true), voices: dv.getUint32(o + 16, true), held: dv.getUint32(o + 20, true), pcm })
    o += 24 + 4 * n
  }
  return frames
}
export const rmsOf = (pcm: Float32Array) => Math.sqrt(pcm.reduce((a, x) => a + x * x, 0) / Math.max(1, pcm.length))
export const rmsMany = (fs: { pcm: Float32Array }[]) => Math.sqrt(fs.reduce((a, f) => a + f.pcm.reduce((b, x) => b + x * x, 0), 0) / Math.max(1, fs.reduce((a, f) => a + f.pcm.length, 0)))

/** Runs `poly_host --stream --manual` over the given control lines, returns every block it emitted. */
export async function stream(lines: object[]) {
  const open = lines.find((l: any) => l.cmd === "live.open") as any
  const eng = open?.engine ?? open?.patch?.engine
  if (typeof eng === "string" && firmware.private.engines.includes(eng)) { // a private engine: the wasm host with its runtime module
    const w = await WasmHost.open() // a fresh instance per stream, as a fresh poly_host process (the engines keep noise state across sessions)
    if (!w?.engines.includes(eng)) throw new Error(`engine ${eng} is not available in this build`)
    return { frames: parseFrames(wasmStreamManual(w, lines)), err: "" }
  }
  const p = Bun.spawn([hostBinary, "--stream", "--manual"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const stdin = p.stdin as import("bun").FileSink
  stdin.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
  await stdin.end()
  const [out, err] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text()])
  await p.exited
  return { frames: parseFrames(new Uint8Array(out)), err }
}
export const pull = (blocks: number) => ({ cmd: "live.pull", blocks })

