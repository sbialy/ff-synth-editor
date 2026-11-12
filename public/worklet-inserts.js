// poly-live AudioWorklet with the Mixer stage and the two master inserts (public/inserts.js, the wasm host's chain of host/modules.cpp) between the engine
// blocks and the jitter buffer. Loaded only when /wasm/runtime/poly.mjs exists: a worklet can import it statically only, so a missing file would stop the
// whole module (public/app.js falls back to worklet.js).
//
// main -> worklet: {type:"chain-init", host: the poly.wasm bytes, inserts:[{module: the module's .wasm bytes, man}]}   {type:"chain-state", state: {mixer, slots:[{name, values}]}}
// worklet -> main: {type:"chain-ready"} | {type:"chain-error", error}
import factory from "/wasm/runtime/poly.mjs"
import { PolyLiveBase } from "/live-core.js"
import { InsertChain } from "/inserts.js"

class PolyLiveInserts extends PolyLiveBase {
  constructor(options) {
    super(options)
    this.state = null
  }

  onOther(m) {
    if (m.type === "chain-init") {
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
}
registerProcessor("poly-live", PolyLiveInserts)
