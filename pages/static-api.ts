// The /api of server/index.ts for the static site (GitHub Pages, scripts/pages.ts): the same routes answered in the page, by the wasm host (wasm/runtime/poly.mjs)
// on the main thread, with the runtime modules of modules/index.json attached. public/app.js sends its requests here instead of to fetch() when the page is
// the static build (<html data-static="1">). The answers are real Response objects with the server's status codes and headers, so app.js reads them
// as it reads the server's. Release mode only: Strict always, the engines of the firmware release image only.
//
// What a static page cannot do is cut, not faked: there is no patch folder (no /api/config folder, no /api/patches list, no /api/ratings), the
// bundled default patches are the list, a .patch file is opened from the disk and saved as a download (openPatchFile, patchFile).
// The live session is not here: it runs in the AudioWorklet (pages/worklet-static.js), this module only hands it the compiled host and modules.
// Bundled by scripts/pages.ts (Bun.build) into dist/static-api.js.
import { resolveTyped, nudgeText, type Param } from "../server/typed"
import { attachSynthIfSlot, checkManifest, loadModule, verify } from "../public/ffmod.js"

type Json = Record<string, any>
/** written by scripts/pages.ts from vendor/FIRMWARE.json and server/engines.ts */
type StaticConfig = { firmware: Json; served: string[]; privateEngines: string[]; runtimeEngines: string[]; defaultsMinStars?: number }

const url = (p: string) => new URL(p, document.baseURI).href
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

type Booted = { M: any; cfg: StaticConfig; served: string[]; engines: { module: WebAssembly.Module; bytes: Uint8Array; man: Json }[]; hostModule: WebAssembly.Module; hostBytes: ArrayBuffer; problems: string[] }
let booted: Promise<Booted> | null = null
let tmp = 0

/** The host on this thread, the module set loaded and checked once. */
export function boot(): Promise<Booted> {
  return (booted ??= (async () => {
    const cfg: StaticConfig = await (await fetch(url("static-config.json"))).json()
    const hostBytes = await (await fetch(url("wasm/runtime/poly.wasm"))).arrayBuffer()
    const hostModule = await WebAssembly.compile(hostBytes)
    const factory = (await import(/* @vite-ignore */ url("wasm/runtime/poly.mjs"))).default
    const M = await factory({ instantiateWasm: (imports: any, done: any) => { done(new WebAssembly.Instance(hostModule, imports), hostModule); return {} } })
    const engines: Booted["engines"] = []
    const problems: string[] = []
    const attached: string[] = []
    const r = await fetch(url("modules/index.json")).catch(() => null)
    if (r?.ok) {
      const idx = await r.json()
      for (const m of idx.modules.filter((x: Json) => x.kind === "synth")) {
        try {
          const man = await (await fetch(url(`modules/${m.manifest}`))).json()
          const bytes = new Uint8Array(await (await fetch(url(`modules/${m.wasm}`))).arrayBuffer())
          checkManifest(man, idx.host, "synth")
          await verify(bytes, man, idx.host, "synth")
          const module = await WebAssembly.compile(bytes)
          // only the engines the host has a runtime slot for (PHZ, PLK, JU6): the other modules of the set are linked into this host
          if (attachSynthIfSlot(M, loadModule(M, module, man))) { engines.push({ module, bytes, man }); attached.push(man.name) }
        } catch (e) { problems.push(`${m.manifest}: ${(e as Error).message}`) }
      }
    } else problems.push("no module set in this build")
    const have = new Set(req(M, { cmd: "engines" }).engines.map((e: Json) => e.name))
    const served = cfg.served.filter((e) => have.has(e) && (!cfg.runtimeEngines.includes(e) || attached.includes(e)))
    return { M, cfg, served, engines, hostModule, hostBytes, problems }
  })())
}

function req(M: any, o: Json): Json {
  return JSON.parse(M.UTF8ToString(M.ccall("ph_request", "number", ["string"], [JSON.stringify(o)])))
}

class Host {
  constructor(private M: any) {}
  async request<T = any>(o: Json): Promise<T> {
    const a = req(this.M, o)
    if (a.ok === false) throw new HttpError(422, a.error)
    return a as T
  }
  /** one request with a file in the memory file system: bytes in before it (load), the file's bytes out after it (save, render) */
  withFile(o: Json, key: "path" | "out", bytesIn?: Uint8Array): { answer: Json; bytes: Uint8Array | null } {
    const p = `/static-${tmp++}`
    if (bytesIn) this.M.FS.writeFile(p, bytesIn)
    try {
      const answer = req(this.M, { ...o, [key]: p })
      if (answer.ok === false) throw new HttpError(422, answer.error)
      const bytes = this.M.FS.analyzePath(p).exists ? (this.M.FS.readFile(p) as Uint8Array) : null
      return { answer, bytes }
    } finally {
      if (this.M.FS.analyzePath(p).exists) this.M.FS.unlink(p)
    }
  }
}

const json = (data: unknown, status = 200) => Response.json(data, { status })
const metaCache = new Map<string, Json>()

async function handle(b: Booted, method: string, path: string, body: Json): Promise<Response> {
  const host = new Host(b.M)
  const u = new URL(path, "http://static")
  const route = `${method} ${u.pathname}`
  const engineOf = (v: unknown) => {
    if (typeof v !== "string" || !b.served.includes(v)) throw new HttpError(400, "engine must be one of " + b.served.join(" "))
    return v
  }
  const meta = async (engine: string) => {
    if (!metaCache.has(engine)) metaCache.set(engine, await host.request({ cmd: "meta", engine }))
    return metaCache.get(engine)!
  }
  switch (route) {
    case "GET /api/engines": {
      const r = await host.request({ cmd: "engines" })
      r.engines = r.engines.filter((e: Json) => b.served.includes(e.name))
      for (const e of r.engines) {
        e.onTracker = true
        e.closed = b.cfg.privateEngines.includes(e.name)
      }
      return json({ ...r, release: true, static: true, firmware: b.cfg.firmware, ...(b.problems.length ? { problems: b.problems } : {}) })
    }
    case "GET /api/config":
      return json({ dir: "", volumes: [] })
    case "POST /api/config":
    case "GET /api/patches":
    case "GET /api/ratings":
    case "PUT /api/ratings":
    case "POST /api/save":
      throw new HttpError(404, "the web version has no patch folders: open a .patch file, Save downloads it")
    case "POST /api/describe":
      return json(await host.request({ cmd: "describe", engine: engineOf(body.engine), patch: body.patch, macroValues: body.macroValues }))
    case "POST /api/knob":
      return json(await host.request({ cmd: "knob", engine: engineOf(body.engine), param: body.param, knob: body.knob, patch: body.patch }))
    case "POST /api/knobs":
      return json(await host.request({ cmd: "knobs", engine: engineOf(body.engine), items: body.items, patch: body.patch }))
    case "POST /api/encode":
      return json(await host.request({ cmd: "encode", patch: body.patch }))
    case "POST /api/typed": {
      const engine = engineOf(body.engine)
      const p = (await meta(engine)).params[Number(body.param)] as Param
      if (!p) throw new HttpError(400, "param out of range")
      if (typeof body.text !== "string" || body.text.length > 64) throw new HttpError(400, "text must be a short string")
      const r = await resolveTyped(host, engine, p, body.text, body.patch).catch((e) => ({ ok: false as const, error: String(e?.message ?? e) }))
      if (!r.ok) throw new HttpError(422, r.error)
      return json(r)
    }
    case "POST /api/nudge": {
      const engine = engineOf(body.engine)
      const p = (await meta(engine)).params[Number(body.param)] as Param
      if (!p || p.names) throw new HttpError(400, "param out of range")
      if (!Number.isInteger(body.pos) || body.pos < 0 || body.pos > 65535 || (body.dir !== 1 && body.dir !== -1)) throw new HttpError(400, "pos must be 0..65535 and dir 1 or -1")
      return json({ step: await nudgeText(host, engine, p, body.pos, body.dir, body.text, body.patch) })
    }
    case "POST /api/load": {
      const engine = engineOf(body.engine)
      if (body.bundled !== true) throw new HttpError(400, "the web version has no patch folders")
      if (typeof body.name !== "string" || !body.name || /[\/\\]/.test(body.name)) throw new HttpError(400, "name missing")
      const f = await fetch(url(`defaults/${encodeURIComponent(engine)}/${encodeURIComponent(body.name)}.patch`))
      if (!f.ok) throw new HttpError(404, "no such bundled patch")
      return json(host.withFile({ cmd: "load", engine }, "path", new Uint8Array(await f.arrayBuffer())).answer)
    }
    case "POST /api/render": {
      const { answer, bytes } = host.withFile({ cmd: "render", engine: engineOf(body.engine), patch: body.patch, macroValues: body.macroValues, note: body.note, velocity: body.velocity,
        seconds: body.seconds, hold: body.hold, voices: body.voices, strict: true, ...(body.float === true ? { float: true } : {}) }, "out")
      if (!bytes) throw new HttpError(500, "the render wrote no file")
      return new Response(bytes, { headers: { "content-type": "audio/wav", "x-render-peak": String(answer.peak), "x-render-rms": String(answer.rms) } })
    }
    default:
      if (method === "GET" && u.pathname.startsWith("/api/meta/")) return json(await meta(engineOf(u.pathname.slice("/api/meta/".length))))
      throw new HttpError(404, "no such endpoint")
  }
}

/** fetch() for the /api paths of the server, answered here. */
export async function staticFetch(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    const b = await boot()
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {}
    return await handle(b, (init.method ?? "GET").toUpperCase(), path, body)
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message ?? e) }, e instanceof HttpError ? e.status : 500)
  }
}

/** A .patch file the user opened: {ok, engine, size, patch, warnings} (the host's load answer), or an error for a file of an engine this site does not have. */
export async function openPatchFile(file: Blob): Promise<Json> {
  const b = await boot()
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length > 64 * 1024) throw new Error("this is not a .patch file (too big)")
  const answer = new Host(b.M).withFile({ cmd: "load" }, "path", bytes).answer
  if (!b.served.includes(answer.engine)) throw new Error("this patch file is for an engine that is not available here")
  return answer
}

/** The .patch bytes of a patch, for a download. */
export async function patchFile(patch: Json): Promise<Uint8Array> {
  const b = await boot()
  const { bytes } = new Host(b.M).withFile({ cmd: "save", patch }, "path")
  if (!bytes) throw new Error("the host wrote no file")
  return bytes
}

/**
 * What the live AudioWorklet needs to run its own host: the bytes of poly.wasm and of the engine modules attached here. Bytes, not compiled modules:
 * Chrome 146 refuses a WebAssembly.Module posted to an AudioWorklet (messageerror) and the worklet then stays silent. It compiles the bytes itself.
 */
export async function liveHost(): Promise<{ host: ArrayBuffer; engines: { module: Uint8Array; man: Json }[] }> {
  const b = await boot()
  return { host: b.hostBytes, engines: b.engines.map((e) => ({ module: e.bytes, man: e.man })) }
}
