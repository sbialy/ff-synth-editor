// Screenshot of the Master inserts section of the page in headless Chrome: bun scripts/screenshot-inserts.ts [out.png]
// Starts its own server on a free port. Needs the wasm host and the module sets (bun run build:wasm, bun run modules).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { startServer } from "../server/index"
import { ensureBuilt } from "../test/helpers"

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if (!existsSync(CHROME)) throw new Error("Chrome not found, set CHROME")
const out = resolve(process.argv[2] ?? "docs/screenshots/main-inserts.png")
mkdirSync(dirname(out), { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

await ensureBuilt()
const dir = mkdtempSync(join(tmpdir(), "pse-ins-")), profile = mkdtempSync(join(tmpdir(), "pse-ins-chrome-"))
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
  for (let i = 0; i < 100 && !(await ev("!!window.__inserts && document.querySelectorAll('#inscol-0 .inssel option').length > 1")); i++) await sleep(100)
  const pick = (slot: number, name: string) => ev(`(() => { const s = document.querySelector('#inscol-${slot} .inssel'); s.value = ${JSON.stringify(name)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value })()`)
  const param = (slot: number, index: number, value: number) => ev(`(() => { const e = document.querySelector('#inscol-${slot} [data-index="${index}"]'); e.value = ${value}; e.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await pick(0, "Dirt"); await param(0, 0, 1); await param(0, 1, 62); await param(0, 2, 12)
  const second = await ev("[...document.querySelectorAll('#inscol-1 .inssel option')].map((o) => o.textContent).find((n) => ['Console', 'Tube', 'Tape'].includes(n))")
  await pick(1, second)
  await ev("(() => { const s = document.getElementById('insmixer'); s.value = '2'; s.dispatchEvent(new Event('change', { bubbles: true })) })()")
  await sleep(300)
  await ev("document.activeElement?.blur(); document.querySelector('header').style.position = 'static'; document.querySelector('.keybed').style.position = 'static'; document.getElementById('inserts').scrollIntoView()")
  await sleep(200)
  const r = await ev("(() => { const b = document.getElementById('inserts').getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, width: b.width, height: b.height } })()")
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...r, scale: 1 } }, session)
  writeFileSync(out, Buffer.from(shot.data, "base64")); console.log(out)
} finally {
  try { await Promise.race([send("Browser.close"), sleep(1500)]) } catch {}
  ws.close(); await Promise.race([chrome.exited, sleep(3000)]); chrome.kill()
  Bun.spawnSync(["pkill", "-f", profile]); srv.stop()
  rmSync(dir, { recursive: true, force: true }); rmSync(profile, { recursive: true, force: true })
}
