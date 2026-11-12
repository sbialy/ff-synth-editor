// Screenshots of the page in headless Chrome (Chrome DevTools Protocol, no dependency): bun scripts/screenshots.ts [outDir] [ENGINE...]
// Starts its own server on a free port with a temp patch folder, so the server on 3210 is not touched.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { startServer } from "../server/index"
import { ensureBuilt } from "../test/helpers"

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if (!existsSync(CHROME)) throw new Error("Chrome not found, set CHROME")
const out = resolve(process.argv[2] ?? "docs/screenshots")
const engines = process.argv.slice(3).length ? process.argv.slice(3) : ["ACD", "FM4"]
mkdirSync(out, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

await ensureBuilt()
const dir = mkdtempSync(join(tmpdir(), "pse-shot-")), profile = mkdtempSync(join(tmpdir(), "pse-chrome-"))
const srv = await startServer({ port: 0, dir })
const chrome = Bun.spawn([CHROME, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--mute-audio", "about:blank"], { stdout: "ignore", stderr: "ignore" })
let port = ""
for (let i = 0; i < 100 && !port; i++) { await sleep(100); try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0] } catch {} }
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
const ws = new WebSocket(version.webSocketDebuggerUrl)
await new Promise<void>((res) => { ws.onopen = () => res() })
let id = 0
const waiting = new Map<number, (m: any) => void>()
ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id) } }
const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((res, rej) => {
  const n = ++id; waiting.set(n, (m) => (m.error ? rej(new Error(method + ": " + m.error.message)) : res(m.result)))
  ws.send(JSON.stringify({ id: n, method, params, sessionId }))
})
try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" })
  const session = (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId
  const ev = async (expression: string) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session)).result.value
  await send("Page.enable", {}, session)
  await send("Runtime.enable", {}, session)
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, session)
  await send("Page.navigate", { url: srv.url + "/" }, session)
  for (const name of engines) {
    for (let i = 0; i < 100 && !(await ev(`!!document.querySelector('#engines button[data-engine=${name}]')`)); i++) await sleep(100)
    await ev(`document.querySelector('#engines button[data-engine=${name}]').click()`)
    for (let i = 0; i < 100 && !(await ev(`document.getElementById('status').textContent.startsWith(${JSON.stringify(((await ev(`document.querySelector('#engines button[data-engine=${name}] span').textContent`)) as string))})`)); i++) await sleep(100)
    await sleep(300)
    // a few rolls so the history panel and the faders show a lived-in patch
    for (const seed of ["11", "22", "33"]) { await ev(`(() => { document.getElementById('randseed').value = ${JSON.stringify(seed)}; document.getElementById('randgo').click() })()`); await sleep(500) }
    await ev(`document.getElementById('randseed').value = ''; document.activeElement?.blur(); window.scrollTo(0, 0)`)
    await sleep(300)
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, session)
    const path = join(out, `${name.toLowerCase()}.png`)
    writeFileSync(path, Buffer.from(shot.data, "base64")); console.log(path)
  }
} finally {
  try { await Promise.race([send("Browser.close"), sleep(1500)]) } catch {}
  ws.close(); await Promise.race([chrome.exited, sleep(3000)]); chrome.kill()
  Bun.spawnSync(["pkill", "-f", profile]); srv.stop()
  rmSync(dir, { recursive: true, force: true }); rmSync(profile, { recursive: true, force: true })
}
