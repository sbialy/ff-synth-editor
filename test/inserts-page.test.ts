// The Master inserts section of the main page in headless Chrome (Chrome DevTools Protocol, no extra dependency): the three columns of the device's
// Inserts page (Mixer, Insert 1, Insert 2), the parameters from the module descriptors, live audio through the worklet chain (the played output is
// non-silent and changes when an insert is picked), the stored choice after a reload, a module that is not installed (shown as missing, no crash) and
// the per-note render through the same chain. Needs Chrome, emscripten and the module sets: skipped without them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startServer } from "../server/index"
import { ensureBuilt } from "./helpers"
import { EMSDK, buildWasm } from "../scripts/build-wasm"
import { fetchModules, fromDir, lock, setDir } from "../scripts/modules"
import { useTempModules } from "./temp-modules"

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const ready = existsSync(CHROME) && existsSync(join(EMSDK, "upstream/emscripten/em++")) && existsSync(fromDir(lock.sets["effects-os"]!)) && existsSync(fromDir(lock.sets["engines-os"]!)) // the private inserts only where their set is installed
let havePrivate = false // set once the modules are installed: whether the private inserts (Console, Tube) are really in the temp modules directory

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

// the effects set (Console, Tube: private) left out of the module index, as a build without the private modules would have it
const HIDE_EFFECTS = `(() => {
  const real = window.fetch
  window.fetch = async (u, o) => {
    const r = await real(u, o)
    if (String(u).endsWith("/modules/index.json") && localStorage.getItem("test.hideEffects") === "1") {
      const j = await r.json()
      j.modules = j.modules.filter((m) => m.set !== "effects")
      return new Response(JSON.stringify(j), { headers: { "content-type": "application/json" } })
    }
    return r
  }
})()`

describe.skipIf(!ready)("Master inserts on the main page in headless Chrome", () => {
  let srv: Awaited<ReturnType<typeof startServer>>
  let dir: string, profile: string
  let chrome: ReturnType<typeof Bun.spawn>
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
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}, status: ${await evaluate("document.getElementById('status').textContent").catch(() => "?")}, inserts: ${await evaluate("JSON.stringify([window.__inserts?.problems, window.__inserts?.live, window.__inserts?.heard])").catch(() => "?")}`)
      await sleep(50)
    }
  }
  const load = async () => {
    await cdp.send("Page.navigate", { url: srv.url + "/" }, session)
    await until("document.querySelectorAll('#engines button').length > 3 && !!window.__inserts && document.querySelectorAll('#inscol-0 .inssel option').length > 1 || (window.__inserts && window.__inserts.problems.length > 0)", "the page and the insert modules")
  }
  const pick = (slot: number, name: string) => evaluate(`(() => { const s = document.querySelector('#inscol-${slot} .inssel'); s.value = ${JSON.stringify(name)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value })()`)
  const setParam = (slot: number, index: number, value: number) =>
    evaluate(`(() => { const e = document.querySelector('#inscol-${slot} [data-index="${index}"]'); e.value = ${value}; e.dispatchEvent(new Event('input', { bubbles: true })); return e.value })()`)
  const mixer = (i: number) => evaluate(`(() => { const s = document.getElementById('insmixer'); s.value = '${i}'; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value })()`)
  /** the mean played rms over a window of the worklet's own stats (one per ~85 ms) */
  const listen = async (ms: number) => {
    const seen = new Set<number>(), vals: number[] = []
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const h = await evaluate("window.__inserts.heard")
      if (h && !seen.has(h.rms + h.peak)) { seen.add(h.rms + h.peak); vals.push(h.rms) }
      await sleep(40)
    }
    return vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length)
  }
  const optionNames = (slot: number): Promise<string[]> => evaluate(`[...document.querySelectorAll('#inscol-${slot} .inssel option')].map((o) => o.textContent)`)

  let restoreModules = () => {}
  beforeAll(async () => {
    restoreModules = useTempModules() // the modules are installed in a temp directory, build/modules stays as it is
    await buildWasm("runtime")
    fetchModules(true, { optional: true, downloadIfStale: true })
    havePrivate = existsSync(join(setDir("effects"), "console.wasm")) && existsSync(join(setDir("effects"), "tube.wasm"))
    dir = mkdtempSync(join(tmpdir(), "poly-editor-insp-"))
    profile = mkdtempSync(join(tmpdir(), "poly-editor-chrome-insp-"))
    await ensureBuilt()
    srv = await startServer({ port: 0, dir })
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
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HIDE_EFFECTS }, session)
    await load()
  }, 600_000)

  afterAll(async () => {
    try { await Promise.race([cdp?.send("Browser.close"), sleep(1500)]) } catch {}
    try { cdp?.close() } catch {}
    await Promise.race([chrome?.exited, sleep(3000)])
    chrome?.kill()
    Bun.spawnSync(["pkill", "-f", profile])
    srv?.stop()
    for (const d of [dir, profile]) if (d) rmSync(d, { recursive: true, force: true })
    restoreModules()
  })

  test("the section lists the device's columns in order, the Mixer types and the installed modules. A module's parameters come from its descriptor", async () => {
    expect(await evaluate("[...document.querySelectorAll('#inserts .inscol h3')].map((h) => h.textContent)")).toEqual(["Mixer", "Insert 1", "Insert 2"])
    expect(await evaluate("[...document.querySelectorAll('#insmixer option')].map((o) => o.textContent)")).toEqual(["Hard Clip", "Soft Clip", "Soft Knee"])
    expect(await evaluate("document.getElementById('insmixer').value")).toBe("0")
    for (const slot of [0, 1]) {
      const names = await optionNames(slot)
      expect(names[0]).toBe("Empty")
      for (const n of ["Dirt", "Tape", "Lo-Fi", "BBD", "Phaser"]) expect(names).toContain(n)
      expect(await evaluate(`document.querySelector('#inscol-${slot} .inssel').value`)).toBe("")
    }
    // the private inserts are offered where their set is installed, and only there
    if (havePrivate) expect(await optionNames(0)).toEqual(expect.arrayContaining(["Console", "Tube"]))
    else for (const n of ["Console", "Tube"]) expect(await optionNames(0)).not.toContain(n)
    await pick(0, "Dirt")
    // names, ranges, units and enum labels as the manifest lists them
    expect(await evaluate("[...document.querySelectorAll('#inscol-0 .ip .pname')].map((n) => n.textContent)")).toEqual(["Type", "Drive", "Bits", "Rate", "Tone", "Mix"])
    expect(await evaluate("[...document.querySelectorAll('#inscol-0 .ip select option')].map((o) => o.textContent)")).toEqual(["Soft", "Hard", "Fold", "Asym"])
    expect(await evaluate("(() => { const e = document.querySelector('#inscol-0 [data-index=\"2\"]'); return [e.min, e.max, e.step, e.value] })()")).toEqual(["4", "16", "1", "16"])
    expect(await evaluate("document.querySelectorAll('#inscol-0 .ip')[1].querySelector('.val').textContent")).toBe("35 %")
    await setParam(0, 1, 70)
    expect(await evaluate("document.querySelectorAll('#inscol-0 .ip')[1].querySelector('.val').textContent")).toBe("70 %")
    expect(await evaluate("JSON.stringify(window.__inserts.state.slots[0])")).toBe(JSON.stringify({ name: "Dirt", values: [0, 70, 16, 1, 100, 100] }))
    await pick(0, "")
    expect(await evaluate("window.__inserts.state.slots[0].name")).toBe(null)
    expect(await evaluate("document.querySelectorAll('#inscol-0 .ip').length")).toBe(0)
  }, 60_000)

  /** A fresh note every time (the same envelope): key down, the played rms of the 120..620 ms after it, key up and let it ring out. */
  const note = async () => {
    await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })), true")
    await sleep(120)
    const rms = await listen(500)
    await evaluate("window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a' })), true")
    await sleep(700)
    return rms
  }
  test("live audio through the chain: the played output is non-silent and changes when inserts are picked and comes back with Empty", async () => {
    await evaluate("document.getElementById('livebtn').click(), true")
    await until("window.__inserts.live === true", "the chain in the worklet")
    await until("window.__inserts.heard", "the first stats of the worklet")
    const dry = await note()
    const dry2 = await note()
    console.log(`played rms: dry ${dry.toFixed(4)} and again ${dry2.toFixed(4)}`)
    expect(dry).toBeGreaterThan(0.01)
    expect(Math.abs(dry2 - dry) / dry).toBeLessThan(0.15) // the same note twice: the comparisons below are not envelope noise
    await pick(0, "Dirt")
    await setParam(0, 0, 1)   // Type Hard
    await setParam(0, 1, 100) // Drive 100 %
    await sleep(300)
    const dirt = await note()
    console.log(`played rms: Dirt hard drive 100 ${dirt.toFixed(4)}`)
    expect(dirt).toBeGreaterThan(0.01)
    expect(Math.abs(dirt - dry) / dry).toBeGreaterThan(0.1)
    const second = await evaluate("[...document.querySelectorAll('#inscol-1 .inssel option')].map((o) => o.textContent).find((n) => ['Console', 'Tube', 'Tape'].includes(n))")
    await pick(1, second)
    await sleep(300)
    const both = await note()
    console.log(`played rms: Dirt then ${second} ${both.toFixed(4)}`)
    expect(both).toBeGreaterThan(0.01)
    expect(Math.abs(both - dirt) / dirt).toBeGreaterThan(0.01)
    await mixer(2)
    expect(await evaluate("window.__inserts.state.mixer")).toBe(2)
    await sleep(300)
    expect(await note()).toBeGreaterThan(0.01) // still sounding with Soft Knee in front of the inserts
    await mixer(0)
    await pick(0, ""); await pick(1, "")
    await sleep(300)
    const back = await note()
    console.log(`played rms: both empty again ${back.toFixed(4)}`)
    expect(Math.abs(back - dry) / dry).toBeLessThan(0.15) // both empty and Hard Clip: the engine as it was
    await evaluate("document.getElementById('livebtn').click(), true")
    await until("document.getElementById('livebtn').textContent === 'Live audio: off'", "live audio off")
  }, 120_000)

  test("the choice is stored with the editor state and comes back after a reload, parameters included", async () => {
    await pick(0, "Phaser")
    await setParam(0, 1, 77)
    await pick(1, "Tape")
    await setParam(1, 0, 55)
    await mixer(1)
    const stored = await evaluate("localStorage.getItem('poly-editor.inserts')")
    expect(JSON.parse(stored)).toMatchObject({ mixer: 1, slots: [{ name: "Phaser", values: [0, 77, 80, 30, 25, 50] }, { name: "Tape", values: [55, 20, 10, 100] }] })
    await load()
    expect(await evaluate("[document.getElementById('insmixer').value, document.querySelector('#inscol-0 .inssel').value, document.querySelector('#inscol-1 .inssel').value]")).toEqual(["1", "Phaser", "Tape"])
    expect(await evaluate("document.querySelector('#inscol-0 [data-index=\"1\"]').value")).toBe("77")
    expect(await evaluate("document.querySelector('#inscol-1 [data-index=\"0\"]').value")).toBe("55")
    expect(await evaluate("document.querySelector('#inscol-0 .ip select').value")).toBe("0") // Phaser Mode, an enum
  }, 60_000)

  test("per-note render (live audio off): through the chain as a stereo float buffer when an insert or a Mixer type is set, the plain render otherwise", async () => {
    expect(await evaluate("document.getElementById('livebtn').textContent")).toBe("Live audio: off")
    await evaluate("document.getElementById('playbtn').click(), true")
    await until("window.__inserts.lastRender && window.__inserts.lastRender.chained === true", "the chained render")
    const r = await evaluate("window.__inserts.lastRender")
    expect(r.channels).toBe(2)
    expect(r.rate).toBeGreaterThan(40000)
    expect(r.peak).toBeGreaterThan(0.01)
    // both slots empty, Hard Clip and the limiter switched off for an A/B (it is on at every load): the render is the plain mono one
    await pick(0, ""); await pick(1, ""); await mixer(0)
    expect(await evaluate("window.__inserts.state.fx.limiter.on")).toBe(1)
    await evaluate("(() => { const c = document.querySelector('[data-fx=\"limiter.on\"]'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })) })(), true")
    await evaluate("window.__inserts.lastRender = null, document.getElementById('playbtn').click(), true")
    await until("window.__inserts.lastRender && window.__inserts.lastRender.chained === false", "the plain render")
    expect(await evaluate("window.__inserts.lastRender.channels")).toBe(1)
    expect(await evaluate("document.getElementById('status').className")).not.toBe("err")
    await evaluate("(() => { const c = document.querySelector('[data-fx=\"limiter.on\"]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })) })(), true")
  }, 60_000)

  test("a module that is not installed (a private set left out) is shown as missing, the choice is kept, nothing crashes and the installed one beside it works", async () => {
    await evaluate(`localStorage.setItem('poly-editor.inserts', ${JSON.stringify(JSON.stringify({ mixer: 2, slots: [{ name: "Console", values: [80, 30, 0, 100] }, { name: "Tube", values: [] }] }))}), localStorage.setItem('test.hideEffects', '1'), true`)
    await load()
    expect(await optionNames(0)).not.toContain("Console")
    expect(await optionNames(0)).toEqual(expect.arrayContaining(["Dirt", "Tape", "Phaser"]))
    expect(await evaluate("document.querySelector('#inscol-0 .inssel').value")).toBe("Console")
    expect(await optionNames(0)).toContain("Console (not installed)")
    expect(await evaluate("document.querySelector('#inscol-0').classList.contains('missing')")).toBe(true)
    expect(await evaluate("document.querySelector('#inscol-0 .insparams').textContent")).toContain("not installed")
    expect(await evaluate("document.getElementById('insnote').textContent")).toContain("not installed")
    expect(await evaluate("document.getElementById('status').className")).not.toBe("err")
    expect(await evaluate("document.getElementById('insmixer').value")).toBe("2")
    // the choice survives the load and a change next to it
    await pick(1, "Dirt")
    const kept = JSON.parse(await evaluate("localStorage.getItem('poly-editor.inserts')"))
    expect(kept.slots[0]).toEqual({ name: "Console", values: [80, 30, 0, 100] })
    expect(kept.slots[1].name).toBe("Dirt")
    // audio: a missing module plays empty, the installed one beside it is in the chain, live audio still works
    await evaluate("document.getElementById('livebtn').click(), true")
    await until("window.__inserts.live === true", "the chain in the worklet")
    await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })), true")
    await until("window.__inserts.heard && window.__inserts.heard.rms > 0.002", "sound with a missing module in insert 1")
    await evaluate("window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a' })), true")
    await evaluate("document.getElementById('livebtn').click(), true")
    // the set is back (or was never needed): where the module is installed the same stored choice is a live slot again
    await evaluate("localStorage.removeItem('test.hideEffects'), true")
    await load()
    expect(await evaluate("document.querySelector('#inscol-0 .inssel').value")).toBe("Console")
    expect(await evaluate("document.querySelector('#inscol-0').classList.contains('missing')")).toBe(!havePrivate)
    if (havePrivate) expect(await evaluate("document.querySelector('#inscol-0 [data-index=\"0\"]').value")).toBe("80")
    await evaluate("localStorage.removeItem('poly-editor.inserts'), true")
  }, 120_000)
})
