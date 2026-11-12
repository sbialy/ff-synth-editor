// Live audio: one long-lived `poly_host --stream` process whose real-time 128 sample blocks are relayed to the browsers over a
// WebSocket, and the browsers' note / knob messages go the other way. The process only runs while a page is connected.
import { hostBinary } from "../scripts/build"
import { firmware } from "./firmware"
import type { WasmHost } from "./wasm-host"

export const FRAME_MAGIC = 0x314d4350 // "PCM1"
export const FRAME_BLOCK = 128
export const FRAME_HEADER = 24
export const FRAME_BYTES = FRAME_HEADER + FRAME_BLOCK * 4 // u32 magic, seq, cmdId, frames, voices sounding, voices held, then f32 mono samples

/** Control lines a page may send. live.pull (manual stepping) is for tests and is never forwarded. */
export const LIVE_COMMANDS = ["live.open", "live.note", "live.param", "live.macro", "live.patch", "live.panic", "live.voices", "live.cc", "live.bend", "live.close"]

export class LiveHost {
  private proc: ReturnType<typeof Bun.spawn>
  private pending = new Uint8Array(0)
  exited = false

  constructor(binary: string = hostBinary, private onFrame: (frame: Uint8Array) => void) {
    this.proc = Bun.spawn([binary, "--stream"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" })
    void this.pump()
    void this.proc.exited.then(() => (this.exited = true))
  }

  private async pump() {
    for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
      let buf = chunk
      if (this.pending.length) {
        buf = new Uint8Array(this.pending.length + chunk.length)
        buf.set(this.pending)
        buf.set(chunk, this.pending.length)
      }
      let o = 0
      while (buf.length - o >= FRAME_BYTES) {
        this.onFrame(buf.slice(o, o + FRAME_BYTES)) // a copy: the chunk buffer is reused by the stream
        o += FRAME_BYTES
      }
      this.pending = buf.slice(o)
    }
  }

  send(line: string) {
    if (this.exited) return
    const stdin = this.proc.stdin as import("bun").FileSink
    stdin.write(line + "\n")
    stdin.flush()
  }

  close() {
    this.exited = true
    try {
      ;(this.proc.stdin as import("bun").FileSink).end()
    } catch {}
    this.proc.kill()
  }
}

// ---- the private engines (PHZ, PLK): live blocks from the wasm host with their runtime modules (server/wasm-host.ts), the same frames as poly_host --stream

/** The control lines and the block frames of one stream on the wasm host: what poly_host's streamMain does (seq, the id of the last control line). */
export class WasmStream {
  private seq = 0
  private lastId = 0
  constructor(private wasm: WasmHost) {}

  /** The next block as a frame. */
  block(): Uint8Array {
    return this.wasm.block(this.seq++, this.lastId)
  }

  /** One control line. A live.pull gives its blocks, anything else is applied to the session and gives none. */
  line(line: string): Uint8Array[] {
    if (!line) return []
    let req: Record<string, any> = {}
    try {
      req = JSON.parse(line)
    } catch {}
    if (typeof req.id === "number") this.lastId = req.id >>> 0
    if (req.cmd === "live.pull") return Array.from({ length: Math.min(Math.max(Number(req.blocks ?? 1) | 0, 0), 100000) }, () => this.block())
    const a = this.wasm.request(req)
    if (a.ok === false) console.error("wasm live: " + JSON.stringify(a))
    return []
  }
}

/** poly_host --stream --manual over the wasm host (tests): the blocks of every live.pull, concatenated. */
export function wasmStreamManual(wasm: WasmHost, lines: object[]): Uint8Array {
  const s = new WasmStream(wasm)
  const frames = lines.flatMap((l) => s.line(JSON.stringify(l)))
  const out = new Uint8Array(frames.reduce((n, f) => n + f.length, 0))
  let o = 0
  for (const f of frames) { out.set(f, o); o += f.length }
  return out
}

const BLOCK_MS = FRAME_BLOCK / 44117.647 * 1000

/** Real time live stream on the wasm host: a block every 2.9 ms by the wall clock, control lines applied between blocks. Same interface as LiveHost. */
export class WasmLive {
  exited = false
  private stream: WasmStream
  private timer: ReturnType<typeof setInterval>
  private next = performance.now()

  constructor(wasm: WasmHost, private onFrame: (frame: Uint8Array) => void) {
    this.stream = new WasmStream(wasm)
    this.timer = setInterval(() => this.tick(), 1)
  }

  private tick() {
    if (this.exited) return
    let now = performance.now()
    if (now > this.next + 50) this.next = now // fell behind (a busy server, a sleeping machine): no burst to catch up
    for (let n = 0; n < 8 && now >= this.next; n++) {
      this.onFrame(this.stream.block())
      this.next += BLOCK_MS
      now = performance.now()
    }
  }

  send(line: string) {
    if (!this.exited) this.stream.line(line)
  }

  close() {
    this.exited = true
    clearInterval(this.timer)
  }
}

/**
 * The live session of a page: poly_host --stream for the engines it has, the wasm host for the private ones. The backend is chosen by the engine
 * of each live.open and switched when it changes (the one not in use is closed: only one stream sends frames). Same interface as LiveHost.
 */
export class LiveSession {
  private cur: { kind: "native" | "wasm"; send(line: string): void; close(): void; exited: boolean }
  private closed = false

  constructor(private binary: string | undefined, private onFrame: (frame: Uint8Array) => void, private wasm: WasmHost | null) {
    this.cur = this.open("native")
  }

  private open(kind: "native" | "wasm") {
    if (kind === "wasm" && this.wasm) return Object.assign(new WasmLive(this.wasm, this.onFrame), { kind: "wasm" as const })
    return Object.assign(new LiveHost(this.binary, this.onFrame), { kind: "native" as const })
  }

  get exited() {
    return this.closed || this.cur.exited
  }

  send(line: string) {
    if (this.closed) return
    let req: Record<string, any> | null = null
    try {
      req = JSON.parse(line)
    } catch {}
    if (req?.cmd === "live.open") {
      const eng = req.engine ?? req.patch?.engine
      const kind = typeof eng === "string" && firmware.private.engines.includes(eng) && this.wasm?.engines.includes(eng) ? "wasm" : "native"
      if (kind !== this.cur.kind) {
        this.cur.close()
        this.cur = this.open(kind)
      }
    }
    this.cur.send(line)
  }

  close() {
    this.closed = true
    this.cur.close()
  }
}
