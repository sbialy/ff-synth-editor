// Shared by test/fx.test.ts and test/fx-m4.test.ts: the test signal and the scenario types.
export const SR = 44117.647
export function lcg(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 * 2 - 1 } }
/** A test signal: three notes with decays, a burst of noise, a hot (clipping) stretch and silence, `blocks` blocks of 128. */
export function signal(blocks: number, seed = 1): Float32Array {
  const r = lcg(seed), out = new Float32Array(blocks * 128)
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const n1 = i < 20000 ? Math.sin(2 * Math.PI * 220 * t) * 0.6 * Math.exp(-i / 9000) : 0
    const n2 = i >= 12000 && i < 30000 ? Math.sin(2 * Math.PI * 331 * t) * 0.5 * Math.exp(-(i - 12000) / 7000) : 0
    const burst = i >= 30000 && i < 31500 ? r() * 0.4 : 0
    const hot = i >= 40000 && i < 41500 ? Math.sin(2 * Math.PI * 110 * t) * 1.8 : 0
    out[i] = n1 + n2 + burst + hot
  }
  return out
}
export type P = { tempo: number; delayFeedback: number; delayTime: number; delayParams: number; delayFilter: number; reverbSize: number; reverbDamp: number; reverbPredelay: number; reverbDiffusion: number; delayVolume: number; reverbVolume: number; delayMute: number; reverbMute: number; delaySend: number; reverbSend: number; mixer: number; limiterOn: number; limiterAttack: number; limiterRelease: number; limiterThreshold: number; limiterMode: number }
export const DEF: P = { tempo: 130, delayFeedback: 50, delayTime: 500, delayParams: 0, delayFilter: 20000, reverbSize: 0.5, reverbDamp: 0.5, reverbPredelay: 0.5, reverbDiffusion: 0.68, delayVolume: 86, reverbVolume: 86, delayMute: 0, reverbMute: 0, delaySend: 0, reverbSend: 0, mixer: 0, limiterOn: 0, limiterAttack: 100, limiterRelease: 0.512, limiterThreshold: 30200, limiterMode: 0 }
export type Run = { name: string; p: Partial<P>; blocks: number; at?: [number, Partial<P>][]; seed?: number }


/** The scenarios of the bit identity tests (test/fx.test.ts native against wasm, test/fx-m4.test.ts the Cortex-M4F build against native). */
export const RUNS: Run[] = [
  { name: "delay only", p: { delaySend: 70 }, blocks: 700 },
  { name: "reverb only", p: { reverbSend: 70 }, blocks: 700 },
  { name: "both sends at 100, size and diffusion up", p: { delaySend: 100, reverbSend: 100, reverbSize: 0.9, reverbDiffusion: 0.85, delayFeedback: 80 }, blocks: 900 },
  { name: "ping pong, filter 3 kHz, 333 ms", p: { delaySend: 60, delayParams: 0x80, delayFilter: 3000, delayTime: 333, reverbSend: 20 }, blocks: 700 },
  { name: "tempo sync 1/8 at 97 BPM", p: { delaySend: 60, delayParams: 0x40 | 14, tempo: 97, delayFeedback: 60 }, blocks: 700 },
  { name: "soft clip mixer, hot input, both sends", p: { delaySend: 80, reverbSend: 80, mixer: 1 }, blocks: 700 },
  { name: "soft knee mixer, both sends", p: { delaySend: 80, reverbSend: 80, mixer: 10 }, blocks: 700 },
  { name: "mixer only, soft clip, no send", p: { mixer: 1 }, blocks: 400 },
  { name: "mute, levels and damping", p: { delaySend: 90, reverbSend: 90, delayVolume: 40, reverbVolume: 100, reverbDamp: 0.9, reverbPredelay: 0.1, reverbMute: 1 }, blocks: 600 },
  { name: "parameters moved while playing", p: { delaySend: 50, reverbSend: 30 }, blocks: 900, at: [[100, { delayTime: 120, delayFeedback: 90 }], [200, { delayParams: 0x80, reverbSend: 100 }], [300, { delayParams: 0x40 | 4, tempo: 140 }], [400, { delaySend: 0, mixer: 10 }], [500, { tempo: 155 }], [600, { reverbSize: 0.2, delayFilter: 800, delaySend: 100 }]] },
  // the master limiter, after the inserts and the Mixer: the rest is the Limiter screen and the config menu's mode
  { name: "limiter on, device defaults, hot input, both sends", p: { limiterOn: 1, delaySend: 60, reverbSend: 60 }, blocks: 700 },
  { name: "limiter alone, threshold 9000, Subtle", p: { limiterOn: 1, limiterThreshold: 9000 }, blocks: 500 },
  { name: "limiter Extreme mode, attack 20, release 300, threshold 6000, soft clip mixer", p: { limiterOn: 1, limiterMode: 1, limiterAttack: 20, limiterRelease: 300, limiterThreshold: 6000, mixer: 1 }, blocks: 500 },
  { name: "limiter Subtle, attack 800, release 1000, threshold 12000, delay", p: { limiterOn: 1, limiterAttack: 800, limiterRelease: 1000, limiterThreshold: 12000, delaySend: 70 }, blocks: 600 },
  { name: "limiter parameters moved while playing", p: { limiterOn: 1, limiterThreshold: 20000, reverbSend: 40 }, blocks: 900, at: [[60, { limiterThreshold: 3000 }], [150, { limiterAttack: 5, limiterRelease: 50 }], [250, { limiterMode: 1 }], [350, { limiterOn: 0 }], [420, { limiterOn: 1, limiterThreshold: 8000 }], [500, { limiterMode: 0, limiterAttack: 400, limiterRelease: 700 }], [600, { limiterThreshold: 32767, delaySend: 90 }], [700, { limiterThreshold: 1500, limiterRelease: 2 }]] },
]

/** The page's 24 floats in the order of host/modules.cpp ffm_fx_params(): what test/fx.test.ts and the page tests put into the wasm host. */
export const hostParams = (c: P): number[] => [c.tempo, c.delayFeedback, c.delayTime, c.delayParams, c.delayFilter, c.reverbSize, c.reverbDamp, c.reverbPredelay, c.reverbDiffusion, c.delayVolume, c.reverbVolume, c.delayMute, c.reverbMute, c.delaySend, c.reverbSend, 0, c.limiterOn, c.limiterAttack, c.limiterRelease, c.limiterThreshold, c.limiterMode]
