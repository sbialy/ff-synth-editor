// poly-live AudioWorklet without master inserts: the jitter buffer of live-core.js alone. The page loads worklet-inserts.js instead when the wasm host and
// the insert modules are installed (public/app.js).
import { PolyLiveBase } from "/live-core.js"
registerProcessor("poly-live", PolyLiveBase)
