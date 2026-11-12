// poly-live AudioWorklet: a jitter buffer between the 128 sample blocks of the native host (44117.647 Hz, arriving over the
// WebSocket) and the sound card clock. The read speed follows the buffer level, so the rate difference to the sound card and the
// clock drift between the two machines' clocks are absorbed without clicks and without growing latency.
//
// The target level adapts: every underrun raises it by 256 frames (up to 2048), 3 s without one lowers it by 64 again, down to
// the configured minimum. A quiet machine therefore plays at the minimum latency, a busy one trades latency for no dropouts.
//
// The ring holds two channels. A block goes in as the engine made it (mono, both sides the same) or, when a subclass sets `chain`
// (worklet-inserts.js: the Mixer and the two master inserts of public/inserts.js), as the stereo result of that chain. The chain runs on the
// engine's own 128 frame blocks, before the resampling to the sound card.
//
// main -> worklet: {type:"frames", pcm: Float32Array, cmdId} | {type:"config", target: frames} | {type:"reset"}
// worklet -> main: {type:"stats", fill, avg, target, underruns, overruns, ratio, rms, peak} every ~85 ms (rms and peak: what was played since the last
//                  one, left side), {type:"heard", cmdId, frame} when the first sample of a block that carries a new command id is played
const SIZE = 1 << 14, MASK = SIZE - 1

export class PolyLiveBase extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const o = options.processorOptions || {}
    this.engineRate = o.engineRate || 44117.647
    this.minTarget = this.target = o.target || 384
    this.quiet = 0        // quanta since the last underrun
    this.ring = new Float32Array(SIZE)
    this.ringR = new Float32Array(SIZE)
    this.chain = null     // an object with `active` and processMono(mono, outL, outR), set by a subclass
    this.sumSq = 0
    this.played = 0
    this.peak = 0
    this.scratchL = new Float32Array(128)
    this.scratchR = new Float32Array(128)
    this.w = 0            // frames written (absolute)
    this.r = 0            // read position (absolute, fractional)
    this.started = false
    this.avg = 0
    this.underruns = 0
    this.overruns = 0
    this.tick = 0
    this.tags = []        // {at, cmdId}: block start positions with a changed command id
    this.lastCmd = 0
    this.port.onmessage = (e) => {
      const m = e.data
      if (m.type === "frames") this.push(m.pcm, m.cmdId)
      else if (m.type === "config") this.minTarget = this.target = m.target
      else if (m.type === "reset") { this.started = false; this.r = this.w }
      else this.onOther(m)
    }
  }

  /** One block of engine frames into the ring (through the chain when a subclass set one). cmdId: the id of the last control line applied before it. */
  push(pcm, cmdId) {
    if (cmdId !== this.lastCmd) { this.tags.push({ at: this.w, cmdId }); this.lastCmd = cmdId }
    if (this.chain && this.chain.active && pcm.length === 128) {
      this.chain.processMono(pcm, this.scratchL, this.scratchR)
      for (let i = 0; i < 128; i++) { this.ring[(this.w + i) & MASK] = this.scratchL[i]; this.ringR[(this.w + i) & MASK] = this.scratchR[i] }
    } else {
      for (let i = 0; i < pcm.length; i++) { const k = (this.w + i) & MASK; this.ring[k] = pcm[i]; this.ringR[k] = pcm[i] }
    }
    this.w += pcm.length
  }

  /** A message of a type this class does not know (the subclass handles its own). */
  onOther(_m) {}

  process(_inputs, outputs) {
    const out = outputs[0], n = out[0].length
    const fill = this.w - this.r
    this.avg += (fill - this.avg) * 0.02
    if (!this.started) {
      if (fill >= this.target) { this.started = true; this.avg = fill } else { for (const ch of out) ch.fill(0); return true }
    }
    // a slow buffer is read slower, a full one faster (at most +-0.4 %, about 7 cents)
    const err = (this.avg - this.target) / this.target
    const ratio = (this.engineRate / sampleRate) * (1 + Math.max(-0.004, Math.min(0.004, err * 0.01)))
    if (fill > this.target * 4 + 512) { this.r = this.w - this.target; this.overruns++ }
    if (++this.quiet > 1100 && this.target > this.minTarget) { this.target = Math.max(this.minTarget, this.target - 64); this.quiet = 0 } // 1100 quanta = 3 s
    const l = out[0], rr = out.length > 1 ? out[1] : null
    for (let i = 0; i < n; i++) {
      if (this.w - this.r < 2) { // ran dry: silence, then prime again
        l.fill(0, i); if (rr) rr.fill(0, i); this.underruns++; this.started = false; this.quiet = 0; this.target = Math.min(2048, this.target + 256); break
      }
      const i0 = Math.floor(this.r), f = this.r - i0
      l[i] = this.ring[i0 & MASK] * (1 - f) + this.ring[(i0 + 1) & MASK] * f
      if (rr) rr[i] = this.ringR[i0 & MASK] * (1 - f) + this.ringR[(i0 + 1) & MASK] * f
      this.r += ratio
    }
    for (let c = 2; c < out.length; c++) out[c].set(rr ?? l)
    for (let i = 0; i < n; i++) { const v = l[i]; this.sumSq += v * v; if (Math.abs(v) > this.peak) this.peak = Math.abs(v) }
    this.played += n
    while (this.tags.length && this.tags[0].at <= this.r) { const t = this.tags.shift(); this.port.postMessage({ type: "heard", cmdId: t.cmdId, frame: currentFrame }) }
    if (++this.tick % 32 === 0) {
      this.port.postMessage({ type: "stats", fill: this.w - this.r, avg: this.avg, target: this.target, underruns: this.underruns, overruns: this.overruns, ratio, rms: Math.sqrt(this.sumSq / Math.max(1, this.played)), peak: this.peak })
      this.sumSq = 0; this.peak = 0; this.played = 0
    }
    return true
  }
}
