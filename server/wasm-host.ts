// The wasm host in the server process: the engines whose code is private (PHZ and PLK, vendor/FIRMWARE.json "private") are not compiled into the
// native poly_host. They run here, in the "runtime" wasm host (scripts/build-wasm.ts) with their runtime modules loaded (scripts/modules.ts fetches
// them from the pinned artifacts into build/modules, public/ffmod.js checks and loads them). server/host.ts routes the requests of those engines
// here and answers the rest from the native host.
//
// The wasm host has a memory file system: a patch file is copied in before a load, a saved patch or a rendered WAV is copied out after.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import * as ff from "../public/ffmod.js"
import { firmware } from "./firmware"
import { modulesDir } from "./modules-dir"
import { FRAME_BLOCK, FRAME_MAGIC } from "./live"

const root = join(import.meta.dir, "..")
export const wasmHostFile = join(root, "build/wasm/runtime/poly.mjs")
const indexFile = () => join(modulesDir(), "index.json")


type Json = Record<string, any>

/** What is available here: the wasm host and at least one private synth module, else null (the editor then has the public engines only). */
export function privateModules(): { name: string; manifest: string; wasm: string }[] {
  if (!existsSync(wasmHostFile) || !existsSync(indexFile())) return []
  const idx = JSON.parse(readFileSync(indexFile(), "utf8"))
  return idx.modules.filter((m: any) => m.kind === "synth" && m.visibility === "private" && firmware.private.engines.includes(m.name))
}

export class WasmHost {
  private tmp = 0
  private constructor(private m: any, readonly engines: string[]) {}

  /** The runtime wasm host with every private engine module of build/modules attached, or null when the host or the modules are not built. */
  static async open(): Promise<WasmHost | null> {
    const mods = privateModules()
    if (!mods.length) return null
    const m = await (await import(wasmHostFile)).default()
    const names: string[] = []
    for (const e of mods) {
      const bytes = new Uint8Array(readFileSync(join(modulesDir(), e.wasm)))
      const man = JSON.parse(readFileSync(join(modulesDir(), e.manifest), "utf8"))
      await ff.verify(bytes, man, ff.hostAbi(m), "synth")
      ff.attachSynth(m, ff.loadModule(m, bytes, man))
      names.push(e.name)
    }
    return new WasmHost(m, names)
  }

  /** One request line -> the answer. Same protocol as poly_host, paths are real paths (copied in and out of the memory file system). */
  request(req: Json): Json {
    const copies: (() => void)[] = []
    const r = { ...req }
    const mem = (suffix: string) => `/ph-${this.tmp++}${suffix}`
    if ((r.cmd === "load" || r.cmd === "roundtrip") && typeof r.path === "string") {
      const real = r.path
      if (!existsSync(real)) return { ok: false, error: `cannot read ${real}` }
      r.path = mem(".patch")
      this.m.FS.writeFile(r.path, new Uint8Array(readFileSync(real)))
      copies.push(() => this.m.FS.unlink(r.path))
    } else if (r.cmd === "save" && typeof r.path === "string") {
      const real = r.path
      r.path = mem(".patch")
      copies.push(() => {
        if (this.m.FS.analyzePath(r.path).exists) {
          mkdirSync(dirname(real), { recursive: true })
          writeFileSync(real, this.m.FS.readFile(r.path))
          this.m.FS.unlink(r.path)
        }
      })
    } else if (r.cmd === "render" && typeof r.out === "string" && r.out) {
      const real = r.out
      r.out = mem(".wav")
      copies.push(() => {
        if (this.m.FS.analyzePath(r.out).exists) {
          mkdirSync(dirname(real), { recursive: true })
          writeFileSync(real, this.m.FS.readFile(r.out))
          this.m.FS.unlink(r.out)
        }
      })
    }
    const s = this.m.UTF8ToString(this.m.ccall("ph_request", "number", ["string"], [JSON.stringify(r)]))
    for (const c of copies) c()
    const a = JSON.parse(s)
    if (a.path && req.path) a.path = req.path
    if (a.out && req.out) a.out = req.out
    return a
  }

  /** One 128 frame block of the live session in the frame of poly_host --stream. seq: the stream's counter, cmdId: the id of the last control line applied. */
  block(seq: number, cmdId: number): Uint8Array {
    const m = this.m
    const l = m._ph_block()
    const out = new Uint8Array(24 + FRAME_BLOCK * 4)
    const dv = new DataView(out.buffer)
    dv.setUint32(0, FRAME_MAGIC, true)
    dv.setUint32(4, seq >>> 0, true)
    dv.setUint32(8, cmdId >>> 0, true)
    dv.setUint32(12, FRAME_BLOCK, true)
    dv.setUint32(16, m._ph_voices() >>> 0, true)
    dv.setUint32(20, m._ph_held() >>> 0, true)
    out.set(new Uint8Array(m.HEAPU8.buffer, l, FRAME_BLOCK * 4), 24)
    return out
  }
}

let shared: Promise<WasmHost | null> | null = null
/** One wasm host per server process: the engine list is fixed after its first request. */
export const sharedWasmHost = () => (shared ??= WasmHost.open())
