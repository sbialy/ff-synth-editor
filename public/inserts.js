// The master section of the editor page: the Tracker's delay and reverb, the Mixer stage, the two insert slots of the device's Inserts page and the master limiter, on the wasm host
// (host/modules.cpp ffmEngineChain, with the firmware's own delay, reverb and mixers of host/fx.cpp). No DOM: the page (app.js), the AudioWorklet
// (worklet-inserts.js) and the tests import it.
//
//   engine (mono) -> sends -> delay and reverb -> returns + dry in the track mixers (Mixer: Hard Clip, Soft Clip, Soft Knee) -> insert 1 -> insert 2 -> limiter -> out (stereo)
//
// The order is the device's (core/AudioEngine/MixerAndFxs.cpp, mtAudioEngine.cpp): the returns meet the dry signal in the tracks and sends mixer, which narrows to
// the int16 bus with the picked saturation type, and the master inserts read that bus, the limiter follows them (core/AudioEngine/AudioOutput.cpp). Hard Clip with no
// send, both slots empty and the limiter off leaves the engine block exactly as it is.
import { loadModule, setInsert, verify } from "./ffmod.js"

export const MIXERS = ["Hard Clip", "Soft Clip", "Soft Knee"]
export const SLOTS = 2
export const BLOCK = 128

/** Delay sync rates of the Master Delay page (masterParams.h delaySyncRates), as bar fractions: the note value the time is tempo / 15 * ratio. */
export const RATES = ["8", "6", "4", "3", "2", "3/2", "1", "3/4", "1/2", "3/8", "1/3", "1/4", "3/16", "1/6", "1/8", "1/12", "1/16", "1/24", "1/32"]

/**
 * The Master Delay and Master Reverb pages of the device with their ranges (mtStructs.h) and the defaults of a new project, in the page's units: the reverb values are
 * the device's 0..100 display numbers (size, damping, predelay 0..1 * 100, diffusion 0..0.85 shown as 0..100). level = the Delay and Reverb bars of the Mixer page
 * (0..100, default 86), mute = their mute, send = the engine's own Delay send and Reverb send (the Synth screen, 0..100, default 0) kept per engine in `sends`.
 */
export const FX_PARAMS = {
  delay: [
    { key: "send", name: "Send", min: 0, max: 100, step: 1, def: 0, unit: "send" },
    { key: "level", name: "Level", min: 0, max: 100, step: 1, def: 86, unit: "level" },
    { key: "pingpong", name: "PingPong", min: 0, max: 1, step: 1, def: 0, enum: ["Off", "On"] },
    { key: "sync", name: "Sync", min: 0, max: 1, step: 1, def: 0, enum: ["Off", "On"] },
    { key: "rate", name: "Rate", min: 0, max: 18, step: 1, def: 0, enum: RATES, needs: "sync" },
    { key: "time", name: "Time", min: 1, max: 3500, step: 1, def: 500, unit: "ms", needs: "free" },
    { key: "feedback", name: "Feedback", min: 0, max: 99, step: 1, def: 50 },
    { key: "filter", name: "Filter", min: 100, max: 20000, step: 100, def: 20000, unit: "Hz" },
  ],
  reverb: [
    { key: "send", name: "Send", min: 0, max: 100, step: 1, def: 0, unit: "send" },
    { key: "level", name: "Level", min: 0, max: 100, step: 1, def: 86, unit: "level" },
    { key: "size", name: "Size", min: 0, max: 100, step: 1, def: 50 },
    { key: "damp", name: "Damping", min: 0, max: 100, step: 1, def: 50 },
    { key: "predelay", name: "Predelay", min: 0, max: 100, step: 1, def: 50 },
    { key: "diffusion", name: "Diffusion", min: 0, max: 100, step: 1, def: 80 },
  ],
}
/**
 * The master limiter, the Limiter screen of Master (core/interface/masterParams) and the Limiter mode of the config menu, in the screens' units. The values are the new project's
 * (core/FileManager/fileManagerProject.cpp): Attack 100 and Release 0.512 are shown as value / 1000 s, Threshold has 101 steps (limiterThresholdValues), 92 is the step of the
 * device's 30200. The Tracker has no switch for the limiter, it is always in the path, and so is the editor's: `on` is 1 at every page load, for every engine and in
 * release mode. The page's switch takes it out for an A/B by ear for the rest of the session only, a stored `on` (an older session kept 0 there) is never read back.
 */
export const LIMITER_PARAMS = [
  { key: "mode", name: "Mode", min: 0, max: 1, step: 1, def: 0, enum: ["Subtle", "Extreme"] },
  { key: "attack", name: "Attack", min: 1, max: 1000, step: 1, def: 100, unit: "s/1000" },
  { key: "release", name: "Release", min: 1, max: 1000, step: 1, def: 0.512, unit: "s/1000" },
  { key: "threshold", name: "Threshold", min: 0, max: 100, step: 1, def: 92, unit: "limiter" },
]
/** The raw value of the firmware's limiterThreshold (0..32767) for a step 0..100: the smallest one that AudioEffectLimiter::setThreshold maps back to the step. */
export const limiterRaw = (step) => Math.min(32767, Math.ceil((step * 32767) / 100))
export const TEMPO = { min: 40, max: 300, def: 130 } // the delay's sync needs a tempo, the editor has no sequencer (DEFAULT_TEMPO 130)

export const fxDefaults = () => ({
  delay: Object.fromEntries(FX_PARAMS.delay.filter((p) => p.key !== "send").map((p) => [p.key, p.def]).concat([["mute", 0]])),
  reverb: Object.fromEntries(FX_PARAMS.reverb.filter((p) => p.key !== "send").map((p) => [p.key, p.def]).concat([["mute", 0]])),
  tempo: TEMPO.def,
  sends: {},
  limiter: Object.fromEntries(LIMITER_PARAMS.map((p) => [p.key, p.def]).concat([["on", 1]])),
})
const cut = (p, v) => { const x = Number.isFinite(Number(v)) ? Math.min(p.max, Math.max(p.min, Number(v))) : p.def; return p.step ? p.min + Math.round((x - p.min) / p.step) * p.step : x }
const fxNorm = (raw) => {
  const f = fxDefaults()
  if (!raw || typeof raw !== "object") return f
  for (const sec of ["delay", "reverb"]) {
    const r = raw[sec]
    if (!r || typeof r !== "object") continue
    for (const p of FX_PARAMS[sec]) if (p.key !== "send" && r[p.key] !== undefined) f[sec][p.key] = cut(p, r[p.key])
    if (r.mute !== undefined) f[sec].mute = r.mute ? 1 : 0
  }
  const lim = raw.limiter
  if (lim && typeof lim === "object") {
    for (const p of LIMITER_PARAMS) {
      if (lim[p.key] === undefined) continue
      // the Release of a new project is 0.512, below the 1..1000 whole numbers of the screen
      f.limiter[p.key] = p.key === "release" && Number(lim.release) === p.def ? p.def : cut(p, lim[p.key])
    }
    // lim.on is not read: the limiter is on at every load, whatever an older session stored (the editor used to start with it off)
  }
  if (raw.tempo !== undefined) f.tempo = cut({ ...TEMPO, step: 1 }, raw.tempo)
  if (raw.sends && typeof raw.sends === "object") {
    for (const [name, v] of Object.entries(raw.sends)) {
      if (!v || typeof v !== "object") continue
      f.sends[name] = { delay: cut(FX_PARAMS.delay[0], v.delay), reverb: cut(FX_PARAMS.reverb[0], v.reverb) }
    }
  }
  return f
}
/** The engine's Delay send and Reverb send in a state. */
export const sendOf = (state, engine) => state.fx?.sends?.[engine] ?? { delay: 0, reverb: 0 }
/** Is the master limiter in the path. */
export const limiterOn = (state) => !!state.fx?.limiter?.on
/** Is the delay or the reverb part of the signal: an engine send above zero. */
export const fxSending = (state, engine) => { const s = sendOf(state, engine); return s.delay > 0 || s.reverb > 0 }

/** The state the page keeps and stores: mixer = index into MIXERS, slots = [{ name: module name | null, values: [parameter values] }], fx = fxDefaults(). */
export const emptyState = () => ({ mixer: 0, slots: [{ name: null, values: [] }, { name: null, values: [] }], fx: fxDefaults() })

export const defaults = (man) => man.params.map((p) => p.def)
const clamp = (p, v) => {
  if (!Number.isFinite(v)) return p.def
  const x = Math.min(p.max, Math.max(p.min, v))
  return p.step ? p.min + Math.round((x - p.min) / p.step) * p.step : x
}
/** A parameter value cut to the module's range and step. */
export const clampParam = clamp

/** What a stored state may hold, as a valid state: unknown mixer types become Hard Clip, a slot keeps its module name even when the module is
 *  not installed here (the page shows it as missing and the choice survives), values are cut to the manifest's ranges when the module is known. */
export function normalizeState(raw, mods = []) {
  const s = emptyState()
  if (!raw || typeof raw !== "object") return s
  s.fx = fxNorm(raw.fx)
  if (Number.isInteger(raw.mixer) && raw.mixer >= 0 && raw.mixer < MIXERS.length) s.mixer = raw.mixer
  for (let i = 0; i < SLOTS; i++) {
    const r = Array.isArray(raw.slots) ? raw.slots[i] : null
    if (!r || typeof r.name !== "string" || !r.name) continue
    const man = mods.find((m) => m.man.name === r.name)?.man
    const vals = Array.isArray(r.values) ? r.values.map(Number) : []
    s.slots[i] = { name: r.name, values: man ? man.params.map((p, k) => (k < vals.length ? clamp(p, vals[k]) : p.def)) : vals.filter(Number.isFinite) }
  }
  return s
}

/**
 * Fetches the module set the server built (/modules/index.json, scripts/modules.ts), verifies every master insert (size, sha256, ABI) and compiles
 * it. A set that is not installed, a module that fails a check or a missing index never throws: the insert is left out and the reason is listed.
 * Returns { host: the index's host numbers | null, inserts: [{ module, bytes, man, set, visibility }], problems: [string] }. The bytes are what a worklet is sent: older Chrome
 * (146) refuses a WebAssembly.Module in postMessage to an AudioWorklet, the bytes work everywhere and the worklet compiles them itself.
 */
export async function loadInsertModules(fetchFn = fetch) {
  const out = { host: null, inserts: [], problems: [] }
  let idx
  try {
    const r = await fetchFn("/modules/index.json")
    if (!r.ok) { out.problems.push("no module set is installed on this server (bun run modules)"); return out }
    idx = await r.json()
  } catch (e) { out.problems.push("module set: " + e.message); return out }
  out.host = idx.host
  for (const m of idx.modules.filter((x) => x.kind === "master")) {
    try {
      const man = await (await fetchFn(`/modules/${m.manifest}`)).json()
      const bytes = new Uint8Array(await (await fetchFn(`/modules/${m.wasm}`)).arrayBuffer())
      await verify(bytes, man, idx.host, "master")
      out.inserts.push({ module: await WebAssembly.compile(bytes), bytes, man, set: m.set, visibility: m.visibility })
    } catch (e) { out.problems.push(`${m.manifest}: ${e.message}`) }
  }
  return out
}

/** The wasm host (poly.wasm, the "runtime" target): { module, bytes }. The module is instantiated here, the bytes go to the AudioWorklet, which compiles them itself. */
export async function loadHost(fetchFn = fetch) {
  const r = await fetchFn("/wasm/runtime/poly.wasm")
  if (!r.ok) throw new Error("poly.wasm: HTTP " + r.status)
  const bytes = await r.arrayBuffer()
  return { module: await WebAssembly.compile(bytes), bytes }
}

export class InsertChain {
  /**
   * factory: the emscripten module function of /wasm/runtime/poly.mjs (a worklet can only import it statically, hence a parameter).
   * host: the compiled poly.wasm or its bytes (a worklet gets the bytes, see loadInsertModules). inserts: [{ module, man }] as loadInsertModules gives them,
   * module being a compiled module or the bytes.
   */
  static async create(factory, host, inserts) {
    if (!(host instanceof WebAssembly.Module)) host = await WebAssembly.compile(host)
    const M = await factory({ instantiateWasm: (imports, done) => { done(new WebAssembly.Instance(host, imports), host); return {} } })
    return new InsertChain(M, inserts)
  }

  constructor(M, inserts) {
    this.M = M
    this.mods = new Map()
    for (const i of inserts) this.mods.set(i.man.name, { loaded: loadModule(M, i.module, i.man), man: i.man })
    this.applied = { mixer: 0, slots: [null, null], values: [[], []], fx: "" }
    this.L = M._ffm_buf(0) >> 2
    this.R = M._ffm_buf(1) >> 2
    this.P = M._ffm_fx_params() >> 2
  }

  has(name) { return this.mods.has(name) }

  /** Clears the DSP state of both slots and of the delay and reverb (a new render must not start with the tail of the last one) and forgets the applied values, so apply() sends them all again. */
  reset() {
    for (let slot = 0; slot < SLOTS; slot++) this.M._ffm_insert_reset(slot)
    this.M._ffm_fx_reset()
    this.applied.values = [[], []]
    this.applied.fx = ""
  }

  /** Makes the chain what the state says (`send` = { delay, reverb }: the loaded engine's own sends, the page resolves them with sendOf). A slot whose module changed is initialised again (the device does the same), the others only get the values that moved. A name this
   *  chain does not have (a missing module) leaves its slot empty. Cheap enough to call on every slider move. */
  apply(state, send = state.send ?? { delay: 0, reverb: 0 }) {
    const M = this.M, a = this.applied
    if (state.mixer !== a.mixer) { M._ffm_mixer_set(state.mixer); a.mixer = state.mixer }
    this.applyFx(state.fx ?? fxDefaults(), send)
    state.slots.forEach((s, slot) => {
      const name = s.name && this.mods.has(s.name) ? s.name : null
      if (name !== a.slots[slot]) {
        setInsert(M, slot, name ? this.mods.get(name).loaded : null)
        a.slots[slot] = name
        a.values[slot] = []
      }
      if (!name) return
      const man = this.mods.get(name).man
      man.params.forEach((p, i) => {
        const v = i < s.values.length ? s.values[i] : p.def
        if (a.values[slot][i] !== v) { M._ffm_insert_param(slot, i, v); a.values[slot][i] = v }
      })
    })
  }

  /** Sends the delay, reverb, send and limiter values to the host when one moved (the units of host/modules.cpp ffm_fx_params). */
  applyFx(f, send) {
    const l = f.limiter ?? fxDefaults().limiter
    const v = [f.tempo, f.delay.feedback, f.delay.time, (f.delay.pingpong ? 0x80 : 0) | (f.delay.sync ? 0x40 : 0) | f.delay.rate, f.delay.filter,
      f.reverb.size / 100, f.reverb.damp / 100, f.reverb.predelay / 100, f.reverb.diffusion * 0.0085, f.delay.level, f.reverb.level, f.delay.mute ? 1 : 0, f.reverb.mute ? 1 : 0,
      send.delay, send.reverb, 0, l.on ? 1 : 0, l.attack, l.release, limiterRaw(l.threshold), l.mode]
    const key = v.join(",")
    if (key === this.applied.fx) return
    this.M.HEAPF32.set(v, this.P)
    this.M._ffm_fx_apply()
    this.applied.fx = key
  }

  /** Something to do: an insert runs, a send is above zero, the Mixer is not Hard Clip, the limiter is on or a tail rings. Otherwise processMono() hands the engine block through untouched. */
  get active() { return this.M._ffm_engine_active() === 1 }

  /** The engine's mono blocks (a multiple of 128 frames) in, the stereo result out (the arrays may be the same length as the input, outL and outR are written). */
  processMono(mono, outL, outR) {
    const M = this.M
    if (!this.active) { outL.set(mono); outR.set(mono); return }
    for (let o = 0; o < mono.length; o += BLOCK) {
      const n = Math.min(BLOCK, mono.length - o)
      M.HEAPF32.fill(0, this.L, this.L + BLOCK)
      M.HEAPF32.set(mono.subarray(o, o + n), this.L)
      M._ffm_engine_block()
      outL.set(M.HEAPF32.subarray(this.L, this.L + n), o)
      outR.set(M.HEAPF32.subarray(this.R, this.R + n), o)
    }
  }

  /** A stereo block pair (128 frames each) in place: what the device's bus does with its two sides. */
  processStereo(l, r) {
    const M = this.M
    M.HEAPF32.set(l, this.L)
    M.HEAPF32.set(r, this.R)
    M._ffm_chain_buf()
    l.set(M.HEAPF32.subarray(this.L, this.L + BLOCK))
    r.set(M.HEAPF32.subarray(this.R, this.R + BLOCK))
  }
}

/** A float32 mono WAV (the server's render with float:true): { rate, samples } or null when it is anything else. */
export function parseFloatWav(buf) {
  const dv = new DataView(buf)
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3))
  if (buf.byteLength < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE" || dv.getUint16(20, true) !== 3 || dv.getUint16(22, true) !== 1 || dv.getUint16(34, true) !== 32) return null
  for (let o = 12; o + 8 <= buf.byteLength; ) {
    const n = dv.getUint32(o + 4, true)
    if (tag(o) === "data") return { rate: dv.getUint32(24, true), samples: new Float32Array(buf.slice(o + 8, o + 8 + n)) }
    o += 8 + n + (n & 1)
  }
  return null
}
