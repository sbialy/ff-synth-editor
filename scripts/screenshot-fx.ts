// Screenshot of the Master delay and reverb panels, the Master inserts and the Master limiter sections of the page in headless Chrome: bun scripts/screenshot-fx.ts [out.png]
// Starts its own server on a free port. Needs the wasm host and the module sets (bun run build:wasm, bun run modules).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { startServer } from "../server/index"
import { ensureBuilt } from "../test/helpers"

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if (!existsSync(CHROME)) throw new Error("Chrome not found, set CHROME")
const out = resolve(process.argv[2] ?? "docs/screenshots/main-fx.png")
mkdirSync(dirname(out), { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

await ensureBuilt()
const dir = mkdtempSync(join(tmpdir(), "pse-fx-")), profile = mkdtempSync(join(tmpdir(), "pse-fx-chrome-"))
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
  for (let i = 0; i < 100 && !(await ev("!!window.__inserts && window.__inserts.loaded && document.querySelectorAll('#fxdelay .ip').length > 5 && document.querySelectorAll('#inscol-0 .inssel option').length > 1")); i++) await sleep(100)
  const knob = (key: string, value: number) => ev(`(() => { const e = document.querySelector('[data-fx="${key}"]'); e.value = ${value}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  for (const [k, v] of Object.entries({ "delay.send": 42, "delay.level": 90, "delay.pingpong": 1, "delay.time": 360, "delay.feedback": 62, "delay.filter": 6000, "reverb.send": 55, "reverb.size": 72, "reverb.damp": 40, "reverb.predelay": 30 })) await knob(k, v)
  const pick = (slot: number, name: string) => ev(`(() => { const s = document.querySelector('#inscol-${slot} .inssel'); s.value = ${JSON.stringify(name)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value })()`)
  await pick(0, "Tape")
  // the limiter on, in Extreme mode with a fast attack, a threshold of step 70
  for (const [k, v] of Object.entries({ "limiter.mode": 1, "limiter.attack": 400, "limiter.release": 60, "limiter.threshold": 70 })) await knob(k, v)
  await ev("(() => { const c = document.querySelector('[data-fx=\"limiter.on\"]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })) })()")
  await ev("(() => { const s = document.getElementById('insmixer'); s.value = '1'; s.dispatchEvent(new Event('change', { bubbles: true })) })()")
  await sleep(300)
  await ev("document.activeElement?.blur(); document.querySelector('header').style.position = 'static'; document.querySelector('.keybed').style.position = 'static'; document.getElementById('fx').scrollIntoView()")
  await sleep(200)
  const r = await ev("(() => { const a = document.getElementById('fx').getBoundingClientRect(), b = document.getElementById('limiter').getBoundingClientRect(); return { x: a.left + scrollX, y: a.top + scrollY, width: a.width, height: b.bottom - a.top } })()")
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...r, scale: 1 } }, session)
  writeFileSync(out, Buffer.from(shot.data, "base64")); console.log(out)
} finally {
  try { await Promise.race([send("Browser.close"), sleep(1500)]) } catch {}
  ws.close(); await Promise.race([chrome.exited, sleep(3000)]); chrome.kill()
  Bun.spawnSync(["pkill", "-f", profile]); srv.stop()
  rmSync(dir, { recursive: true, force: true }); rmSync(profile, { recursive: true, force: true })
}
