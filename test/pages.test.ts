// The static site (scripts/pages.ts) with no bun server: built into a temp directory under a project path (/ff-synth-editor/, as GitHub Pages serves a project
// site), served by python3 -m http.server, driven by headless Chrome. The page loads, lists the bundled default patches, plays ACD notes through the
// wasm host inside the AudioWorklet (non-silent), opens a .patch file from the disk and saves one as a download. Every request the page makes stays
// under the project path and none goes to /api. With a module set (POLY_PAGES_MODULES=dir as scripts/modules.ts --out fills it, else build/modules
// when it holds every set) PHZ plays too. Skipped when Chrome or python3 is missing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildPages, relativeUrls } from "../scripts/pages"
import { Cdp } from "./cdp"

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const PYTHON = Bun.which("python3")
const root = join(import.meta.dir, "..")
const lockSets = Object.keys(JSON.parse(readFileSync(join(root, "modules.lock.json"), "utf8")).sets)
const modulesDir = (() => {
  if (process.env.POLY_PAGES_MODULES) return process.env.POLY_PAGES_MODULES
  const d = join(root, "build/modules") // read only
  try { const idx = JSON.parse(readFileSync(join(d, "index.json"), "utf8")); return lockSets.every((s) => s in idx.sets) ? d : undefined } catch { return undefined }
})()
const SITE = "ff-synth-editor"

test("relativeUrls makes the page's root paths relative and leaves /api alone", () => {
  expect(relativeUrls(`import { a } from "/midi.js"\nfetch("/wasm/runtime/poly.wasm"); fetch(\`/modules/\${x}\`); api("GET", "/api/engines"); const s = "a/b.js"`))
    .toBe(`import { a } from "./midi.js"\nfetch("./wasm/runtime/poly.wasm"); fetch(\`./modules/\${x}\`); api("GET", "/api/engines"); const s = "a/b.js"`)
})

describe.skipIf(!existsSync(CHROME) || !PYTHON)("static site (no server)", () => {
  let dir: string, profile: string, chrome: ReturnType<typeof Bun.spawn>, http: ReturnType<typeof Bun.spawn>, cdp: Cdp, session: string, base: string
  const served: string[] = []
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const evaluate = async (expr: string) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, session)
    if (r.exceptionDetails) throw new Error("page error: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
    return r.result.value
  }
  const until = async (expr: string, what: string, ms = 20000) => {
    const t0 = Date.now()
    for (;;) {
      if (await evaluate(expr).catch(() => false)) return
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}, status: ${await evaluate("document.getElementById('status').textContent").catch(() => "?")}, heard: ${await evaluate("JSON.stringify(window.__inserts?.heard)").catch(() => "?")}`)
      await sleep(50)
    }
  }
  const status = () => evaluate("document.getElementById('status').textContent") as Promise<string>
  const key = (down: boolean) => evaluate(`document.querySelector('#keys .key').dispatchEvent(new PointerEvent('${down ? "pointerdown" : "pointerup"}', { bubbles: true })), true`)
  /** the loudest rms the worklet reports within ms (its stats come every 32 quanta) */
  const loudest = async (ms: number) => {
    let best = 0
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(40)) best = Math.max(best, (await evaluate("window.__inserts.heard?.rms ?? 0")) as number)
    return best
  }
  const openFile = async (path: string) => {
    const { result } = await cdp.send("Runtime.evaluate", { expression: "document.getElementById('openfile')" }, session)
    await cdp.send("DOM.setFileInputFiles", { files: [path], objectId: result.objectId }, session)
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "poly-editor-pages-"))
    profile = mkdtempSync(join(tmpdir(), "poly-editor-chrome-"))
    await buildPages(join(dir, SITE), { modules: modulesDir })
    http = Bun.spawn([PYTHON!, "-u", "-m", "http.server", "0", "--bind", "127.0.0.1", "--directory", dir], { stdout: "pipe", stderr: "pipe" })
    // the port from the first line, every request path from the log on stderr
    const out = http.stdout.getReader(), dec = new TextDecoder()
    let first = ""
    while (!/port (\d+)/.test(first)) { const { value, done } = await out.read(); if (done) throw new Error("http.server did not start"); first += dec.decode(value) }
    base = `http://127.0.0.1:${/port (\d+)/.exec(first)![1]}/${SITE}/`
    ;(async () => { const r = http.stderr.getReader(); for (;;) { const { value, done } = await r.read(); if (done) return; for (const m of dec.decode(value).matchAll(/"(?:GET|POST|PUT|HEAD) (\S+)/g)) served.push(m[1]) } })()
    chrome = Bun.spawn([CHROME, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
      "--autoplay-policy=no-user-gesture-required", "--mute-audio", "about:blank"], { stdout: "ignore", stderr: "ignore" })
    let port = ""
    for (let i = 0; i < 100 && !port; i++) { await sleep(100); try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0] } catch {} }
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    cdp = await Cdp.open(version.webSocketDebuggerUrl)
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" })
    session = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId
    await cdp.send("Page.enable", {}, session)
    await cdp.send("Runtime.enable", {}, session)
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false }, session)
    await cdp.send("Page.navigate", { url: base }, session)
    await until(`document.querySelectorAll('#engines button').length > 0 && document.getElementById('patches').options.length > 0 && document.getElementById('patches').options[0].value !== ''`, "the engines and the default patch list")
  }, 120_000)

  afterAll(async () => {
    try { await Promise.race([cdp?.send("Browser.close"), sleep(1500)]) } catch {}
    chrome?.kill(); http?.kill()
    rmSync(dir, { recursive: true, force: true }); rmSync(profile, { recursive: true, force: true })
  })

  test("the page loads in release mode: firmware engines, no Strict box, no folder, Open and Save file", async () => {
    const engines = (await evaluate(`[...document.querySelectorAll('#engines button')].map((b) => b.dataset.engine)`)) as string[]
    expect(engines).toContain("ACD")
    expect(engines).not.toContain("NOSUCHA")
    if (modulesDir) expect(engines).toEqual(expect.arrayContaining(["PHZ", "PLK", "JU6"]))
    else expect(engines).not.toContain("PHZ")
    expect(await evaluate("document.getElementById('strict')")).toBeNull()
    expect(await evaluate("document.getElementById('dir').closest('.grp').hidden")).toBe(true)
    expect(await evaluate("document.getElementById('open').textContent")).toBe("Open file")
    expect(await evaluate("document.getElementById('fwbadge').textContent")).toMatch(/^matches tracker-ff/)
    expect(await evaluate("document.querySelectorAll('#params input, #params .param, .param').length")).toBeGreaterThan(0)
  })

  test("an ACD note plays through the wasm host in the AudioWorklet", async () => {
    await evaluate(`document.querySelector('#engines button[data-engine="ACD"]').click(), true`)
    await until(`document.getElementById('engname').textContent === 'ACD'`, "ACD selected")
    await evaluate("document.getElementById('livebtn').click(), true")
    await until("document.getElementById('livebtn').textContent === 'Live audio: on' && window.__inserts.heard", "live audio on, first worklet stats")
    expect(await loudest(400)).toBeLessThan(0.0005) // nothing held: silence
    await key(true)
    const rms = await loudest(1500)
    await key(false)
    expect(await status()).not.toMatch(/fail|error/i)
    expect(rms).toBeGreaterThan(0.002)
    console.log(`static site: ACD live note rms ${rms.toFixed(4)} from the worklet`)
  }, 30_000)

  test.skipIf(!modulesDir)("PHZ (a private runtime module) plays in the worklet too", async () => {
    await evaluate(`document.querySelector('#engines button[data-engine="PHZ"]').click(), true`)
    await until(`document.querySelector('#engines button[data-engine="PHZ"]').classList.contains('on') && document.getElementById('status').textContent !== ''`, "PHZ selected")
    await sleep(300)
    await key(true)
    const rms = await loudest(1500)
    await key(false)
    expect(rms).toBeGreaterThan(0.002)
    console.log(`static site: PHZ live note rms ${rms.toFixed(4)}`)
  }, 30_000)

  test("a .patch file opens from the disk (switching the engine) and saves as a download, byte for byte", async () => {
    const file = join(root, "public/defaults/FAT", readdirFirst("FAT"))
    await openFile(file)
    await until(`document.getElementById('status').textContent.startsWith('Opened')`, "the file opened")
    expect(await evaluate("document.getElementById('engname').textContent")).toBe("FAT")
    await evaluate(`document.getElementById('name').value = 'Static Test', document.getElementById('save').click(), true`)
    await until("window.__lastDownload", "the download")
    const dl = await evaluate("window.__lastDownload") as { name: string; bytes: number[] }
    expect(dl.name).toBe("Static Test.patch")
    expect(Buffer.from(dl.bytes).equals(readFileSync(file))).toBe(true)
    expect(await status()).toMatch(/^Saved Static Test\.patch/)
  }, 30_000)

  test("Save cleans a name Windows would rewrite and says the name it really saved", async () => {
    await evaluate(`window.__lastDownload = null, document.getElementById('name').value = 'Lead: soft?', document.getElementById('save').click(), true`)
    await until("window.__lastDownload", "the download")
    expect(((await evaluate("window.__lastDownload")) as { name: string }).name).toBe("Lead_ soft_.patch")
    expect(await status()).toMatch(/^Saved Lead_ soft_\.patch/)
    expect(await evaluate("document.getElementById('name').value")).toBe("Lead_ soft_")
  }, 30_000)

  test("per-note render, typed values and randomize work without the server", async () => {
    if ((await evaluate("document.getElementById('livebtn').textContent")) === "Live audio: on") await evaluate("document.getElementById('livebtn').click(), true")
    await evaluate(`document.querySelector('#engines button[data-engine="ACD"]').click(), true`)
    await until(`document.getElementById('engname').textContent === 'ACD'`, "ACD selected")
    await evaluate("window.__inserts.lastRender = null, document.getElementById('playbtn').click(), true")
    await until("window.__inserts.lastRender", "the per-note render")
    expect((await evaluate("window.__inserts.lastRender.peak")) as number).toBeGreaterThan(0.01)
    const typed = await evaluate(`(async () => { const m = await import('./static-api.js'); const meta = await (await m.staticFetch('/api/meta/ACD')).json()
      const r = await m.staticFetch('/api/typed', { method: 'POST', body: JSON.stringify({ engine: 'ACD', param: 0, text: meta.params[0].names ? meta.params[0].names[1] : String(meta.params[0].max), patch: meta.init }) })
      return { status: r.status, body: await r.json() } })()`) as { status: number; body: any }
    expect(typed.status).toBe(200)
    expect(typed.body.ok).toBe(true)
    await evaluate("document.getElementById('randgo').click(), true")
    await until(`/^Randomized|Nothing to randomize/.test(document.getElementById('status').textContent)`, "a randomize roll")
  }, 30_000)

  test("a file of an engine this site lacks is refused with a message", async () => {
    const bogus = join(dir, "bogus.patch")
    await Bun.write(bogus, "not a patch")
    await openFile(bogus)
    await until(`document.getElementById('status').textContent.startsWith('Open of bogus.patch failed')`, "the refusal")
  })

  test("switching the engine clears the Save as name and an engine without bundled defaults gets a hint that fits a page with no folder", async () => {
    const engine = (JSON.parse(readFileSync(join(root, "public/defaults/index.json"), "utf8")).engines as Record<string, string[]>)
    const bare = ((await evaluate(`[...document.querySelectorAll('#engines button')].map((b) => b.dataset.engine)`)) as string[]).find((e) => !engine[e]?.length)!
    expect(bare).toBeDefined()
    await evaluate(`document.querySelector('#engines button[data-engine="ACD"]').click(), true`)
    await until(`document.getElementById('engname').textContent === 'ACD' && [...document.getElementById('patches').options].some((o) => o.value)`, "the ACD list")
    await evaluate(`document.getElementById('name').value = 'Carried Over', true`)
    await evaluate(`document.querySelector('#engines button[data-engine="${bare}"]').click(), true`)
    await until(`document.getElementById('engname').textContent === '${bare}' && document.getElementById('patches').options[0]?.value === ''`, `the ${bare} list`)
    expect(await evaluate("document.getElementById('name').value")).toBe("")
    const hint = (await evaluate("document.getElementById('patches').options[0].textContent")) as string
    expect(hint).toMatch(/Init or Open file/)
    expect(hint).not.toMatch(/folder/)
  }, 30_000)

  test("every request stayed under the project path and none went to /api", () => {
    expect(served.length).toBeGreaterThan(10)
    expect(served.filter((p) => !p.startsWith(`/${SITE}/`) && p !== "/favicon.ico")).toEqual([]) // the browser's own favicon probe is not the page's
    expect(served.filter((p) => p.includes("/api/"))).toEqual([])
  })
})

function readdirFirst(engine: string): string {
  const names = JSON.parse(readFileSync(join(root, "public/defaults/index.json"), "utf8")).engines[engine] as string[]
  return names[0] + ".patch"
}
