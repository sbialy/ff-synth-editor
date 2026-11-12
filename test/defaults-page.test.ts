// The page with no patch folder: the bundled default patches are listed, there is no star control at all, /api/ratings is never called, and a real
// folder brings the normal list and the stars back. Headless Chrome like test/page.test.ts, skipped when Chrome is not installed (CHROME points at it).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readManifest } from "../server/defaults"
import { startServer } from "../server/index"
import { Cdp } from "./cdp"
import { ensureBuilt } from "./helpers"

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
// log every fetch URL the page makes, from before its own scripts run
const LOG_FETCH = `(() => { window.__calls = []; const f = window.fetch; window.fetch = (u, o) => { window.__calls.push(String(typeof u === "string" ? u : u.url)); return f(u, o) } })()`

describe.skipIf(!existsSync(CHROME))("page without a patch folder", () => {
  let srv: Awaited<ReturnType<typeof startServer>>
  let dir: string, profile: string, chrome: ReturnType<typeof Bun.spawn>, cdp: Cdp, session: string
  const m = readManifest()
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const evaluate = async (expr: string) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, session)
    if (r.exceptionDetails) throw new Error("page error: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
    return r.result.value
  }
  const until = async (expr: string, what: string, ms = 10000) => {
    const t0 = Date.now()
    for (;;) {
      if (await evaluate(expr).catch(() => false)) return
      if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + what + ", status: " + (await evaluate("document.getElementById('status').textContent").catch(() => "?")))
      await sleep(50)
    }
  }
  const options = () => evaluate(`[...document.querySelectorAll('#patches option')].map((o) => o.value)`)
  const calls = () => evaluate(`window.__calls`) as Promise<string[]>

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "poly-editor-defpage-"))
    profile = mkdtempSync(join(tmpdir(), "poly-editor-chrome-"))
    await ensureBuilt()
    srv = await startServer({ port: 0, dir: "" })
    const meta = await (await fetch(srv.url + "/api/meta/ACD")).json()
    const save = await fetch(srv.url + "/api/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir, name: "Mine", patch: meta.init }) })
    expect(save.status).toBe(200)
    chrome = Bun.spawn([CHROME, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--mute-audio", "about:blank"], { stdout: "ignore", stderr: "ignore" })
    let port = ""
    for (let i = 0; i < 100 && !port; i++) { await sleep(100); try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0] } catch {} }
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    cdp = await Cdp.open(version.webSocketDebuggerUrl)
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" })
    session = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId
    await cdp.send("Page.enable", {}, session)
    await cdp.send("Runtime.enable", {}, session)
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: LOG_FETCH }, session)
    await cdp.send("Page.navigate", { url: srv.url + "/" }, session)
    await until(`document.querySelectorAll('#patches option').length > 0 && document.getElementById('patches').options[0].value !== ''`, "the default patch list")
  }, 120_000)

  afterAll(async () => {
    try { await Promise.race([cdp?.send("Browser.close"), sleep(1500)]) } catch {}
    try { cdp?.close() } catch {}
    await Promise.race([chrome?.exited, sleep(3000)])
    chrome?.kill()
    Bun.spawnSync(["pkill", "-f", profile])
    srv?.stop()
    rmSync(dir, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
  })

  test("the list is the bundled set of the engine, from the manifest", async () => {
    expect(await evaluate(`document.getElementById('dir').value`)).toBe("")
    expect(await options()).toEqual(m.engines.ACD)
    expect(await calls()).toContain("defaults/index.json")
  })

  test("no star control at all: hidden, and the list entries and tools carry no stars", async () => {
    expect(await evaluate(`document.getElementById('stars').hidden`)).toBe(true)
    expect(await evaluate(`getComputedStyle(document.getElementById('stars')).display`)).toBe("none")
    await evaluate(`document.getElementById('patchsearch').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
    await until(`!document.getElementById('patchlist').hidden`, "the list to open")
    expect(await evaluate(`document.querySelectorAll('#patchlist li[data-name]').length`)).toBe(m.engines.ACD.length)
    expect(await evaluate(`document.querySelectorAll('#patchlist .rs, #patchlist .tools, #patchlist .rmin').length`)).toBe(0)
    await evaluate(`document.getElementById('patchsearch').blur()`)
  })

  test("a default patch loads, and /api/ratings was never called", async () => {
    const name = m.engines.ACD[0]
    await evaluate(`(() => { const s = document.getElementById('patches'); s.value = ${JSON.stringify(name)}; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await until(`document.getElementById('name').value === ${JSON.stringify(name)}`, name + " to load")
    expect(await evaluate(`document.getElementById('status').textContent`)).toContain("Loaded " + name)
    expect(await evaluate(`document.getElementById('stars').hidden`)).toBe(true)
    expect((await calls()).filter((u) => u.includes("/api/ratings"))).toEqual([])
  })

  test("another engine lists its own defaults", async () => {
    const other = Object.keys(m.engines).find((e) => e !== "ACD")!
    await evaluate(`document.querySelector('#engines button[data-engine="${other}"]').click()`)
    await until(`document.getElementById('engname').textContent !== '' && document.querySelector('#engines button.on').dataset.engine === '${other}'`, other + " selected")
    await until(`[...document.querySelectorAll('#patches option')].map((o) => o.value).join('|') === ${JSON.stringify(m.engines[other].join("|"))}`, other + " defaults")
    expect((await calls()).filter((u) => u.includes("/api/ratings"))).toEqual([])
  })

  test("setting a real folder brings the normal list and the stars back, clearing it goes back to the defaults", async () => {
    await evaluate(`document.querySelector('#engines button[data-engine="ACD"]').click()`)
    await until(`document.querySelector('#engines button.on').dataset.engine === 'ACD'`, "ACD")
    await evaluate(`(() => { document.getElementById('dir').value = ${JSON.stringify(dir)}; document.getElementById('setdir').click() })()`)
    await until(`[...document.querySelectorAll('#patches option')].map((o) => o.value).join('|') === 'Mine'`, "the folder list")
    expect((await calls()).some((u) => u.includes("/api/ratings"))).toBe(true)
    await evaluate(`(() => { const s = document.getElementById('patches'); s.value = 'Mine'; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await until(`document.getElementById('name').value === 'Mine'`, "Mine to load")
    expect(await evaluate(`document.getElementById('stars').hidden`)).toBe(false)
    await until(`!document.querySelector('#stars button').disabled`, "the stars to be usable")
    await evaluate(`(() => { document.getElementById('dir').value = ''; document.getElementById('setdir').click() })()`)
    await until(`[...document.querySelectorAll('#patches option')].map((o) => o.value).join('|') === ${JSON.stringify(m.engines.ACD.join("|"))}`, "the defaults again")
    expect(await evaluate(`document.getElementById('stars').hidden`)).toBe(true)
  })
})
