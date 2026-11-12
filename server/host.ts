// Client of the native poly_host process: JSON lines over stdin / stdout, one request in flight at a time.
// The engines whose code is private (PHZ and PLK, vendor/FIRMWARE.json "private") are not in the native host: their requests go to the wasm host
// with their runtime modules loaded (server/wasm-host.ts), and the engine list is merged. Without the modules built, the editor has the other engines.
import { hostBinary } from "../scripts/build"
import { OT3_MODULES } from "./engines"
import { firmware } from "./firmware"
import { sharedWasmHost, type WasmHost } from "./wasm-host"

type Resolver = { resolve: (v: any) => void; reject: (e: Error) => void }

export class HostClient {
  private proc: ReturnType<typeof Bun.spawn>
  private pending: Resolver[] = []
  private buffer = ""
  private chain: Promise<unknown> = Promise.resolve()
  private dead: Error | null = null
  /** the wasm host with the private engine modules, once `ready` has resolved (null: not built here) */
  wasm: WasmHost | null = null
  readonly ready: Promise<void>

  /** The private engines this host can answer for (their modules are loaded). */
  get privateEngines(): string[] {
    return this.wasm?.engines ?? []
  }

  constructor(binary = hostBinary) {
    this.ready = sharedWasmHost().then((w) => { this.wasm = w }, (e) => { console.error("private engine modules not loaded:", e); this.wasm = null })
    this.proc = Bun.spawn([binary, "--serve"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" })
    void this.pump()
    void this.proc.exited.then((code) => {
      this.dead = new Error(`poly_host exited (${code})`)
      for (const p of this.pending.splice(0)) p.reject(this.dead)
    })
  }

  private async pump() {
    const decoder = new TextDecoder()
    for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
      this.buffer += decoder.decode(chunk, { stream: true })
      let nl: number
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl)
        this.buffer = this.buffer.slice(nl + 1)
        const waiter = this.pending.shift()
        if (!waiter) continue
        try {
          waiter.resolve(JSON.parse(line))
        } catch (e) {
          waiter.reject(new Error("bad host answer: " + line.slice(0, 200)))
        }
      }
    }
  }

  /** Sends one request. Resolves with the answer object, throws when the host reports ok:false. */
  request<T = any>(req: Record<string, unknown>): Promise<T> {
    const run = async () => {
      if (this.dead) throw this.dead
      await this.ready
      const eng = (req.engine ?? (req.patch as any)?.engine) as string | undefined
      let answer: any
      if (typeof eng === "string" && firmware.private.engines.includes(eng)) {
        // a private engine: only the wasm host has it. Without its module this build does not offer it.
        answer = this.wasm && this.wasm.engines.includes(eng) ? this.wasm.request(req) : { ok: false, error: `engine ${eng} is not available in this build (its runtime module is not installed)` }
      } else {
        answer = await this.native(req)
        // a file whose engine id is a private engine's (roundtrip, or a load that names no engine): the wasm host knows it
        // (tracker-ff 1.2.0 on: the firmware's codec loads a plugin engine id it has not got as its "Missing" placeholder instead of refusing it)
        const notHere = /not available in this editor|not in this build|file is a Missing patch/.test(String(answer?.reason ?? answer?.error ?? "")) || answer?.engine === "Missing" || answer?.patch?.engine === "Missing"
        if (this.wasm && notHere && ["load", "roundtrip", "codec"].includes(String(req.cmd))) answer = this.wasm.request(req)
        if ((req.cmd === "engines" || req.cmd === "firmware") && this.wasm && answer?.ok !== false) answer = this.merged(answer, String(req.cmd))
      }
      if (answer && answer.ok === false && !req.allowFail) throw new HostError(answer.error ?? "host error", answer)
      return answer as T
    }
    const next = this.chain.then(run, run)
    this.chain = next.catch(() => {})
    return next
  }

  private native(req: Record<string, unknown>): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      this.pending.push({ resolve, reject })
      const stdin = this.proc.stdin as import("bun").FileSink
      stdin.write(JSON.stringify(req) + "\n")
      stdin.flush()
    })
  }

  /** The answer of `engines` or `firmware` (the raw tables) of the native host plus the private engines, which sit after the OpenTracker 2.x engines and CHIP (the firmware's list order: ... CHIP PHZ PLK, then the OpenTracker 3.x engines). */
  private merged(native: any, cmd: string): any {
    const priv = this.wasm!.request({ cmd }).engines.filter((e: any) => this.wasm!.engines.includes(e.name))
    const list: any[] = native.engines.filter((e: any) => !priv.some((p: any) => p.name === e.name))
    const at = list.findIndex((e) => e.group === "ot3" || Object.hasOwn(OT3_MODULES, e.name))
    list.splice(at < 0 ? list.length : at, 0, ...priv)
    return { ...native, engines: list }
  }

  /** Like request but returns ok:false answers instead of throwing (file level failures). */
  tryRequest<T = any>(req: Record<string, unknown>): Promise<T> {
    return this.request<T>({ ...req, allowFail: true })
  }

  close() {
    try {
      ;(this.proc.stdin as import("bun").FileSink).end()
    } catch {}
    this.proc.kill()
  }
}

export class HostError extends Error {
  constructor(message: string, public answer: unknown) {
    super(message)
  }
}
