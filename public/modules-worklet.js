// AudioWorklet of the runtime module page (modules.html): the wasm host itself, no server and no WebSocket. One ph_block() per quantum
// (the engine block and the AudioWorklet quantum are both 128 frames): the engine, then insert 1, then insert 2 (host/modules.cpp).
// The modules arrive compiled and already verified by the page (sha256 needs crypto.subtle, which a worklet lacks), loadModule checks
// the rest again here.
//
// main -> worklet: {type:"init", host: WebAssembly.Module, engines:[{module, man}], inserts:[{module, man}]}
//                  {type:"line", line}  (a host request: live.open, live.note, ...)   {type:"insert", slot, name|null}
//                  {type:"param", slot, index, value}   {type:"bypass", slot, on}
// worklet -> main: {type:"ready", engines, noSlot} | {type:"error", error} | {type:"answer", answer} | {type:"slots", slots}
//                  {type:"stats", rms, peak, voices} every 32 quanta
import factory from "/wasm/runtime/poly.mjs"
import { attachSynthIfSlot, loadModule, setInsert } from "/ffmod.js"

class ModuleHost extends AudioWorkletProcessor {
  constructor() {
    super()
    this.M = null
    this.inserts = {}
    this.slots = [null, null]
    this.tick = 0
    this.sum = 0
    this.peak = 0
    this.port.onmessage = (e) => this.onMessage(e.data).catch((err) => this.port.postMessage({ type: "error", error: String(err.message ?? err) }))
  }

  async onMessage(m) {
    if (m.type === "init") {
      const M = await factory({ instantiateWasm: (imports, done) => { done(new WebAssembly.Instance(m.host, imports), m.host); return {} } })
      const noSlot = []
      // before the first request: the list is read once. An engine the host has no slot for (it is linked in, or not one of the host's runtime engines) is left out
      for (const e of m.engines) if (!attachSynthIfSlot(M, loadModule(M, e.module, e.man))) noSlot.push(e.man.name)
      for (const i of m.inserts) this.inserts[i.man.name] = { loaded: loadModule(M, i.module, i.man), man: i.man }
      this.M = M
      const r = this.req({ cmd: "engines" })
      this.port.postMessage({ type: "ready", engines: r.engines.map((x) => x.name), noSlot })
      return
    }
    const M = this.M
    if (!M) throw new Error("not initialised")
    if (m.type === "line") this.port.postMessage({ type: "answer", answer: this.req(m.line) })
    else if (m.type === "insert") {
      const ins = m.name ? this.inserts[m.name] : null
      if (m.name && !ins) throw new Error(`no insert ${m.name}`)
      setInsert(M, m.slot, ins ? ins.loaded : null)
      this.slots[m.slot] = m.name ?? null
      this.port.postMessage({ type: "slots", slots: this.slots })
    } else if (m.type === "param") M._ffm_insert_param(m.slot, m.index, m.value)
    else if (m.type === "bypass") M._ffm_insert_bypass(m.slot, m.on ? 1 : 0)
  }

  req(o) {
    const M = this.M
    return JSON.parse(M.UTF8ToString(M.ccall("ph_request", "number", ["string"], [JSON.stringify(o)])))
  }

  process(_inputs, outputs) {
    const out = outputs[0]
    if (!this.M) { for (const ch of out) ch.fill(0); return true }
    const p = this.M._ph_block() >> 2, h = this.M.HEAPF32
    out[0].set(h.subarray(p, p + 128))
    if (out[1]) out[1].set(h.subarray(p + 128, p + 256))
    for (let i = 0; i < 128; i++) { const v = h[p + i]; this.sum += v * v; this.peak = Math.max(this.peak, Math.abs(v)) }
    if (++this.tick % 32 === 0) {
      this.port.postMessage({ type: "stats", rms: Math.sqrt(this.sum / (32 * 128)), peak: this.peak, voices: this.M._ph_voices() })
      this.sum = 0
      this.peak = 0
    }
    return true
  }
}
registerProcessor("poly-modules", ModuleHost)
