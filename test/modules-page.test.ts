// The runtime module page (public/modules.html) in headless Chrome: the three module sets (public, engines, effects) are verified in the page,
// the wasm host runs in the AudioWorklet with PHZ, PLK and JU6 loaded at run time, notes sound, and the two insert slots take Dirt (public),
// Console and Tube (private) with their parameters. Served by a plain static
// server with the module routes of server/modules-routes.ts (the page needs no poly_host process).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { moduleRoute } from "../server/modules-routes"
import { EMSDK, buildWasm } from "../scripts/build-wasm"
import { fetchModules, fromDir, lock } from "../scripts/modules"
import { useTempModules } from "./temp-modules"

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const ready = existsSync(CHROME) && existsSync(join(EMSDK, "upstream/emscripten/em++")) &&
  Object.values(lock.sets).every((s) => existsSync(fromDir(s)))
const publicDir = join(import.meta.dir, "../public")

class Cdp {
  private id = 0
  private waiting = new Map<number, (v: any) => void>()
  constructor(private ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data))
      if (m.id && this.waiting.has(m.id)) { this.waiting.get(m.id)!(m); this.waiting.delete(m.id) }
    }
  }
  static async open(url: string) {
    const ws = new WebSocket(url)
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("cdp connect")) })
    return new Cdp(ws)
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.waiting.set(id, (m) => (m.error ? rej(new Error(method + ": " + m.error.message)) : res(m.result)))
      this.ws.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }
  close() { this.ws.close() }
}

describe.skipIf(!ready)("runtime module page in headless Chrome", () => {
  let srv: ReturnType<typeof Bun.serve>
  let chrome: ReturnType<typeof Bun.spawn>
  let profile: string
  let cdp: Cdp, session: string
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const evaluate = async (expr: string) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, session)
    if (r.exceptionDetails) throw new Error("page error: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
    return r.result.value
  }
  const until = async (expr: string, what: string, ms = 15000) => {
    const t0 = Date.now()
    for (;;) {
      const v = await evaluate(expr).catch(() => false)
      if (v) return v
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}, status: ${await evaluate("document.getElementById('status').textContent").catch(() => "?")}`)
      await sleep(50)
    }
  }
  const pickInsert = (slot: number, name: string) =>
    evaluate(`(() => { const s = document.querySelectorAll('.slot .ins')[${slot}]; s.value = ${JSON.stringify(name)}; s.dispatchEvent(new Event('change')); return true })()`)

  let restoreModules = () => {}
  beforeAll(async () => {
    restoreModules = useTempModules() // the modules are installed in a temp directory, build/modules stays as it is
    await buildWasm("runtime")
    fetchModules(true)
    srv = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url)
        const mod = moduleRoute(url.pathname)
        if (mod) return mod
        const file = url.pathname.slice(1)
        if (!file || file.includes("..") || file.includes("/")) return new Response("not found", { status: 404 })
        const f = Bun.file(join(publicDir, file))
        return (await f.exists()) ? new Response(f) : new Response("not found", { status: 404 })
      },
    })
    profile = mkdtempSync(join(tmpdir(), "poly-editor-chrome-mod-"))
    chrome = Bun.spawn([CHROME, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
      "--autoplay-policy=no-user-gesture-required", "--mute-audio", "about:blank"], { stdout: "ignore", stderr: "ignore" })
    let port = ""
    for (let i = 0; i < 200 && !port; i++) {
      try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0] } catch {}
      if (!port) await sleep(50)
    }
    const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    cdp = await Cdp.open(ver.webSocketDebuggerUrl)
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" })
    session = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId
    await cdp.send("Page.enable", {}, session)
    await cdp.send("Runtime.enable", {}, session)
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${srv.port}/modules.html` }, session)
  }, 600_000)

  afterAll(() => {
    cdp?.close()
    chrome?.kill()
    srv?.stop(true)
    if (profile) { Bun.spawnSync(["pkill", "-f", profile]); rmSync(profile, { recursive: true, force: true }) }
    restoreModules()
  })

  test("the page verifies all four sets, plays PHZ, PLK and JU6 from their runtime modules in the worklet and runs Dirt, Console and Tube in insert 1 and 2", async () => {
    await until("document.getElementById('status').textContent.includes('module set verified')", "the module set")
    expect(await evaluate("document.querySelectorAll('#mods tr').length")).toBe(19)
    const rows: string = await evaluate("document.getElementById('mods').textContent")
    expect(rows).toContain("engines (private)")
    expect(rows).toContain("effects (private)")
    expect(rows).toContain("engines-os (public)")
    expect(rows).toContain("effects-os (public)")
    expect(await evaluate("document.querySelectorAll('#notices a').length")).toBe(4)
    await evaluate("document.getElementById('start').click(), true")
    await until("window.__modules.ready", "the worklet host")
    const engines: string[] = await evaluate("window.__modules.engines")
    for (const n of ["PHZ", "PLK", "JU6"]) expect(engines).toContain(n)
    const pick = async (name: string) => {
      await evaluate(`(() => { const e = document.getElementById('engine'); e.value = ${JSON.stringify(name)}; e.dispatchEvent(new Event('change')); return true })()`)
      await until(`window.__modules.answers.some((a) => a.ok && a.engine === ${JSON.stringify(name)})`, `live.open ${name}`)
    }
    const key = (down: boolean) => evaluate(`document.querySelector('#keys button[data-note="57"]').dispatchEvent(new PointerEvent('${down ? "pointerdown" : "pointerup"}')), true`)
    // each engine, from whichever repository, sounds
    for (const n of ["PLK", "JU6"]) {
      await pick(n)
      await key(true)
      await until("window.__modules.stats && window.__modules.stats.rms > 0.002", `${n} sound`)
      await key(false)
      await sleep(600)
    }
    await pick("PHZ")
    expect(await evaluate("document.getElementById('engine').value")).toBe("PHZ")
    await key(true)
    await until("window.__modules.stats && window.__modules.stats.rms > 0.01", "PHZ sound")
    const dry = await evaluate("window.__modules.stats.rms")

    await pickInsert(0, "Dirt")
    await until("window.__modules.slots[0] === 'Dirt'", "Dirt in insert 1")
    expect(await evaluate("document.querySelectorAll('.slot')[0].querySelectorAll('.pv').length")).toBe(6)
    expect(await evaluate("[...document.querySelectorAll('.slot')[0].querySelectorAll('.params > span:not(:empty)')].map((s) => s.textContent).filter((t) => /^[A-Z][a-z]+$/.test(t))"))
      .toEqual(["Type", "Drive", "Bits", "Rate", "Tone", "Mix"])
    // Drive 100 and Bits 4: a loud, crushed signal, the meter shows it
    await evaluate(`(() => { const p = document.querySelectorAll('.slot')[0].querySelectorAll('.pv'); p[1].value = 100; p[1].dispatchEvent(new Event('input')); p[2].value = 4; p[2].dispatchEvent(new Event('input')); return true })()`)
    await sleep(300)
    await until(`window.__modules.stats.rms > ${dry} * 1.3`, "Dirt driving the signal")
    // a private effect in the second slot after the public one
    await pickInsert(1, "Console")
    await until("window.__modules.slots[1] === 'Console'", "Console in insert 2")
    expect(await evaluate("document.querySelectorAll('.slot')[1].querySelectorAll('.pv').length")).toBe(4)
    await pickInsert(0, "Tube")
    await until("window.__modules.slots[0] === 'Tube'", "Tube in insert 1")
    expect(await evaluate("document.querySelectorAll('.slot')[0].querySelectorAll('.pv').length")).toBe(4)
    await evaluate("(() => { const b = document.querySelectorAll('.slot .byp'); b[0].click(); b[1].click(); return true })()")
    await sleep(300)
    await until(`Math.abs(window.__modules.stats.rms - ${dry}) < ${dry} * 0.25`, "both bypassed: back to the dry level")
    expect(await evaluate("document.getElementById('status').textContent")).not.toContain("error")
  }, 120_000)
})
