// The PLK 1.0 render goldens: sha256 of the stream output of the released PLK 1.0 module (engines set tag engines-v1.2.0, pluck.wasm fc10abf7)
// for the three showcase patches (old 9 value .patch files, test/fixtures/pluck) and a few synthetic ones, at two notes and two velocities.
// PLK 1.1 (Vel Bright and Body, pluck-realism) must render the very same bytes with both new parameters at their default 0.
// The fixture test/fixtures/pluck-1.0-goldens.json is written ONCE by scripts/pluck-golden.ts run against a checkout that still holds the 1.0 module.
import { createHash } from "node:crypto"
import { cpSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { pull, stream } from "./helpers"
import type { HostClient } from "../server/host"

export const fixtureDir = join(import.meta.dir, "fixtures/pluck")
export const patchFiles = () => readdirSync(fixtureDir).filter((f) => f.endsWith(".patch")).sort()
export const NOTES = [45, 72]
export const VELOCITIES = [127, 64]
export const BLOCKS = 140

/** loads every fixture patch through the host (a copy under tmp/PLK/), and adds synthetic patches built from the init patch by parameter NAME (the first nine only) */
export async function goldenPatches(host: HostClient, tmp: string, meta: any) {
  mkdirSync(join(tmp, "PLK"), { recursive: true })
  const out: Record<string, any> = {}
  for (const f of patchFiles()) {
    cpSync(join(fixtureDir, f), join(tmp, "PLK", f))
    out[f.replace(/\.patch$/, "")] = (await host.request({ cmd: "load", path: join(tmp, "PLK", f), engine: "PLK" })).patch
  }
  const set = (name: string, v: number[]) => {
    const p = structuredClone(meta.init)
    const names = ["Exciter", "Brightness", "Damping", "Pick Pos", "Stretch", "Release", "Tune", "Fine", "Volume"]
    names.forEach((n, i) => { if (v[i] !== undefined) p.values[meta.params.findIndex((q: any) => q.name === n)] = v[i] })
    out[name] = p
  }
  set("init", [])
  set("mallet-stretch", [3, 0.8, 0.2, 0.5, 0.7, 0.4, 5, 30, 1.5])
  set("click-dark-damped", [1, 0.1, 0.9, 0.9, 0, 0.05, -7, -40, 0.7])
  set("saw-bright", [2, 1, 0.05, 0.1, 1, 1.5, 12, 0, 1])
  return out
}

const hashFrames = (frames: { pcm: Float32Array }[]) => {
  const h = createHash("sha256")
  for (const f of frames) h.update(new Uint8Array(f.pcm.buffer, f.pcm.byteOffset, f.pcm.byteLength))
  return h.digest("hex")
}

/** sha256 of the live stream of one note, keyed "<patch>|<note>|<velocity>" */
export async function goldenHashes(patches: Record<string, any>, tweak: (p: any) => any = (p) => p) {
  const out: Record<string, string> = {}
  for (const [name, patch] of Object.entries(patches))
    for (const note of NOTES)
      for (const velocity of VELOCITIES) {
        const { frames } = await stream([{ cmd: "live.open", engine: "PLK", patch: tweak(structuredClone(patch)), voices: 2 }, { cmd: "live.note", on: true, note, velocity }, pull(BLOCKS)])
        out[`${name}|${note}|${velocity}`] = hashFrames(frames)
      }
  return out
}
