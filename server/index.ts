// FF SYNTH EDITOR server: Bun.serve on localhost, spawns poly_host and serves the single page in public/. PHZ and PLK (private source) are answered
// from the wasm host with their runtime modules (server/host.ts, server/wasm-host.ts).
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { moduleRoute } from "./modules-routes"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { HostClient, HostError } from "./host"
import { LiveSession, LIVE_COMMANDS } from "./live"
import { build, math } from "../scripts/build"
import { firmware, firmwareInfo } from "./firmware"
import { ENGINES, EXPERIMENTAL_ENGINES, FIRMWARE_ENGINES, HIDDEN_ENGINES } from "./engines"
import { resolveTyped, nudgeText } from "./typed"
import { readRatings, writeRating, RatingError } from "./ratings"
import { defaultPatchPath, DEFAULTS_DIR } from "./defaults"

const publicDir = join(import.meta.dir, "../public")

/**
 * `release` is the published variant: Strict is on for good (the page has no toggle, render and live always run Strict) and only the engines of
 * the firmware release image exist (no Pluck, no Hand-Type, nothing the tag lacks). Default is dev mode, for testing new firmware. It is chosen
 * by the process that serves, `POLY_RELEASE=1` or the option, never by anything a page visitor sends.
 */
export type ServerOptions = { port?: number; hostname?: string; binary?: string; dir?: string; release?: boolean; allowedHosts?: string[] }

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

/** Patch folder root: a path that already ends in an engine folder (…/Patches/ACD) is taken as its parent (any letter case: a card folder may be called acd). */
export function patchRoot(dir: string): string {
  const d = resolve(dir)
  return ENGINES.includes(basename(d).toUpperCase()) ? dirname(d) : d
}

function engineOfIn(v: unknown, allowed: readonly string[] = ENGINES): string {
  if (typeof v !== "string" || !allowed.includes(v)) throw new HttpError(400, "engine must be one of " + allowed.join(" "))
  return v
}

/** A patch name is one path component: no separators, no leading dot, no control characters. */
export function safeName(v: unknown): string {
  if (typeof v !== "string") throw new HttpError(400, "name missing")
  const n = v.replace(/\.patch$/i, "").trim()
  if (!n || n.length > 64 || n.startsWith(".") || /[\/\\:\x00-\x1f]/.test(n)) throw new HttpError(400, "bad patch name (no slashes, no leading dot, max 64 chars)")
  return n
}

/** A file of the bundled default set (public/defaults): the manifest, or a patch the manifest lists. The same URLs a static build serves. */
async function defaultsFile(pathname: string): Promise<Response> {
  const parts = pathname.slice("/defaults/".length).split("/").map((p) => { try { return decodeURIComponent(p) } catch { return "" } })
  const headers = { "cache-control": "no-store" }
  if (parts.length === 1 && parts[0] === "index.json") {
    const f = Bun.file(join(DEFAULTS_DIR, "index.json"))
    if (!(await f.exists())) throw new HttpError(404, "not found")
    return new Response(f, { headers })
  }
  const [engine, file] = parts
  const path = parts.length === 2 && file?.endsWith(".patch") ? defaultPatchPath(engine, file.slice(0, -6)) : null
  if (!path) throw new HttpError(404, "not found")
  return new Response(Bun.file(path), { headers })
}

export async function startServer(opts: ServerOptions = {}) {
  await build() // incremental, a no-op when the binary is current
  const host = new HostClient(opts.binary)
  await host.ready // the wasm host with the runtime engine modules, if they are built here
  const metaCache = new Map<string, unknown>()
  const state = { dir: opts.dir ?? process.env.POLY_PATCH_DIR ?? "" }
  const release = opts.release ?? process.env.POLY_RELEASE === "1"
  // extra Host header names the DNS rebinding guard accepts, opt in only: POLY_ALLOWED_HOSTS=name.example,other.example. Default none.
  const allowedHosts = (opts.allowedHosts ?? (process.env.POLY_ALLOWED_HOSTS ?? "").split(","))
    .map((h) => h.trim().replace(/:\d+$/, ""))
    .filter(Boolean)
  // the engines this server serves: all of them in dev mode, only the release image of the firmware tag in release mode
  // (a private engine whose runtime module is not installed in this build is not served)
  const present = (e: string) => !firmware.private.engines.includes(e) || host.privateEngines.includes(e)
  const served: readonly string[] = (release ? ENGINES.filter((e) => FIRMWARE_ENGINES.includes(e) && !HIDDEN_ENGINES.includes(e)) : ENGINES).filter(present)
  const engineOf = (v: unknown) => engineOfIn(v, served)
  const strictOf = (v: unknown) => release || v === true
  // which engine library this server runs: only set for the POLY_FPCONTRACT A/B builds, and only when the host is that build's own binary. Dev only, the
  // release build says nothing about how its host was compiled
  const mathInfo = math.fpContract && !opts.binary && !release ? { fpContract: math.fpContract, arch: math.arch, label: math.label } : null
  let indexHtml: string | null = null // the page for release mode: the Strict box and the editor-only hint are cut out of the markup, not hidden

  const json = (data: unknown, status = 200) => Response.json(data, { status })
  const engineMeta = async (engine: string) => {
    if (!metaCache.has(engine)) metaCache.set(engine, await host.request({ cmd: "meta", engine }))
    return metaCache.get(engine)
  }

  // ---- live audio (WebSocket /api/live): the stream host runs while at least one page is connected
  let live: LiveSession | null = null
  let liveClients = 0
  const stopLive = () => {
    live?.close()
    live = null
  }

  async function listPatches(dir: string, engine: string): Promise<string[]> {
    try {
      const names = await readdir(join(patchRoot(dir), engine))
      return names.filter((n) => n.toLowerCase().endsWith(".patch") && !n.startsWith(".")).map((n) => n.slice(0, -6)).sort((a, b) => a.localeCompare(b))
    } catch {
      return []
    }
  }

  async function volumes(): Promise<{ name: string; path: string; hasPatches: boolean }[]> {
    const out: { name: string; path: string; hasPatches: boolean }[] = []
    try {
      for (const v of await readdir("/Volumes")) {
        const p = join("/Volumes", v, "Patches")
        const has = await stat(p).then((s) => s.isDirectory(), () => false)
        out.push({ name: v, path: p, hasPatches: has })
      }
    } catch {}
    return out
  }

  async function handleApi(req: Request, url: URL): Promise<Response> {
    const route = `${req.method} ${url.pathname}`
    const body = req.method === "POST" || req.method === "PUT" ? ((await req.json().catch(() => {
      throw new HttpError(400, "body must be JSON")
    })) as Record<string, any>) : {}

    switch (route) {
      case "GET /api/engines": {
        const r = await host.request({ cmd: "engines" })
        // the page gets the engines it offers: nothing is hidden since tracker-ff 1.2.0 (HIDDEN_ENGINES is empty)
        r.engines = r.engines.filter((e: any) => !HIDDEN_ENGINES.includes(e.name) && served.includes(e.name))
        for (const e of r.engines) {
          e.onTracker = FIRMWARE_ENGINES.includes(e.name) // in the release image of the pinned firmware
          e.closed = firmware.private.engines.includes(e.name) // not open source: PHZ and PLK, run from the runtime modules of the "engines" set (modules.lock.json)
          e.experimental = EXPERIMENTAL_ENGINES.includes(e.name) // not in the release image of the pinned firmware
          if (release) delete e.experimental // the release page has no such notion
        }
        return json({ ...r, release, firmware: firmwareInfo(release), ...(mathInfo ? { math: mathInfo } : {}) })
      }
      case "GET /api/config":
        return json({ dir: state.dir, volumes: await volumes() })
      case "POST /api/config": {
        if (typeof body.dir !== "string") throw new HttpError(400, "dir missing")
        state.dir = body.dir
        return json({ dir: state.dir, exists: await stat(patchRoot(state.dir)).then((s) => s.isDirectory(), () => false) })
      }
      case "GET /api/patches": {
        const engine = engineOf(url.searchParams.get("engine"))
        const dir = url.searchParams.get("dir") ?? state.dir
        return json({ dir, root: dir ? patchRoot(dir) : "", names: dir ? await listPatches(dir, engine) : [] })
      }
      case "GET /api/ratings": { // the stars of the patches of a folder (ratings.json next to them), same folder rules as /api/patches
        const engine = engineOf(url.searchParams.get("engine"))
        const dir = url.searchParams.get("dir") ?? state.dir
        if (!dir) return json({ ratings: {}, readOnly: true })
        return json(await readRatings(join(patchRoot(dir), engine)))
      }
      case "PUT /api/ratings": { // one patch: {engine, dir?, name, stars 0..5}, 0 clears. Only the sidecar is written, never the .patch
        const engine = engineOf(body.engine)
        const dir = typeof body.dir === "string" && body.dir ? body.dir : state.dir
        if (!dir) throw new HttpError(400, "no patch folder set")
        try {
          return json({ ratings: await writeRating(join(patchRoot(dir), engine), safeName(body.name), body.stars) })
        } catch (e) {
          if (e instanceof RatingError) throw new HttpError(e.status, e.message)
          throw e
        }
      }
      case "POST /api/describe":
        return json(await host.request({ cmd: "describe", engine: engineOf(body.engine), patch: body.patch, macroValues: body.macroValues }))
      case "POST /api/knob":
        return json(await host.request({ cmd: "knob", engine: engineOf(body.engine), param: body.param, knob: body.knob, patch: body.patch }))
      case "POST /api/typed": { // a value typed into a readout -> the stored value (server/typed.ts)
        const engine = engineOf(body.engine)
        const meta = (await engineMeta(engine)) as { params: any[] }
        const p = meta.params[Number(body.param)]
        if (!p) throw new HttpError(400, "param out of range")
        if (typeof body.text !== "string" || body.text.length > 64) throw new HttpError(400, "text must be a short string")
        const r = await resolveTyped(host, engine, p, body.text, body.patch).catch((e) => ({ ok: false as const, error: String(e?.message ?? e) }))
        if (!r.ok) throw new HttpError(422, r.error)
        return json(r)
      }
      case "POST /api/nudge": { // one arrow key on a continuous slider: the nearest knob position whose readout differs (server/typed.ts)
        const engine = engineOf(body.engine)
        const meta = (await engineMeta(engine)) as { params: any[] }
        const p = meta.params[Number(body.param)]
        if (!p || p.names) throw new HttpError(400, "param out of range")
        if (!Number.isInteger(body.pos) || body.pos < 0 || body.pos > 65535 || (body.dir !== 1 && body.dir !== -1)) throw new HttpError(400, "pos must be 0..65535 and dir 1 or -1")
        if (body.text !== undefined && (typeof body.text !== "string" || body.text.length > 64)) throw new HttpError(400, "text must be a short string")
        return json({ step: await nudgeText(host, engine, p, body.pos, body.dir, body.text, body.patch) })
      }
      case "POST /api/knobs":
        return json(await host.request({ cmd: "knobs", engine: engineOf(body.engine), items: body.items, patch: body.patch }))
      case "POST /api/encode": // the patch as .patch bytes (hex), for the recipe's short base hash
        return json(await host.request({ cmd: "encode", patch: body.patch }))
      case "POST /api/load": {
        const engine = engineOf(body.engine)
        const dir = typeof body.dir === "string" && body.dir ? body.dir : state.dir
        // bundled: true opens a patch of the default set (public/defaults), the list the page shows while no folder is set
        let path: string | null
        if (body.bundled === true) {
          path = defaultPatchPath(engine, safeName(body.name))
          if (!path) throw new HttpError(404, "no such bundled patch")
        } else {
          if (!dir) throw new HttpError(400, "no patch folder set")
          path = join(patchRoot(dir), engine, safeName(body.name) + ".patch")
        }
        try {
          return json(await host.request({ cmd: "load", path, engine }))
        } catch (e) {
          // a file of an engine this build does not have (a Pluck patch in the ACD folder): say so without naming it
          const other = release && e instanceof HostError ? /file is a (\S+) patch/.exec(e.message)?.[1] : undefined
          if (other && !served.includes(other)) throw new HttpError(422, "this patch file is for an engine that is not available here")
          throw e
        }
      }
      case "POST /api/save": {
        const engine = engineOf(body.patch?.engine)
        const dir = typeof body.dir === "string" && body.dir ? body.dir : state.dir
        if (!dir) throw new HttpError(400, "no patch folder set")
        const path = join(patchRoot(dir), engine, safeName(body.name) + ".patch")
        if (!body.overwrite && (await stat(path).then(() => true, () => false))) throw new HttpError(409, "exists")
        return json(await host.request({ cmd: "save", path, patch: body.patch }))
      }
      case "POST /api/render": {
        const tmp = await mkdtemp(join(tmpdir(), "poly-editor-"))
        try {
          const out = join(tmp, "note.wav")
          const r = await host.request({ cmd: "render", engine: engineOf(body.engine), patch: body.patch, macroValues: body.macroValues, note: body.note, velocity: body.velocity, seconds: body.seconds, hold: body.hold, voices: body.voices, strict: strictOf(body.strict), ...(body.float === true ? { float: true } : {}), out })
          return new Response(await readFile(out), { headers: { "content-type": "audio/wav", "x-render-peak": String(r.peak), "x-render-rms": String(r.rms), "cache-control": "no-store" } })
        } finally {
          await rm(tmp, { recursive: true, force: true })
        }
      }
      default:
        if (url.pathname.startsWith("/api/meta/") && req.method === "GET") {
          const engine = engineOf(url.pathname.slice("/api/meta/".length))
          return json(await engineMeta(engine))
        }
        throw new HttpError(404, "no such endpoint")
    }
  }

  const server = Bun.serve<{ live: true }>({
    port: opts.port ?? Number(process.env.PORT ?? 3210),
    hostname: opts.hostname ?? "127.0.0.1",
    websocket: {
      maxPayloadLength: 256 * 1024,
      open(ws) {
        ws.subscribe("live")
        liveClients++
        if (!live || live.exited) live = new LiveSession(opts.binary, (frame) => server.publish("live", frame), host.wasm)
      },
      message(ws, message) {
        try {
          if (typeof message !== "string") return
          const req = JSON.parse(message)
          if (!req || !LIVE_COMMANDS.includes(req.cmd)) throw new Error("bad live command")
          if (req.cmd === "live.open") engineOf(req.engine ?? req.patch?.engine)
          if (release && (req.cmd === "live.open" || req.cmd === "live.voices")) req.strict = true
          live?.send(JSON.stringify(req))
        } catch (e) {
          ws.send(JSON.stringify({ ok: false, error: String((e as Error).message ?? e) }))
        }
      },
      close(ws) {
        ws.unsubscribe("live")
        if (--liveClients <= 0) {
          liveClients = 0
          stopLive()
        }
      },
    },
    async fetch(req, srv) {
      const url = new URL(req.url)
      try {
        // Local tool that writes files: refuse requests that did not come from its own page (DNS rebinding, other sites)
        const hostHeader = (req.headers.get("host") ?? "").replace(/:\d+$/, "")
        if (!["127.0.0.1", "localhost", "[::1]", ...allowedHosts].includes(hostHeader)) throw new HttpError(403, "bad Host header")
        const origin = req.headers.get("origin")
        if (origin && new URL(origin).host !== req.headers.get("host")) throw new HttpError(403, "cross-origin request refused")

        if (url.pathname === "/api/live") {
          if (!srv.upgrade(req, { data: { live: true } })) throw new HttpError(426, "WebSocket upgrade required")
          return undefined as unknown as Response
        }
        if (url.pathname.startsWith("/api/")) {
          if ((req.method === "POST" || req.method === "PUT") && !(req.headers.get("content-type") ?? "").startsWith("application/json")) throw new HttpError(415, "content-type must be application/json")
          return await handleApi(req, url)
        }
        if (req.method !== "GET") throw new HttpError(405, "method not allowed")
        const mod = moduleRoute(url.pathname)
        if (mod) return mod
        if (url.pathname.startsWith("/defaults/")) return await defaultsFile(url.pathname)
        const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1)
        if (file.includes("..") || file.includes("/")) throw new HttpError(404, "not found")
        const f = Bun.file(join(publicDir, file))
        if (!(await f.exists())) throw new HttpError(404, "not found")
        if (release && file === "index.html") {
          indexHtml ??= (await f.text()).replace(/<!--strict-->[\s\S]*?<!--\/strict-->\s*/, "")
          return new Response(indexHtml, { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" } })
        }
        return new Response(f, { headers: { "cache-control": "no-store" } })
      } catch (e) {
        if (e instanceof HttpError) return json({ ok: false, error: e.message }, e.status)
        if (e instanceof HostError) return json({ ok: false, error: e.message }, 422)
        console.error(e)
        return json({ ok: false, error: String((e as Error).message ?? e) }, 500)
      }
    },
  })

  return {
    server,
    host,
    get liveRunning() {
      return live !== null && !live.exited
    },
    release,
    url: `http://${server.hostname}:${server.port}`,
    stop() {
      server.stop(true)
      stopLive()
      host.close()
    },
  }
}

if (import.meta.main) {
  const s = await startServer()
  const missing = firmware.private.engines.filter((e) => !s.host.privateEngines.includes(e))
  if (missing.length) console.log(`${missing.join(" and ")} not available: their runtime modules are not installed here (bun run build:wasm, then bun run modules)`)
  console.log(`FF SYNTH EDITOR at ${s.url}${s.release ? "  (release mode: Strict only, firmware engines only)" : ""}  (Ctrl-C to stop)`)
  const quit = () => {
    s.stop()
    process.exit(0)
  }
  process.on("SIGINT", quit)
  process.on("SIGTERM", quit)
}
