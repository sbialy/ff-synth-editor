// poly-live AudioWorklet of the static site (GitHub Pages): no server, no WebSocket. The wasm host (wasm/runtime/poly.mjs, scripts/build-wasm.ts) runs here,
// in the AudioWorklet itself, and is pulled: whenever the jitter buffer of live-core.js holds less than its target plus one block, the host renders
// its next 128 frame block (ph_block, the engine's own block, at the engine rate of 44117.647 Hz). The base class then reads the ring at the
// sound card's rate, so any AudioContext rate plays at the right pitch. The Mixer and the master inserts run as in worklet-inserts.js.
// Bytes, not compiled WebAssembly.Module objects: Chrome 146 refuses a Module posted to an AudioWorklet (messageerror, silence), the bytes work in every browser.
// A plain AudioWorklet: no SharedArrayBuffer, no COOP/COEP headers, which GitHub Pages cannot send.
//
// main -> worklet: {type:"host-init", host: the poly.wasm bytes, engines:[{module: the module's .wasm bytes, man}]}   {type:"line", line}  (one live.* request, the WebSocket text of the server page)
//                  {type:"chain-init", ...} {type:"chain-state", ...} as worklet-inserts.js
// worklet -> main: {type:"host-ready", engines} | {type:"host-error", error} | {type:"answer", answer} (only for an answer with ok:false)
//                  {type:"voices", voices, held} when either changes, and everything live-core.js and worklet-inserts.js send
import factory from "/wasm/runtime/poly.mjs"
import { PolyLiveBase } from "/live-core.js"
import { InsertChain } from "/inserts.js"
import { attachSynthIfSlot, loadModule } from "/ffmod.js"

class PolyLiveStatic extends PolyLiveBase {
  constructor(options) {
    super(options)
    this.M = null
    this.state = null
    this.cmdId = 0
    this.voices = -1
    this.held = -1
    this.block = new Float32Array(128)
  }

  onOther(m) {
    if (m.type === "host-init") {
      WebAssembly.compile(m.host).then((host) => factory({ instantiateWasm: (imports, done) => { done(new WebAssembly.Instance(host, imports), host); return {} } })).then((M) => {
        for (const e of m.engines) attachSynthIfSlot(M, loadModule(M, e.module, e.man))
        this.M = M
        this.port.postMessage({ type: "host-ready", engines: this.req({ cmd: "engines" }).engines.map((x) => x.name) })
      }).catch((e) => this.port.postMessage({ type: "host-error", error: String(e.message ?? e) }))
    } else if (m.type === "line") {
      if (!this.M) return
      const a = this.req(m.line)
      if (Number.isInteger(m.line.id)) this.cmdId = m.line.id
      if (a.ok === false) this.port.postMessage({ type: "answer", answer: a })
    } else if (m.type === "chain-init") {
      InsertChain.create(factory, m.host, m.inserts).then((chain) => {
        if (this.state) chain.apply(this.state)
        this.chain = chain
        this.port.postMessage({ type: "chain-ready" })
      }, (e) => this.port.postMessage({ type: "chain-error", error: String(e.message ?? e) }))
    } else if (m.type === "chain-state") {
      this.state = m.state
      try { this.chain?.apply(m.state) } catch (e) { this.port.postMessage({ type: "chain-error", error: String(e.message ?? e) }) }
    }
  }

  req(o) {
    const M = this.M
    try { return JSON.parse(M.UTF8ToString(M.ccall("ph_request", "number", ["string"], [JSON.stringify(o)]))) } catch (e) { return { ok: false, error: String(e.message ?? e) } }
  }

  process(inputs, outputs) {
    const M = this.M
    if (M) {
      // keep the ring one block above the target: the host renders on demand, it never runs ahead of the sound card by more than that
      while (this.w - this.r < this.target + 128) {
        const p = M._ph_block() >> 2
        this.block.set(M.HEAPF32.subarray(p, p + 128))
        this.push(this.block, this.cmdId)
      }
      const v = M._ph_voices(), h = M._ph_held()
      if (v !== this.voices || h !== this.held) { this.voices = v; this.held = h; this.port.postMessage({ type: "voices", voices: v, held: h }) }
    }
    return super.process(inputs, outputs)
  }
}
registerProcessor("poly-live", PolyLiveStatic)
