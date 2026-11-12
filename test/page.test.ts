// The real page in headless Chrome (Chrome DevTools Protocol, no extra dependency): the patch list loads on selection, the
// discard confirm works, the polyphony select and a faked Web MIDI device drive the streaming host through the page's own code.
// Skipped when Chrome is not installed (set CHROME to point at it).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startServer } from "../server/index"
import { firmware } from "../server/firmware"
import { ensureBuilt, testPrivate } from "./helpers"
import { formatSeed, fnv1a64 } from "../public/seed.js"

const sc = (n: number | string) => formatSeed(BigInt(n), 2) // the seed code the page shows for a plain number seed

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const haveChrome = existsSync(CHROME)

// a Web MIDI stand-in installed before the page scripts run: window.__midi.send(bytes...) delivers to the page's handler
const FAKE_MIDI = `
(() => {
  const port = { id: "fake-1", name: "Fake Keys", type: "input", state: "connected", onmidimessage: null }
  const access = { inputs: new Map([["fake-1", port]]), onstatechange: null }
  window.__midi = { port, access, send: (...d) => port.onmidimessage && port.onmidimessage({ data: Uint8Array.from(d) }) }
  navigator.requestMIDIAccess = async () => access
})()`

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

describe.skipIf(!haveChrome)("page in headless Chrome", () => {
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
  const until = async (expr: string, what: string, ms = 8000) => {
    const t0 = Date.now()
    for (;;) {
      const v = await evaluate(expr).catch(() => false)
      if (v) return v
      if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + what + ", status: " + (await evaluate("document.getElementById('status').textContent").catch(() => "?")))
      await sleep(50)
    }
  }
  const choose = (name: string) => evaluate(`(() => { const s = document.getElementById('patches'); s.value = ${JSON.stringify(name)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value })()`)
  const cutoff = () => evaluate(`(() => { const r = [...document.querySelectorAll('.param')].find((p) => p.querySelector('.pname').textContent === 'Cutoff'); return Number(r.querySelector('input').value) })()`)
  const nudge = () => evaluate(`(() => { const r = [...document.querySelectorAll('.param')].find((p) => p.querySelector('.pname').textContent === 'Cutoff').querySelector('input'); r.value = 0.9; r.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "poly-editor-page-"))
    profile = mkdtempSync(join(tmpdir(), "poly-editor-chrome-"))
    await ensureBuilt()
    srv = await startServer({ port: 0, dir })
    // two ACD patches with different cutoffs, saved through the server like the page does
    const m = await (await fetch(srv.url + "/api/meta/ACD")).json()
    const ci = m.params.findIndex((p: any) => p.name === "Cutoff")
    for (const [name, v] of [["One", 200], ["Two", 6000], ["Three", 1500]] as const) {
      const patch = structuredClone(m.init); patch.values[ci] = v
      const r = await fetch(srv.url + "/api/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir, name, patch }) })
      expect(r.status).toBe(200)
    }
    chrome = Bun.spawn([CHROME, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
      "--autoplay-policy=no-user-gesture-required", "--mute-audio", "about:blank"], { stdout: "ignore", stderr: "ignore" })
    let port = ""
    for (let i = 0; i < 100 && !port; i++) {
      await sleep(100)
      try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0] } catch {}
    }
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    cdp = await Cdp.open(version.webSocketDebuggerUrl)
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" })
    session = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId
    await cdp.send("Page.enable", {}, session)
    await cdp.send("Runtime.enable", {}, session)
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: FAKE_MIDI }, session)
    await cdp.send("Page.navigate", { url: srv.url + "/" }, session)
    await until(`document.querySelectorAll('#patches option').length === 3`, "the patch list")
  }, 120_000)

  afterAll(async () => {
    try { await Promise.race([cdp?.send("Browser.close"), sleep(1500)]) } catch {} // closes every Chrome process, kill() alone leaves helpers behind
    try { cdp?.close() } catch {}
    await Promise.race([chrome?.exited, sleep(3000)])
    chrome?.kill()
    Bun.spawnSync(["pkill", "-f", profile]) // helper processes that outlived the main one (the profile path is unique to this run)
    srv?.stop()
    rmSync(dir, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
  })

  test("the Load button is now a Reload, the list is where you pick", async () => {
    expect(await evaluate(`document.getElementById('load').textContent`)).toBe("Reload")
  })

  test("choosing a patch loads it at once (change event on the list), the search field shows the loaded name", async () => {
    const before = await cutoff()
    await choose("One")
    await until(`document.getElementById('name').value === 'One'`, "One to load")
    const one = await cutoff()
    expect(one).not.toBe(before)
    await choose("Two")
    await until(`document.getElementById('name').value === 'Two'`, "Two to load")
    expect(await cutoff()).toBeGreaterThan(one) // 6000 Hz sits above 200 Hz on the knob
    expect(await evaluate(`document.getElementById('status').textContent`)).toContain("Loaded Two")
    expect(await evaluate(`document.getElementById('patchsearch').value`)).toBe("Two")
    expect(await evaluate(`document.getElementById('discard').open`)).toBe(false) // nothing was edited: no question
  })

  describe("patch search", () => {
    const key = async (key: string, code: string, vk: number, sid = session) => {
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, sid)
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, sid)
    }
    const DOWN = () => key("ArrowDown", "ArrowDown", 40), UP = () => key("ArrowUp", "ArrowUp", 38), ENTER = () => key("Enter", "Enter", 13), ESC = () => key("Escape", "Escape", 27)
    const items = () => evaluate(`[...document.querySelectorAll('#patchlist li[data-name]')].map((l) => l.dataset.name)`)
    const activeItem = () => evaluate(`document.querySelector('#patchlist li.active')?.dataset.name ?? null`)
    const isOpen = () => evaluate(`!document.getElementById('patchlist').hidden`)
    const type = async (text: string) => { await cdp.send("Input.insertText", { text }, session) }
    const focusField = () => evaluate(`(() => { const f = document.getElementById('patchsearch'); f.focus(); return document.activeElement === f })()`)

    test("a click or Arrow Down opens the list of the engine's folder, typing filters it, the field is a combobox", async () => {
      await choose("Two"); await until(`document.getElementById('name').value === 'Two'`, "Two")
      expect(await evaluate(`document.getElementById('patchsearch').getAttribute('role')`)).toBe("combobox")
      expect(await isOpen()).toBe(false)
      expect(await focusField()).toBe(true)
      expect(await isOpen()).toBe(false) // focus alone does not open it
      await DOWN()
      expect(await isOpen()).toBe(true)
      expect(await items()).toEqual(["One", "Three", "Two"]) // every patch of the folder, sorted
      expect(await activeItem()).toBe("Two") // starts on the loaded one
      expect(await evaluate(`document.getElementById('patchsearch').getAttribute('aria-expanded')`)).toBe("true")
      await type("t") // a field of text: nothing here plays a note
      expect(await items()).toEqual(["Three", "Two"])
      await type("w")
      expect(await items()).toEqual(["Two"])
      await evaluate(`document.getElementById('patchsearch').select()`)
      await type("HR") // any case, anywhere in the name
      expect(await items()).toEqual(["Three"])
      await evaluate(`document.getElementById('patchsearch').select()`)
      await type("zzz")
      expect(await items()).toEqual([])
      expect(await evaluate(`document.querySelector('#patchlist li.none').textContent`)).toBe("No match")
      await ESC()
      expect(await isOpen()).toBe(false)
      expect(await evaluate(`document.getElementById('patchsearch').value`)).toBe("Two") // the field goes back to the loaded patch
      expect(await evaluate(`document.activeElement === document.body`)).toBe(true)
      expect(await evaluate(`document.getElementById('name').value`)).toBe("Two") // nothing was loaded
      // a pointer on the field opens the whole list
      expect(await focusField()).toBe(true)
      await evaluate(`document.getElementById('patchsearch').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
      expect(await items()).toEqual(["One", "Three", "Two"])
      await evaluate(`document.getElementById('patchsearch').blur()`)
      expect(await isOpen()).toBe(false) // leaving the field closes it
      // and a press anywhere else closes a list that was opened without the focus
      await evaluate(`document.getElementById('patchsearch').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
      expect(await isOpen()).toBe(true)
      await evaluate(`document.getElementById('engname').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
      expect(await isOpen()).toBe(false)
    })

    test("arrow keys move, Enter loads the highlighted patch and lets go of the focus, Escape closes without loading", async () => {
      await choose("Two"); await until(`document.getElementById('name').value === 'Two'`, "Two")
      expect(await focusField()).toBe(true)
      await DOWN() // opens on the loaded patch
      expect(await activeItem()).toBe("Two")
      await UP(); expect(await activeItem()).toBe("Three")
      await UP(); expect(await activeItem()).toBe("One")
      await UP(); expect(await activeItem()).toBe("One") // the top of the list
      await DOWN(); expect(await activeItem()).toBe("Three")
      expect(await evaluate(`document.getElementById('name').value`)).toBe("Two") // moving loads nothing
      await ENTER()
      await until(`document.getElementById('name').value === 'Three'`, "Three to load")
      expect(await evaluate(`document.getElementById('status').textContent`)).toContain("Loaded Three")
      expect(await isOpen()).toBe(false)
      expect(await evaluate(`document.getElementById('patchsearch').value`)).toBe("Three")
      expect(await evaluate(`document.activeElement === document.body`)).toBe(true)
      // type to find, Enter on the first match
      expect(await focusField()).toBe(true)
      await type("on")
      expect(await items()).toEqual(["One"])
      await ENTER()
      await until(`document.getElementById('name').value === 'One'`, "One to load")
      expect(await evaluate(`document.getElementById('patchsearch').value`)).toBe("One")
      // Escape: no load, the focus is let go
      expect(await focusField()).toBe(true)
      await DOWN(); await DOWN()
      await ESC()
      await sleep(150)
      expect(await evaluate(`document.getElementById('name').value`)).toBe("One")
      expect(await evaluate(`document.activeElement === document.body`)).toBe(true)
      // a click on an entry loads it too
      await evaluate(`document.getElementById('patchsearch').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
      await evaluate(`document.querySelector('#patchlist li[data-name=Two]').click()`)
      await until(`document.getElementById('name').value === 'Two'`, "Two by click")
      expect(await isOpen()).toBe(false)
    })

    test("the note keys play with the list closed and are text with the field focused", async () => {
      await evaluate(`document.activeElement.blur(); window.__lit = []; window.__litObs?.disconnect(); window.__litObs = new MutationObserver((ms) => { for (const m of ms) if (m.target.classList.contains('down')) window.__lit.push(Number(m.target.dataset.note)) }); window.__litObs.observe(document.getElementById('keys'), { subtree: true, attributes: true, attributeFilter: ['class'] })`)
      const tap = async (k: string) => {
        const p = { key: k, code: "Key" + k.toUpperCase(), windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) }
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...p, text: k }, session)
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...p }, session)
      }
      await tap("a")
      await until(`window.__lit.length === 1`, "a note with the list closed")
      await until(`!document.querySelector('#keys .key.down')`, "the key to lift")
      expect(await focusField()).toBe(true)
      await DOWN(); await tap("a"); await sleep(250) // open, typing
      expect(await evaluate(`window.__lit.length`)).toBe(1)
      expect(await evaluate(`document.getElementById('patchsearch').value`)).toBe("a")
      await ESC()
      await tap("s")
      await until(`window.__lit.length === 2`, "a note after Escape")
      await evaluate(`window.__litObs.disconnect()`)
    })
  })

  describe("ratings", () => {
    const stars = () => evaluate(`document.querySelectorAll('#stars button.on').length`)
    const saved = async () => (await (await fetch(`${srv.url}/api/ratings?engine=ACD&dir=${encodeURIComponent(dir)}`)).json()).ratings
    const savedIs = async (want: object) => { // the page shows a click at once, the file follows
      for (let i = 0; i < 100; i++) { if (JSON.stringify(await saved()) === JSON.stringify(want)) return; await sleep(50) }
      expect(await saved()).toEqual(want)
    }
    const load = async (name: string) => { await choose(name); await until(`document.getElementById('name').value === '${name}' && document.getElementById('patchsearch').value === '${name}'`, name + " to load") }
    // a real mouse click at the middle of an element
    const mouseClick = async (selector: string) => {
      const r = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } })()`)
      for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 }, session)
    }
    const opened = () => evaluate(`document.getElementById('patchsearch').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
    const names = () => evaluate(`[...document.querySelectorAll('#patchlist li[data-name]')].map((l) => l.dataset.name)`)
    const closeList = async () => { await evaluate(`document.getElementById('patchsearch').blur()`); await until(`document.getElementById('patchlist').hidden`, "the list to close") }

    test("a star click rates the loaded patch, the same star again clears it, the rating is in ratings.json next to the patches", async () => {
      await load("One")
      expect(await stars()).toBe(0)
      await evaluate(`document.querySelector('#stars button[data-star="4"]').click()`)
      await until(`document.querySelectorAll('#stars button.on').length === 4`, "four stars lit")
      await until(`document.getElementById('status').textContent.includes('Rated One: 4 of 5')`, "the status")
      await savedIs({ One: 4 })
      expect(JSON.parse(readFileSync(join(dir, "ACD", "ratings.json"), "utf8"))).toEqual({ version: 1, ratings: { "One.patch": 4 } })
      expect(await evaluate(`document.getElementById('dirtymark').textContent`)).toBe("") // a rating is not an edit of the patch
      await evaluate(`document.querySelector('#stars button[data-star="4"]').click()`)
      await until(`document.querySelectorAll('#stars button.on').length === 0`, "cleared")
      await until(`document.getElementById('status').textContent.includes('Cleared the rating of One')`, "the clear status")
      await savedIs({})
    }, 30_000)

    test("the stars follow the loaded patch, the combobox shows them per entry and can filter by minimum rating and sort by rating", async () => {
      await load("One"); await evaluate(`document.querySelector('#stars button[data-star="2"]').click()`)
      await until(`document.querySelectorAll('#stars button.on').length === 2`, "One: 2")
      await load("Two"); expect(await stars()).toBe(0)
      await evaluate(`document.querySelector('#stars button[data-star="5"]').click()`)
      await until(`document.querySelectorAll('#stars button.on').length === 5`, "Two: 5")
      await load("One"); expect(await stars()).toBe(2) // back on One: its own rating
      await savedIs({ One: 2, Two: 5 })

      await opened()
      expect(await names()).toEqual(["One", "Three", "Two"])
      expect(await evaluate(`[...document.querySelectorAll('#patchlist li[data-name]')].map((l) => l.querySelector('.rs')?.getAttribute('aria-label') ?? '-').join('|')`)).toBe("2 of 5 stars|-|5 of 5 stars")
      // minimum rating: 3+ keeps Two, the same star again lifts the filter
      await evaluate(`document.querySelector('#patchlist button[data-min="3"]').click()`)
      expect(await names()).toEqual(["Two"])
      expect(await evaluate(`document.getElementById('patchlist').hidden`)).toBe(false) // the filter does not close the list
      await evaluate(`document.querySelector('#patchlist button[data-min="1"]').click()`)
      expect(await names()).toEqual(["One", "Two"])
      await evaluate(`document.querySelector('#patchlist button[data-min="1"]').click()`)
      expect(await names()).toEqual(["One", "Three", "Two"])
      // sort by rating: best first, unrated last, then by name
      await evaluate(`document.querySelector('#patchlist button[data-sort]').click()`)
      expect(await names()).toEqual(["Two", "One", "Three"])
      // it works together with the text filter
      await evaluate(`document.getElementById('patchsearch').focus()`)
      await cdp.send("Input.insertText", { text: "t" }, session)
      expect(await names()).toEqual(["Two", "Three"])
      await evaluate(`document.querySelector('#patchlist button[data-sort]').click()`)
      expect(await names()).toEqual(["Three", "Two"]) // back to the name order
      await closeList()
    }, 30_000)

    test("a mouse click on a star leaves the focus where it was: the computer keys still play, and a typed field still gets its keys", async () => {
      await load("One")
      await evaluate(`window.__lit = []; window.__litObs?.disconnect(); window.__litObs = new MutationObserver((ms) => { for (const m of ms) if (m.target.classList.contains('down')) window.__lit.push(Number(m.target.dataset.note)) }); window.__litObs.observe(document.getElementById('keys'), { subtree: true, attributes: true, attributeFilter: ['class'] })`)
      await mouseClick('#stars button[data-star="3"]')
      await until(`document.querySelectorAll('#stars button.on').length === 3`, "three stars by a real click")
      expect(await evaluate(`document.activeElement.tagName`)).toBe("BODY")
      const tap = async (k: string) => {
        const p = { key: k, code: "Key" + k.toUpperCase(), windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) }
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...p, text: k }, session)
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...p }, session)
      }
      await tap("a")
      await until(`window.__lit.length === 1`, "a note right after the star click")
      // a click inside the open list (filter, sort) keeps the focus in the search field, which keeps its keys
      await evaluate(`document.getElementById('patchsearch').focus()`)
      await opened()
      await mouseClick('#patchlist button[data-min="1"]')
      expect(await evaluate(`document.activeElement.id`)).toBe("patchsearch")
      await mouseClick('#patchlist button[data-min="1"]')
      await tap("a"); await sleep(200)
      expect(await evaluate(`window.__lit.length`)).toBe(1)
      expect(await evaluate(`document.getElementById('patchsearch').value`)).toBe("a")
      await closeList()
      await evaluate(`window.__litObs.disconnect()`)
      // leave no ratings behind
      await evaluate(`document.querySelector('#stars button[data-star="3"]').click()`)
      await load("Two"); await evaluate(`document.querySelector('#stars button[data-star="5"]').click()`)
      await until(`document.querySelectorAll('#stars button.on').length === 0`, "Two cleared")
      await savedIs({})
    }, 30_000)

    test("a folder that refuses the rating shows the stars read-only and a failed save puts the old stars back", async () => {
      await load("One")
      await evaluate(`document.querySelector('#stars button[data-star="3"]').click()`)
      await until(`document.querySelectorAll('#stars button.on').length === 3`, "One: 3")
      await until(`document.getElementById('status').textContent.includes('Rated One: 3 of 5')`, "saved")
      // the sidecar's folder becomes read-only behind the page's back: the write is refused, the stars return to 3
      chmodSync(join(dir, "ACD"), 0o555)
      try {
        if (process.getuid?.() !== 0) {
          await evaluate(`document.querySelector('#stars button[data-star="1"]').click()`)
          await until(`document.getElementById('status').className === 'err' && document.getElementById('status').textContent.startsWith('Rating failed')`, "the refusal")
          expect(await stars()).toBe(3)
          // reloading the list finds the folder read-only: the buttons are off, the stars still show
          await evaluate(`document.getElementById('setdir').click()`)
          await until(`document.querySelector('#stars button').disabled`, "read-only stars")
          expect(await stars()).toBe(3)
        }
      } finally { chmodSync(join(dir, "ACD"), 0o755) }
      await evaluate(`document.getElementById('setdir').click()`)
      await until(`!document.querySelector('#stars button').disabled`, "writable again")
      await evaluate(`document.querySelector('#stars button[data-star="3"]').click()`) // clear
      await until(`document.querySelectorAll('#stars button.on').length === 0`, "cleared")
      await savedIs({})
    }, 30_000)
  })

  test("a randomized patch counts as edited: choosing another patch asks first, Keep editing leaves the roll", async () => {
    await evaluate(`document.activeElement.blur()`)
    const before = await cutoff()
    await evaluate(`document.getElementById('randseed').value = '31337'; document.getElementById('randgo').click()`)
    await until(`document.getElementById('randlast').textContent === 'seed ${sc(31337)}' && !document.getElementById('randundo').disabled`, "the roll")
    await sleep(200)
    await choose("One")
    await until(`document.getElementById('discard').open`, "the confirm after a randomize")
    await evaluate(`document.getElementById('discardno').click()`)
    expect(await evaluate(`document.getElementById('dirtymark').textContent`)).toBe("unsaved edits")
    await evaluate(`document.getElementById('randundo').click()`)
    await until(`document.getElementById('randundo').disabled`, "undo")
    await sleep(150)
    expect(await cutoff()).toBeCloseTo(before, 4)
    expect(await evaluate(`document.getElementById('dirtymark').textContent`)).toBe("")
    await evaluate(`document.getElementById('randseed').value = ''`)
  })

  test("unsaved edits: one confirm, Keep editing leaves everything, Replace loads, 'don't ask again' sticks", async () => {
    await choose("Two"); await until(`document.getElementById('name').value === 'Two'`, "Two")
    await nudge()
    const edited = await cutoff()
    expect(edited).toBeCloseTo(0.9, 2)
    await choose("One")
    await until(`document.getElementById('discard').open`, "the confirm")
    expect(await evaluate(`document.getElementById('discardmsg').textContent`)).toContain("unsaved")
    await evaluate(`document.getElementById('discardno').click()`)
    expect(await evaluate(`document.getElementById('patches').value`)).toBe("Two") // the list is back on the loaded patch
    expect(await evaluate(`document.getElementById('name').value`)).toBe("Two")
    expect(await cutoff()).toBeCloseTo(0.9, 2) // the edit is still there
    expect(await evaluate(`document.getElementById('patchsearch').value`)).toBe("Two")

    await choose("One")
    await until(`document.getElementById('discard').open`, "the confirm again")
    await evaluate(`document.getElementById('discardquiet').checked = true; document.getElementById('discardyes').click()`)
    await until(`document.getElementById('name').value === 'One'`, "One after Replace")
    expect(await cutoff()).not.toBeCloseTo(0.9, 2)

    await nudge()
    await choose("Three")
    await until(`document.getElementById('name').value === 'Three'`, "Three without a question")
    expect(await evaluate(`document.getElementById('discard').open`)).toBe(false)
  })

  test("polyphony 1-8 per engine, MIDI device picker and channel, 8 held MIDI notes are 8 voices and a 9th steals", async () => {
    const opts = await evaluate(`[...document.getElementById('poly').options].map((o) => o.value).join()`)
    expect(opts).toBe("1,2,3,4,5,6,7,8")
    expect(await evaluate(`document.getElementById('poly').value`)).toBe("2")

    await evaluate(`document.getElementById('midi').click()`)
    await until(`document.getElementById('midistate').textContent.includes('1 of 1')`, "the MIDI device")
    expect(await evaluate(`[...document.getElementById('mididev').options].map((o) => o.textContent).join('|')`)).toBe("All inputs|Fake Keys")
    expect(await evaluate(`document.getElementById('midich').value`)).toBe("omni")
    await until(`document.getElementById('livebtn').textContent === 'Live audio: on'`, "live audio started by MIDI enable")
    await sleep(300)

    await evaluate(`(() => { const p = document.getElementById('poly'); p.value = '8'; p.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    expect(await evaluate(`document.getElementById('poly').selectedOptions[0].textContent`)).toContain("editor only")
    for (let n = 0; n < 8; n++) await evaluate(`window.__midi.send(0x90, ${48 + n}, 100)`)
    await until(`document.getElementById('voices').textContent === 'sounding 8, 8 held'`, "8 voices")
    await evaluate(`window.__midi.send(0x90, 72, 100)`)
    await sleep(300)
    expect(await evaluate(`document.getElementById('voices').textContent`)).toBe("sounding 8, 8 held")
    expect(await evaluate(`document.querySelectorAll('.key.down').length`)).toBeGreaterThan(0)

    // sustain pedal and notes off through the page's own routing, mod wheel and bend show in the monitor
    await evaluate(`window.__midi.send(0xb0, 123, 0)`)
    await until(`document.getElementById('voices').textContent.startsWith('sounding') && !document.getElementById('voices').textContent.includes('held')`, "all released")
    await evaluate(`window.__midi.send(0xb0, 1, 90); window.__midi.send(0xe0, 0, 127); window.__midi.send(0xb0, 64, 127)`)
    expect(await evaluate(`document.getElementById('midimon').textContent`)).toBe("mod 90 · bend +0.98 st · sustain (editor only)")
    await evaluate(`window.__midi.send(0x90, 60, 100); window.__midi.send(0x80, 60, 0)`)
    await sleep(300)
    expect(await evaluate(`document.getElementById('voices').textContent`)).toEndWith(", 1 held") // the pedal holds it (the released voices of before may still ring)
    await evaluate(`window.__midi.send(0xb0, 64, 0)`)
    await until(`!document.getElementById('voices').textContent.includes('held')`, "pedal up releases it")

    // a macro CC moves the page's macro slider
    await evaluate(`window.__midi.send(0xb0, 102, 127)`)
    expect(await evaluate(`Number(document.querySelector('.macro input').value)`)).toBe(100)

    // channel selection: with channel 3 chosen, notes on channel 1 are ignored
    await evaluate(`(() => { const c = document.getElementById('midich'); c.value = '2'; c.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await evaluate(`window.__midi.send(0x90, 50, 100)`)
    await sleep(250)
    expect(await evaluate(`document.getElementById('voices').textContent.includes('held')`)).toBe(false)
    await evaluate(`window.__midi.send(0x92, 50, 100)`)
    await until(`document.getElementById('voices').textContent.includes('1 held')`, "a note on the chosen channel")

    // the polyphony is per engine: another engine starts at the default again
    await evaluate(`[...document.querySelectorAll('#engines button')].find((b) => b.dataset.engine === 'FAT').click()`)
    await until(`document.getElementById('poly').value === '2'`, "FAT at 2 voices")
    await evaluate(`[...document.querySelectorAll('#engines button')].find((b) => b.dataset.engine === 'ACD').click()`)
    await until(`document.getElementById('poly').value === '8'`, "ACD remembered 8 voices")
  }, 60_000)
  // a second fake input, plugged and unplugged through the same access object the page listens to
  const plug2 = () => evaluate(`(() => { const m = window.__midi; m.port2 ??= { id: "fake-2", name: "Fake Keys MIDI 2", type: "input", state: "connected", onmidimessage: null }; m.port2.state = "connected"; m.access.inputs.set("fake-2", m.port2); m.access.onstatechange({ port: m.port2 }); return true })()`)
  const unplug = (id: string, key = id === "fake-1" ? "port" : "port2") => evaluate(`(() => { const m = window.__midi; const p = m.${key}; p.state = "disconnected"; m.access.inputs.delete(${JSON.stringify(id)}); m.access.onstatechange({ port: p }); return true })()`)
  const replug1 = () => evaluate(`(() => { const m = window.__midi; m.port.state = "connected"; m.access.inputs.set("fake-1", m.port); m.access.onstatechange({ port: m.port }); return true })()`)
  const held = () => evaluate(`document.getElementById('voices').textContent`)
  const kbHidden = () => evaluate(`getComputedStyle(document.querySelector('.keybed')).display === 'none'`)
  const kbLabel = () => evaluate(`document.getElementById('kbtoggle').textContent`)
  const kbStored = () => evaluate(`localStorage.getItem('poly-editor.keyboard')`)
  const clickKb = () => evaluate(`document.getElementById('kbtoggle').click()`)

  test("one held MIDI key is one held note and one voice, also when the controller shows up on two inputs or the status changes", async () => {
    await until(`document.getElementById('midistate').textContent.includes('1 of 1')`, "the MIDI device")
    await evaluate(`(() => { const c = document.getElementById('midich'); c.value = 'omni'; c.dispatchEvent(new Event('change', { bubbles: true })) })()`) // the test above left channel 3 chosen
    await evaluate(`window.__midi.send(0xb0, 123, 0)`)
    await until(`!document.getElementById('voices').textContent.includes('held')`, "nothing held")
    await evaluate(`window.__midi.send(0x90, 60, 100)`)
    await until(`document.getElementById('voices').textContent.endsWith(', 1 held')`, "one held")
    await sleep(300)
    expect(await held()).toEndWith(", 1 held")
    expect(await evaluate(`[...document.querySelectorAll('.key.down')].map((k) => k.dataset.note).join()`)).toBe("60")
    await evaluate(`window.__midi.send(0x90, 60, 0)`) // note on with velocity 0 is a note off
    await until(`!document.getElementById('voices').textContent.includes('held')`, "released")

    // status changes and a device reconnecting do not bind a second handler
    for (let i = 0; i < 3; i++) await evaluate(`window.__midi.access.onstatechange({ port: window.__midi.port })`)
    await unplug("fake-1"); await replug1()
    await evaluate(`window.__midi.send(0x90, 62, 100)`)
    await until(`document.getElementById('voices').textContent.endsWith(', 1 held')`, "one held after reconnect")
    await sleep(300)
    expect(await held()).toEndWith(", 1 held")
    await evaluate(`window.__midi.send(0x80, 62, 0)`)
    await until(`!document.getElementById('voices').textContent.includes('held')`, "released")

    // the same controller on a second input: both deliver every message, the key is still one note
    await plug2()
    await until(`document.getElementById('midistate').textContent.includes('2 of 2')`, "two inputs")
    await evaluate(`window.__midi.send(0x90, 64, 100); window.__midi.port2.onmidimessage({ data: Uint8Array.from([0x90, 64, 100]) })`)
    await until(`document.getElementById('voices').textContent.endsWith(', 1 held')`, "one held with two inputs")
    await sleep(300)
    expect(await held()).toEndWith(", 1 held")
    expect(await evaluate(`document.querySelectorAll('.key.down').length`)).toBe(1)
    await evaluate(`window.__midi.port2.onmidimessage({ data: Uint8Array.from([0x80, 64, 0]) }); window.__midi.send(0x80, 64, 0)`)
    await until(`!document.getElementById('voices').textContent.includes('held')`, "released from both")
    expect(await evaluate(`document.querySelectorAll('.key.down').length`)).toBe(0)
    await unplug("fake-2")
  }, 60_000)

  test("on-screen keyboard: hidden while a MIDI input listens, back when the device goes, a manual toggle wins until the MIDI state changes", async () => {
    await evaluate(`localStorage.removeItem('poly-editor.keyboard')`)
    // the page is in the "MIDI listening" state from the test above: auto hidden
    await until(`document.getElementById('midistate').textContent.includes('1 of 1')`, "one listening input")
    expect(await kbHidden()).toBe(true)
    expect(await kbLabel()).toBe("Keyboard: off")
    expect(await evaluate(`document.getElementById('kbtoggle').getAttribute('aria-pressed')`)).toBe("false")

    // the device disconnects: auto shows it
    await unplug("fake-1")
    expect(await kbHidden()).toBe(false)
    expect(await kbLabel()).toBe("Keyboard: on")
    // and the device comes back: auto hides it again
    await replug1()
    expect(await kbHidden()).toBe(true)

    // manual show while MIDI listens: stays shown through a status change that keeps the state, a second input coming and going
    await clickKb()
    expect(await kbHidden()).toBe(false)
    expect(await kbLabel()).toBe("Keyboard: on")
    expect(await kbStored()).toBe('{"manual":"shown"}')
    await evaluate(`window.__midi.access.onstatechange({ port: window.__midi.port })`)
    await plug2(); await unplug("fake-2")
    expect(await kbHidden()).toBe(false)
    // the MIDI state changes (the only input goes): the manual choice is spent, auto shows it, then the device returns and auto hides it
    await unplug("fake-1")
    expect(await kbStored()).toBeNull()
    expect(await kbHidden()).toBe(false)
    await replug1()
    expect(await kbHidden()).toBe(true)

    // manual hide with no MIDI: stays hidden until MIDI next changes
    await unplug("fake-1")
    expect(await kbHidden()).toBe(false)
    await clickKb()
    expect(await kbHidden()).toBe(true)
    expect(await kbStored()).toBe('{"manual":"hidden"}')
    await clickKb()
    expect(await kbHidden()).toBe(false)
    await clickKb()
    await replug1() // MIDI listens now: the hidden choice and auto agree, the stored choice is cleared
    expect(await kbHidden()).toBe(true)
    expect(await kbStored()).toBeNull()
    await unplug("fake-1")
    expect(await kbHidden()).toBe(false)
    await replug1()
    await evaluate(`localStorage.removeItem('poly-editor.keyboard')`)
  }, 60_000)

  test("the keyboard choice is remembered after a reload (new tab), without MIDI the keyboard is shown by default", async () => {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" })
    const sid = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId
    const ev = async (expr: string) => {
      const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sid)
      if (r.exceptionDetails) throw new Error("page error: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
      return r.result.value
    }
    const wait = async (expr: string) => { for (let i = 0; i < 160; i++) { if (await ev(expr).catch(() => false)) return; await sleep(50) } throw new Error("timed out: " + expr) }
    try {
      await cdp.send("Page.enable", {}, sid); await cdp.send("Runtime.enable", {}, sid)
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: FAKE_MIDI }, sid)
      await cdp.send("Page.navigate", { url: srv.url + "/" }, sid)
      await wait(`document.querySelectorAll('#patches option').length === 3`)
      expect(await ev(`getComputedStyle(document.querySelector('.keybed')).display`)).not.toBe("none") // default, no MIDI
      expect(await ev(`document.getElementById('kbtoggle').getBoundingClientRect().width`)).toBeGreaterThan(0)
      await ev(`document.getElementById('kbtoggle').click()`)
      expect(await ev(`getComputedStyle(document.querySelector('.keybed')).display`)).toBe("none")
      await cdp.send("Page.navigate", { url: srv.url + "/" }, sid) // reload
      await wait(`document.querySelectorAll('#patches option').length === 3`)
      expect(await ev(`getComputedStyle(document.querySelector('.keybed')).display`)).toBe("none")
      expect(await ev(`document.getElementById('kbtoggle').textContent`)).toBe("Keyboard: off")
      await ev(`document.getElementById('kbtoggle').click()`)
      await cdp.send("Page.navigate", { url: srv.url + "/" }, sid)
      await wait(`document.querySelectorAll('#patches option').length === 3`)
      expect(await ev(`getComputedStyle(document.querySelector('.keybed')).display`)).not.toBe("none")
      // enabling MIDI with a device present hides it and drops the stored choice
      await ev(`document.getElementById('midi').click()`)
      await wait(`document.getElementById('midistate').textContent.includes('1 of 1')`)
      expect(await ev(`getComputedStyle(document.querySelector('.keybed')).display`)).toBe("none")
      expect(await ev(`localStorage.getItem('poly-editor.keyboard')`)).toBeNull()
    } finally { await cdp.send("Target.closeTarget", { targetId }).catch(() => {}) }
  }, 60_000)
  test("switching engines fast never leaves a stale patch list, even when an earlier list answers last", async () => {
    // the list request of FAT is held back 700 ms, so its answer arrives after the one for ACD that was asked later
    await evaluate(`(() => { if (window.__realFetch) return; window.__realFetch = window.fetch
      window.fetch = (u, o) => String(u).includes('/api/patches?engine=FAT') ? new Promise((r) => setTimeout(r, 700)).then(() => window.__realFetch(u, o)) : window.__realFetch(u, o) })()`)
    try {
      const click = (e: string) => evaluate(`document.querySelector('#engines button[data-engine="${e}"]').click()`)
      await click("ACD"); await until(`document.querySelector('#engines button.on').dataset.engine === 'ACD' && document.querySelectorAll('#patches option').length === 3`, "ACD list")
      await click("FAT"); await sleep(100); await click("ACD")
      await sleep(1200)
      expect(await evaluate(`document.querySelector('#engines button.on').dataset.engine`)).toBe("ACD")
      expect(await evaluate(`[...document.querySelectorAll('#patches option')].map((o) => o.value).join()`)).toBe("One,Three,Two")
      expect(await evaluate(`!!document.getElementById('sections').textContent.includes('Cutoff')`)).toBe(true) // ACD params, not FAT's
    } finally {
      await evaluate(`if (window.__realFetch) { window.fetch = window.__realFetch; delete window.__realFetch }`)
    }
  })
  testPrivate("PHZ", "PLK")("release mode page: no Strict box, the 18 firmware engines, nothing about editor-only extras, a file of another engine is refused politely", async () => {
    const { copyFileSync, mkdirSync } = await import("node:fs")
    const relDir = mkdtempSync(join(tmpdir(), "poly-editor-rel-page-"))
    const rel = await startServer({ port: 0, dir: relDir, release: true })
    // a Pluck patch (made by the dev server of this test file) lying in the ACD folder
    const pm = await (await fetch(srv.url + "/api/meta/PLK")).json()
    expect((await fetch(srv.url + "/api/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir: relDir, name: "foreign", patch: pm.init }) })).status).toBe(200)
    mkdirSync(join(relDir, "ACD"), { recursive: true })
    copyFileSync(join(relDir, "PLK", "foreign.patch"), join(relDir, "ACD", "foreign.patch"))
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" })
    const sid = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId
    const ev = async (expr: string) => {
      const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sid)
      if (r.exceptionDetails) throw new Error("page error: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
      return r.result.value
    }
    const wait = async (expr: string) => { for (let i = 0; i < 160; i++) { if (await ev(expr).catch(() => false)) return; await sleep(50) } throw new Error("timed out: " + expr) }
    try {
      await cdp.send("Page.enable", {}, sid); await cdp.send("Runtime.enable", {}, sid)
      // a visitor's own saved choice must not matter: the old Strict key says off
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: FAKE_MIDI + `;localStorage.setItem('poly-editor.strict','0')` }, sid)
      await cdp.send("Page.navigate", { url: rel.url + "/?strict=0&dev=1&release=0" }, sid)
      await wait(`document.querySelectorAll('#patches option').length === 1`)
      expect(await ev(`document.getElementById('strict')`)).toBeNull()
      expect(await ev(`document.title`)).toBe("FF SYNTH EDITOR")
      const names = await ev(`[...document.querySelectorAll('#engines button')].map((b) => b.dataset.engine).join()`)
      expect(names).toBe("ACD,FAT,VAP,WTFM,PERC,CHIP,FM4,JU6,DTYPE,CSTYPE,ATYPE,TTYPE,8TYPE,HANDTYPE,BTYPE,ARCTYPE,PHZ,PLK")
      // release mode: the same four groups, the FF-engines together in the last one
      expect(await ev(`[...document.querySelectorAll('#engines .egroup')].map((g) => g.querySelector('.ghead').textContent).join('|')`)).toBe("OpenTracker 2.x|Polyend open source|OpenTracker 3.x|FF-engines")
      expect(await ev(`[...document.querySelectorAll('#engines .egroup[data-group=ff] button')].map((b) => b.dataset.engine).join()`)).toBe("PHZ,PLK")
      expect(await ev(`document.querySelectorAll('#engines button.offtracker, #engines .exp, #engines .trk:not(:empty)').length`)).toBe(0)
      // every engine, one after the other: the text of the page never names what release mode leaves out
      const banned = /experimental|editor only|editor-only|Strict|not on your Tracker|pluck@/i
      for (const e of ["ACD", "ATYPE", "TTYPE", "HANDTYPE", "PLK"]) {
        await ev(`document.querySelector('#engines button[data-engine="${e}"]').click()`)
        await wait(`document.getElementById('engname').textContent.length > 0 && document.querySelector('#engines button.on').dataset.engine === '${e}' && document.querySelectorAll('.param').length > 0`)
        const text = await ev(`document.body.innerText + ' ' + [...document.querySelectorAll('[title]')].map((x) => x.title).join(' ')`)
        expect(text).not.toMatch(banned)
      }
      // the voices are the firmware's 4 at most and the page runs Strict: MIDI sustain is not shown
      await ev(`document.querySelector('#engines button[data-engine="ACD"]').click()`)
      await wait(`document.querySelector('#engines button.on').dataset.engine === 'ACD' && document.querySelectorAll('#poly option').length === 4`)
      expect(await ev(`[...document.getElementById('poly').options].map((o) => o.value).join()`)).toBe("1,2,3,4")
      // the foreign file: refused with a plain message and the page keeps working
      await wait(`[...document.querySelectorAll('#patches option')].map((o) => o.value).join() === 'foreign'`)
      await sleep(300)
      // through the search field of the release page: type to filter, Enter loads
      expect(await ev(`(() => { const f = document.getElementById('patchsearch'); f.focus(); return document.activeElement === f })()`)).toBe(true)
      await cdp.send("Input.insertText", { text: "FOR" }, sid)
      expect(await ev(`[...document.querySelectorAll('#patchlist li[data-name]')].map((l) => l.dataset.name).join()`)).toBe("foreign")
      for (const type of ["rawKeyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sid)
      // (Pluck is a release engine since tracker-ff 1.2.0, so the host's own message, which names it, is shown)
      await wait(`document.getElementById('status').className === 'err' && /PLK patch, not ACD/.test(document.getElementById('status').textContent)`).catch(async (e) => { throw new Error(e.message + " :: " + await ev(`document.getElementById('status').textContent + ' / ' + document.getElementById('patches').value`)) })
      await ev(`document.querySelector('#engines button[data-engine="FAT"]').click()`)
      await wait(`document.querySelector('#engines button.on').dataset.engine === 'FAT' && document.querySelectorAll('.param').length > 0`)
    } finally {
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {})
      rel.stop(); rmSync(relDir, { recursive: true, force: true })
    }
    // the dev page of this file still has the box and every engine
    expect(await evaluate(`!!document.getElementById('strict') && !!document.querySelector('#engines button[data-engine="PLK"]')`)).toBe(true)
  }, 60_000)
  testPrivate("PHZ", "PLK")("the engine list has four groups: OpenTracker 2.x, Polyend open source (CHIP), OpenTracker 3.x with Hand-Type, FF-engines (PHZ and Pluck, every engine of firmware.private.engines, in a row of their own)", async () => {
    expect(await evaluate(`[...document.querySelectorAll('.egroup .ghead')].map((h) => h.textContent).join('|')`)).toBe("OpenTracker 2.x|Polyend open source|OpenTracker 3.x|FF-engines")
    expect(await evaluate(`[...document.querySelectorAll('.egroup[data-group=polyend] button')].map((b) => b.dataset.engine).join(' ')`)).toBe("ACD FAT VAP WTFM PERC")
    expect(await evaluate(`[...document.querySelectorAll('.egroup[data-group=polyend-oss] button')].map((b) => b.dataset.engine).join(' ')`)).toBe("CHIP")
    expect(await evaluate(`document.querySelector('.egroup[data-group=phz]')`)).toBe(null)
    expect(await evaluate(`[...document.querySelectorAll('.egroup[data-group=ot3] button')].map((b) => b.firstChild.textContent).join(' ')`)).toBe(
      "FM4 JU6 D-Type CS-Type A-Type T-Type 8-Type Hand-Type B-Type Arc-Type")
    expect(await evaluate(`document.querySelector('.egroup[data-group=plk]')`)).toBe(null)
    // the FF-engines: the engines of firmware.private.engines (the server marks them closed), together, in a row of their own below the other groups
    expect(await evaluate(`[...document.querySelectorAll('.egroup[data-group=ff] button')].map((b) => b.dataset.engine + ':' + b.firstChild.textContent).join(' ')`)).toBe("PHZ:PHZ PLK:Pluck")
    expect((await evaluate(`[...document.querySelectorAll('.egroup[data-group=ff] button')].map((b) => b.dataset.engine).join()`)).split(",").sort()).toEqual([...firmware.private.engines].sort())
    expect(await evaluate(`document.querySelector('.egroup[data-group=ff] .ghead').textContent`)).toBe("FF-engines")
    expect(await evaluate(`getComputedStyle(document.querySelector('.egroup[data-group=ff] .ghead')).textTransform`)).toBe("uppercase")
    expect(await evaluate(`(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); return r('.egroup[data-group=ff]').top >= Math.max(r('.egroup[data-group=polyend]').bottom, r('.egroup[data-group=ot3]').bottom) - 1 })()`)).toBe(true)
    expect(await evaluate(`document.querySelectorAll('.egroup[data-group=experimental] button').length`)).toBe(0)
    // Hand-Type is a release engine since tracker-ff 1.2.0: on the page and on the Tracker
    expect(await evaluate(`document.querySelector('#engines button[data-engine=HANDTYPE]').className.includes('offtracker')`)).toBe(false)
    // PHZ is on the Tracker, in its own group
    expect(await evaluate(`document.querySelector('#engines button[data-engine=PHZ]').className.includes('offtracker')`)).toBe(false)
    const click = (name: string) => evaluate(`[...document.querySelectorAll('#engines button')].find((b) => b.dataset.engine === '${name}').click()`)
    await click("PHZ")
    await until(`document.querySelector('#engines button.on')?.dataset.engine === 'PHZ' && document.getElementById('engname').textContent === 'PHZ' && document.querySelectorAll('.section').length === 10`, "PHZ")
    await click("JU6")
    await until(`document.querySelector('#engines button.on')?.dataset.engine === 'JU6' && document.querySelectorAll('.section').length === 6 && document.getElementById('engname').textContent === 'JU6'`, "JU6 sections")
    await click("ARCTYPE")
    await until(`document.querySelector('#engines button.on')?.dataset.engine === 'ARCTYPE' && document.querySelectorAll('.section').length === 8 && document.getElementById('engname').textContent === 'Arc-Type'`, "Arc-Type sections")
    await until(`document.getElementById('status').textContent.includes('Arc-Type: 62 parameters')`, "the Arc-Type status line") // written after the patch list, a moment after the sections
    expect(await evaluate(`[...document.querySelectorAll('.section h2')].map((h) => h.textContent).includes('Operator 1')`)).toBe(true)
    expect(await evaluate(`document.querySelector('#engines button[data-engine=ARCTYPE]').className.includes('offtracker')`)).toBe(false)
    // Pluck is a release engine since tracker-ff 1.2.0: on the Tracker, nothing experimental about it
    expect(await evaluate(`document.querySelector('#engines button[data-engine=PLK]').className`)).not.toContain("offtracker")
    expect(await evaluate(`document.querySelector('#engines button[data-engine=PLK]').className`)).not.toContain("experimental")
    expect(await evaluate(`document.querySelector('#engines button[data-engine=PLK] small.exp')`)).toBe(null)
    await click("PLK")
    await until(`document.querySelector('#engines button.on')?.dataset.engine === 'PLK' && document.getElementById('engname').textContent === 'Pluck' && document.querySelectorAll('.section').length === 3`, "Pluck")
    await until(`document.getElementById('status').textContent.includes('Pluck: 11 parameters')`, "the Pluck status line") // written after the patch list, a moment after the sections
    expect(await evaluate(`document.querySelectorAll('.param').length`)).toBe(11)
    // Vel Bright and Body (Pluck 1.1, the PLK of the tracker-ff 1.2.0 release) have rows with their names, a slider with the host's value text and a lock
    expect(await evaluate(`[...document.querySelectorAll('.param .pname')].map((e) => e.textContent).filter((n) => n === 'Vel Bright' || n === 'Body').join()`)).toBe("Vel Bright,Body")
    await click("ACD")
    await until(`document.getElementById('engname').textContent === 'ACD'`, "ACD")
    // nothing on the page speaks of flash or sizes
    const text = await evaluate(`document.body.innerText + ' ' + [...document.querySelectorAll('[title]')].map((e) => e.title).join(' ')`)
    expect(text).not.toMatch(/\bKB\b|\bflash\b|TRIM=1|linked|too big|\bfits\b/i)
    expect(await evaluate(`document.title`)).toBe("FF SYNTH EDITOR")
    expect(await evaluate(`document.querySelector('h1').textContent`)).toBe("FF SYNTH EDITOR")
  }, 60_000)
  testPrivate("PHZ", "PLK")("closed engines (PHZ and PLK) sit under the FF-engines heading and carry an ff-engine tag in the header, open ones do not, the pads have no label of their own", async () => {
    expect(await evaluate(`document.querySelectorAll('#engines button small.ff').length`)).toBe(0)
    expect(await evaluate(`[...document.querySelectorAll('.egroup[data-group=ff] button')].map((b) => b.dataset.engine).sort().join()`)).toBe("PHZ,PLK")
    const click = (name: string) => evaluate(`[...document.querySelectorAll('#engines button')].find((b) => b.dataset.engine === '${name}').click()`)
    for (const [name, shown] of [["PLK", true], ["ACD", false], ["PHZ", true], ["JU6", false]] as const) {
      await click(name)
      await until(`document.querySelector('#engines button.on')?.dataset.engine === '${name}' && document.getElementById('engtag').hidden === ${!shown} && document.getElementById('status').textContent.length > 0`, name)
      expect(await evaluate(`document.getElementById('engtag').hidden`)).toBe(!shown)
      expect(await evaluate(`document.getElementById('engtag').textContent`)).toBe("ff-engine")
    }
    await click("ACD")
    await until(`document.querySelector('#engines button.on')?.dataset.engine === 'ACD' && document.getElementById('status').textContent.startsWith('ACD')`, "ACD")
  }, 60_000)
  testPrivate("PHZ", "PLK")("the page says which firmware it matches, Strict (match my Tracker) hides the engines and extras the Tracker does not have", async () => {
    expect(await evaluate(`document.getElementById('fwbadge').textContent`)).toBe("matches tracker-ff 1.2.0")
    const click = (name: string) => evaluate(`[...document.querySelectorAll('#engines button')].find((b) => b.dataset.engine === '${name}').click()`)
    const tick = async (on: boolean) => { await evaluate(`(() => { const c = document.getElementById('strict'); c.checked = ${on}; c.dispatchEvent(new Event('change', { bubbles: true })) })()`); await sleep(400) }
    await click("ACD")
    await until(`document.querySelector('#engines button.on')?.dataset.engine === 'ACD' && document.getElementById('status').textContent.startsWith('ACD')`, "ACD")
    const polyOpts = () => evaluate(`[...document.getElementById('poly').options].map((o) => o.textContent).join('|')`)
    const heads = () => evaluate(`[...document.querySelectorAll('.egroup')].filter((g) => !g.hidden).map((g) => g.querySelector('.ghead').textContent).join('|')`)
    expect(await polyOpts()).toBe("1 (mono legato)|2|3|4|5 (editor only)|6 (editor only)|7 (editor only)|8 (editor only)")
    expect(await evaluate(`document.getElementById('strict').checked`)).toBe(false)
    expect(await heads()).toBe("OpenTracker 2.x|Polyend open source|OpenTracker 3.x|FF-engines")
    expect(await evaluate(`document.querySelector('#engines button[data-engine=PLK]').hidden`)).toBe(false)
    await tick(true)
    try {
      // tracker-ff 1.2.0 has every engine of the editor in its release image: Strict hides none of them, it only caps the extras
      expect(await evaluate(`document.querySelector('#engines button[data-engine=PLK]').hidden`)).toBe(false)
      expect(await heads()).toBe("OpenTracker 2.x|Polyend open source|OpenTracker 3.x|FF-engines")
      expect(await evaluate(`document.querySelector('#engines button[data-engine=ARCTYPE]').hidden`)).toBe(false)
      expect(await evaluate(`document.querySelector('#engines button[data-engine=PHZ]').hidden`)).toBe(false)
      expect(await evaluate(`document.querySelector('#engines button[data-engine=HANDTYPE]').hidden`)).toBe(false)
      expect(await polyOpts()).toBe("1 (mono legato)|2|3|4") // capped at the firmware's number, a remembered 8 is held to it
      expect(await evaluate(`document.getElementById('poly').value`)).toBe("4")
      // a one voice engine stays one voice
      await click("PERC")
      await until(`document.querySelector('#engines button.on')?.dataset.engine === 'PERC'`, "PERC")
      await until(`document.getElementById('poly').disabled && document.getElementById('status').textContent.startsWith('PERC')`, "PERC one voice")
      // Pluck stays chosen with Strict on: it is on the Tracker
      await tick(false)
      await click("PLK")
      await until(`document.querySelector('#engines button.on')?.dataset.engine === 'PLK' && document.getElementById('status').textContent.startsWith('Pluck')`, "Pluck")
      await tick(true)
      expect(await evaluate(`document.querySelector('#engines button.on')?.dataset.engine`)).toBe("PLK")
    } finally { await tick(false) }
    expect(await evaluate(`document.querySelector('#engines button[data-engine=PLK]').hidden`)).toBe(false)
    expect(await heads()).toBe("OpenTracker 2.x|Polyend open source|OpenTracker 3.x|FF-engines")
    expect(await polyOpts()).toBe("1 (mono legato)|2|3|4|5 (editor only)|6 (editor only)|7 (editor only)|8 (editor only)")
  }, 60_000)
  // ---- typed values and arrow keys on the sliders (public/valuefield.js, POST /api/typed). Real key events through the Chrome protocol.
  describe("typed values and arrow steps", () => {
    const KEYS: Record<string, [string, number]> = { ArrowRight: ["ArrowRight", 39], ArrowLeft: ["ArrowLeft", 37], ArrowUp: ["ArrowUp", 38], ArrowDown: ["ArrowDown", 40], PageUp: ["PageUp", 33], Enter: ["Enter", 13], Escape: ["Escape", 27] }
    const press = async (key: string, mods = 0, sid = session) => {
      const [code, vk] = KEYS[key]
      const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods }
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base }, sid)
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sid)
    }
    const SHIFT = 8
    const clickEngine = async (name: string) => {
      await evaluate(`[...document.querySelectorAll('#engines button')].find((b) => b.dataset.engine === '${name}').click()`)
      await until(`document.querySelector('#engines button.on')?.dataset.engine === '${name}' && document.getElementById('status').textContent.startsWith('${name}') && document.querySelectorAll('.param').length > 0`, name)
    }
    const row = (name: string, i = 0) => `[...document.querySelectorAll('.param')].filter((r) => r.querySelector('.pname').textContent === ${JSON.stringify(name)})[${i}]`
    const val = (name: string) => evaluate(`${row(name)}.querySelector('.val').textContent`)
    const slider = (name: string) => evaluate(`Number(${row(name)}.querySelector('input[type=range]').value)`)
    const histCount = () => evaluate(`document.querySelectorAll('#randhist li').length`)
    // click the readout, type, and leave with a key (or blur)
    const typeInto = async (name: string, text: string, leave: "Enter" | "Escape" | "blur" = "Enter", sid = session, ev: (e: string) => Promise<any> = evaluate) => {
      await ev(`${row(name)}.querySelector('.val').click()`)
      await until0(ev, `!!${row(name)}.querySelector('.val input.valedit') && document.activeElement === ${row(name)}.querySelector('.val input.valedit')`)
      await cdp.send("Input.insertText", { text }, sid)
      if (leave === "blur") await ev(`document.activeElement.blur()`)
      else await press(leave, 0, sid)
    }
    const until0 = async (ev: (e: string) => Promise<any>, expr: string) => { for (let i = 0; i < 160; i++) { if (await ev(expr).catch(() => false)) return; await sleep(50) } throw new Error("timed out: " + expr) }
    const fresh = async (engine: string) => { await clickEngine(engine === "ACD" ? "FAT" : "ACD"); await clickEngine(engine) }
    const K = 65535

    test("click the readout and type: unit forms, plain numbers, Enter and blur commit, Escape cancels, out of range clamps, junk reverts, one merged undo step", async () => {
      await fresh("ACD")
      const h0 = await histCount()
      expect(await val("Cutoff")).toBe("400 Hz")
      await typeInto("Cutoff", "440 Hz")
      await until(`${row("Cutoff")}.querySelector('.val').textContent === '440 Hz'`, "440 Hz")
      expect(Math.abs((await slider("Cutoff")) - Math.log(440 / 20) / Math.log(1000))).toBeLessThan(1e-4)
      await typeInto("Cutoff", "1.5 kHz")
      await until(`${row("Cutoff")}.querySelector('.val').textContent === '1.50 kHz'`, "1.5 kHz")
      await typeInto("Cutoff", "800")
      await until(`${row("Cutoff")}.querySelector('.val').textContent === '800 Hz'`, "plain 800")
      // two typed values and the one before: a single "edits" step in the history, like dragging
      expect(await histCount()).toBe(h0 + 1)
      expect(await evaluate(`document.getElementById('dirtymark').textContent`)).toBe("unsaved edits")
      // Escape cancels
      await typeInto("Cutoff", "5000", "Escape")
      await sleep(150)
      expect(await val("Cutoff")).toBe("800 Hz")
      expect(await evaluate(`!!document.querySelector('.val input.valedit')`)).toBe(false)
      // blur commits
      await typeInto("Cutoff", "2 kHz", "blur")
      await until(`${row("Cutoff")}.querySelector('.val').textContent === '2.00 kHz'`, "blur commit")
      // out of range clamps, unreadable reverts and says so
      await typeInto("Cutoff", "999999")
      await until(`${row("Cutoff")}.querySelector('.val').textContent === '20.00 kHz'`, "clamped high")
      await typeInto("Cutoff", "-5")
      await until(`${row("Cutoff")}.querySelector('.val').textContent === '20 Hz'`, "clamped low")
      await typeInto("Cutoff", "banana")
      await until(`document.getElementById('status').className === 'err' && document.getElementById('status').textContent.includes('banana')`, "an error for junk")
      expect(await val("Cutoff")).toBe("20 Hz")
      // percent, bipolar and time readouts
      await typeInto("Saw Mix", "35 %")
      await until(`${row("Saw Mix")}.querySelector('.val').textContent === '35%'`, "35 %")
      await typeInto("Noise Mix", "-50")
      await until(`${row("Noise Mix")}.querySelector('.val').textContent === '-50%'`, "-50 %")
      await typeInto("Attack", "250 ms")
      await until(`${row("Attack")}.querySelector('.val').textContent === '250 ms'`, "250 ms")
      await typeInto("Attack", "1.25 s")
      await until(`${row("Attack")}.querySelector('.val').textContent === '1.25 s'`, "1.25 s")
      // all of it is still one step, and undo takes the whole hand-edit step back (the readouts return to the start)
      expect(await histCount()).toBe(h0 + 1)
      await evaluate(`document.getElementById('randundo').click()`)
      await until(`${row("Cutoff")}.querySelector('.val').textContent === '400 Hz' && ${row("Saw Mix")}.querySelector('.val').textContent !== '35%'`, "undo")
      await evaluate(`document.getElementById('randredo').click()`)
      await until(`${row("Cutoff")}.querySelector('.val').textContent === '20 Hz'`, "redo")
    }, 60_000)

    test("enums: the select takes a name by typing; a stepped slider takes st / c / whole numbers", async () => {
      await fresh("VAP")
      const sel = await evaluate(`[...document.querySelectorAll('.param select')].length`)
      expect(sel).toBeGreaterThan(0) // enums are selects (type-ahead), their names and indexes also type through POST /api/typed (test/typed.test.ts)
      const tune = (await (await fetch(srv.url + "/api/meta/VAP")).json()).params.find((p: any) => p.name === "Tune" || p.name.startsWith("Tune"))!.name
      await typeInto(tune, "-12 st")
      await until(`${row(tune)}.querySelector('.val').textContent === '-12 st'`, "-12 st")
      await typeInto(tune, "7")
      await until(`${row(tune)}.querySelector('.val').textContent === '7 st'`, "plain 7")
      await typeInto(tune, "900 st")
      await until(`${row(tune)}.querySelector('.val').textContent === '36 st'`, "clamped to 36 st")
    }, 60_000)

    test("arrow keys: the smallest step that changes the readout (a continuous slider), Shift is 1/100 of the travel, PageUp a tenth, nothing else sees the key", async () => {
      await fresh("ACD")
      const heard = `(() => { window.__keys = []; window.addEventListener("keydown", (e) => window.__keys.push(e.key)) })()`
      await evaluate(heard)
      const focus = (name: string) => evaluate(`${row(name)}.querySelector('input[type=range]').focus()`)
      const inp = (name: string, expr: string) => evaluate(`(() => { const i = ${row(name)}.querySelector('input[type=range]'); return ${expr} })()`)
      const h0 = await histCount()
      await focus("Resonance")
      const k0 = Math.round((await slider("Resonance")) * K)
      const pct = async () => Number(/^(\d+)%$/.exec(await val("Resonance"))![1])
      const p0 = await pct()
      const posNow = () => evaluate(`Math.round(Number(${row("Resonance")}.querySelector('input[type=range]').value) * ${K})`)
      const shows = (n: number) => until(`${row("Resonance")}.querySelector('.val').textContent === '${n}%'`, `${n}%`)
      // the finest move is 1/65535 of the knob but the readout is whole percents: one press goes to the next percent, however many positions that is
      await press("ArrowRight"); await shows(p0 + 1)
      const k1 = await posNow()
      expect(k1).toBeGreaterThan(k0 + 100)
      await press("ArrowUp"); await shows(p0 + 2)
      await press("ArrowLeft"); await press("ArrowDown"); await press("ArrowDown"); await shows(p0 - 1)
      // down again from the first position of a percent: the edge of the next one, and back up to the same position as the first press
      await press("ArrowRight"); await press("ArrowRight"); await shows(p0 + 1)
      const kUp = await posNow()
      expect(Math.abs(kUp - k1)).toBeLessThanOrEqual(1)
      await press("ArrowRight", SHIFT)
      await until(`Math.abs(Math.round(Number(${row("Resonance")}.querySelector('input[type=range]').value) * ${K}) - ${kUp + 655}) <= 1`, "coarse step")
      const kc = await posNow()
      await press("PageUp")
      await until(`Math.abs(Math.round(Number(${row("Resonance")}.querySelector('input[type=range]').value) * ${K}) - ${kc + 6554}) <= 1`, "page step")
      // leave the slider: the stored value is on that position (the host's own knob position of it)
      await evaluate(`document.activeElement.blur()`)
      await until(`document.querySelectorAll('#randhist li').length === ${h0 + 1}`, "the arrow steps are in the history")
      await sleep(300) // the describe that follows paints the slider from the host's own knob position of the stored value
      await until(`Math.abs(Number(${row("Resonance")}.querySelector('input[type=range]').value) * ${K} - ${kc + 6554}) < 1.6`, "stored value at the position")
      // none of those keys reached a window handler (notes, undo, roll, the patch list)
      expect(await evaluate(`window.__keys.filter((k) => k.startsWith('Arrow') || k === 'PageUp').length`)).toBe(0)
      expect(await evaluate(`document.querySelectorAll('.keybed .down').length`)).toBe(0)
      // the arrow steps are one merged hand-edit step
      expect(await histCount()).toBe(h0 + 1)
      // a stepped slider moves by one whole value
      await fresh("VAP")
      const tune = (await (await fetch(srv.url + "/api/meta/VAP")).json()).params.find((p: any) => p.name.startsWith("Tune"))!.name
      await focus(tune)
      expect(await val(tune)).toBe("0 st")
      await press("ArrowRight")
      await until(`${row(tune)}.querySelector('.val').textContent === '1 st'`, "+1 st")
      await press("ArrowDown"); await press("ArrowDown")
      await until(`${row(tune)}.querySelector('.val').textContent === '-1 st'`, "-1 st")
      await press("ArrowRight", SHIFT)
      await until(`${row(tune)}.querySelector('.val').textContent === '9 st'`, "+10 st coarse")
      // the end of the range holds
      for (let i = 0; i < 6; i++) await press("PageUp")
      await until(`${row(tune)}.querySelector('.val').textContent === '36 st'`, "36 st")
      await press("ArrowRight")
      await sleep(200)
      expect(await val(tune)).toBe("36 st")
      await evaluate(`document.activeElement.blur()`)
    }, 60_000)

    test("arrow keys follow the readout: 1 Hz, 1 ms, 1 %, 0.1 dB and one pan step, fast presses queue, the end of the travel holds", async () => {
      const num = (t: string) => Number(/-?\d+(\.\d+)?/.exec(t)![0])
      const focus = (name: string) => evaluate(`${row(name)}.querySelector('input[type=range]').focus()`)
      const blur = () => evaluate(`document.activeElement.blur()`)
      await fresh("ACD")
      // a frequency: 400 Hz -> 401 -> 402, back to 401 and 400 (the same texts both ways)
      await focus("Cutoff")
      expect(await val("Cutoff")).toBe("400 Hz")
      const cut = (t: string) => until(`${row("Cutoff")}.querySelector('.val').textContent === '${t}'`, t)
      await press("ArrowRight"); await cut("401 Hz")
      await press("ArrowRight"); await cut("402 Hz")
      await press("ArrowLeft"); await cut("401 Hz")
      await press("ArrowLeft"); await cut("400 Hz")
      await press("ArrowLeft"); await cut("399 Hz")
      // ten presses in a row, no wait between: each one a step (they queue)
      for (let i = 0; i < 10; i++) await press("ArrowRight")
      await cut("409 Hz")
      await blur()
      // a time
      await focus("Decay")
      expect(await val("Decay")).toBe("500 ms")
      await press("ArrowRight")
      await until(`${row("Decay")}.querySelector('.val').textContent === '501 ms'`, "+1 ms")
      await press("ArrowLeft"); await press("ArrowLeft")
      await until(`${row("Decay")}.querySelector('.val').textContent === '499 ms'`, "-1 ms")
      await blur()
      // the end of the travel: nothing moves, the slider stays on its end
      await typeInto("Cutoff", "1000000 Hz")
      await until(`document.querySelectorAll('.param')[9].querySelector('.val').textContent === '20.0 kHz' || ${row("Cutoff")}.querySelector('.val').textContent.endsWith('kHz')`, "top of the range")
      const top = await val("Cutoff")
      await focus("Cutoff")
      await press("ArrowRight")
      await sleep(250)
      expect(await val("Cutoff")).toBe(top)
      expect(await slider("Cutoff")).toBe(1)
      await blur()
      // dB and pan (PERC)
      await fresh("PERC")
      const perc = (await (await fetch(srv.url + "/api/meta/PERC")).json()).params
      const eq = perc.find((p: any) => /^EQ Low/.test(p.name)).name, pan = perc.find((p: any) => /Pan$/.test(p.name)).name
      await focus(eq)
      const db0 = num(await val(eq))
      await press("ArrowRight")
      await until(`${row(eq)}.querySelector('.val').textContent === '${(db0 + 0.1).toFixed(1)} dB'`, "+0.1 dB")
      await press("ArrowRight"); await press("ArrowRight")
      await until(`${row(eq)}.querySelector('.val').textContent === '${(db0 + 0.3).toFixed(1)} dB'`, "+0.3 dB")
      await press("ArrowLeft")
      await until(`${row(eq)}.querySelector('.val').textContent === '${(db0 + 0.2).toFixed(1)} dB'`, "-0.1 dB")
      await blur()
      await focus(pan)
      const pan0 = await val(pan)
      await press("ArrowRight")
      await until(`${row(pan)}.querySelector('.val').textContent !== ${JSON.stringify(pan0)}`, "pan moved")
      const pan1 = await val(pan)
      expect(/^[LR]\d+$|^C$/.test(pan1), pan1).toBe(true)
      expect(Math.abs((pan1[0] === "L" ? -1 : pan1[0] === "R" ? 1 : 0) * (num(pan1.slice(1) || "0")) - (pan0[0] === "L" ? -1 : pan0[0] === "R" ? 1 : 0) * num(pan0.slice(1) || "0"))).toBe(1)
      await blur()
    }, 90_000)

    test("a locked parameter takes typed and arrowed values too, the lock stays", async () => {
      await fresh("ACD")
      await evaluate(`${row("Cutoff")}.querySelector('.lock').click()`)
      expect(await evaluate(`${row("Cutoff")}.classList.contains('locked')`)).toBe(true)
      try {
        await typeInto("Cutoff", "300 Hz")
        await until(`${row("Cutoff")}.querySelector('.val').textContent === '300 Hz'`, "typed on a locked parameter")
        await evaluate(`${row("Cutoff")}.querySelector('input[type=range]').focus()`)
        await press("ArrowRight", SHIFT)
        await until(`${row("Cutoff")}.querySelector('.val').textContent !== '300 Hz'`, "arrowed")
        expect(await evaluate(`${row("Cutoff")}.classList.contains('locked')`)).toBe(true)
        // Randomize still leaves it alone
        const was = await val("Cutoff")
        await evaluate(`document.activeElement.blur(); document.getElementById('randgo').click()`)
        await sleep(600)
        expect(await val("Cutoff")).toBe(was)
      } finally {
        await evaluate(`(() => { const r = ${row("Cutoff")}; if (r.classList.contains('locked')) r.querySelector('.lock').click() })()`)
        await evaluate(`(() => { const l = JSON.parse(localStorage.getItem('poly-editor.locks') || '{}'); delete l.ACD; localStorage.setItem('poly-editor.locks', JSON.stringify(l)) })()`)
      }
    }, 60_000)

    test("macros, the Delay / Reverb / Limiter sliders and the Randomizer amount take typed values and arrows too", async () => {
      await fresh("ACD")
      // macro 1: a 0..100 slider in steps of 0.5
      const macro = (n: number, expr: string) => evaluate(`(() => { const c = document.querySelectorAll('.macro')[${n}]; return ${expr} })()`)
      await macro(0, `c.querySelector('.val').click()`)
      await until(`!!document.querySelector('.macro .val input.valedit')`, "macro field")
      await cdp.send("Input.insertText", { text: "37.5" }, session); await press("Enter")
      await until(`Number(document.querySelectorAll('.macro')[0].querySelector('input[type=range]').value) === 37.5 && document.querySelectorAll('.macro')[0].querySelector('.val').textContent === '37.5 %'`, "macro typed")
      await macro(0, `c.querySelector('input[type=range]').focus()`)
      await press("ArrowRight"); await until(`Number(document.querySelectorAll('.macro')[0].querySelector('input[type=range]').value) === 38`, "macro +0.5")
      await press("ArrowRight", SHIFT); await until(`Number(document.querySelectorAll('.macro')[0].querySelector('input[type=range]').value) === 43`, "macro coarse")
      await evaluate(`document.activeElement.blur()`)
      // Delay filter: a Hz slider in steps of 100
      const fx = (key: string) => `document.querySelector('input[data-fx="${key}"]')`
      const fxVal = (key: string) => `${fx(key)}.parentElement.querySelector('.val')`
      await evaluate(`${fxVal("delay.filter")}.click()`)
      await until(`!!${fxVal("delay.filter")}.querySelector('input.valedit')`, "filter field")
      await cdp.send("Input.insertText", { text: "5 kHz" }, session); await press("Enter")
      await until(`${fx("delay.filter")}.value === '5000' && ${fxVal("delay.filter")}.textContent === '5000 Hz'`, "5 kHz")
      await evaluate(`${fx("delay.filter")}.focus()`)
      await press("ArrowLeft"); await until(`${fx("delay.filter")}.value === '4900'`, "-100 Hz")
      await press("ArrowRight", SHIFT); await until(`Number(${fx("delay.filter")}.value) > 4900 + 100`, "coarse Hz")
      // Reverb send: dB readout from a table
      await evaluate(`${fxVal("reverb.send")}.click()`)
      await until(`!!${fxVal("reverb.send")}.querySelector('input.valedit')`, "send field")
      await cdp.send("Input.insertText", { text: "-6 dB" }, session); await press("Enter")
      await until(`/^-[56]\\.\\d\\d dB$/.test(${fxVal("reverb.send")}.textContent)`, "send dB")
      // Limiter attack in seconds
      await evaluate(`${fxVal("limiter.attack")}.click()`)
      await until(`!!${fxVal("limiter.attack")}.querySelector('input.valedit')`, "attack field")
      await cdp.send("Input.insertText", { text: "250 ms" }, session); await press("Enter")
      await until(`${fx("limiter.attack")}.value === '250' && ${fxVal("limiter.attack")}.textContent === '0.250 s'`, "250 ms")
      // junk reverts
      await evaluate(`${fxVal("limiter.attack")}.click()`)
      await until(`!!${fxVal("limiter.attack")}.querySelector('input.valedit')`, "attack field again")
      await cdp.send("Input.insertText", { text: "loud" }, session); await press("Enter")
      await until(`document.getElementById('status').className === 'err'`, "error")
      expect(await evaluate(`${fxVal("limiter.attack")}.textContent`)).toBe("0.250 s")
      // Randomizer amount
      await evaluate(`document.getElementById('randamtv').click()`)
      await until(`!!document.querySelector('#randamtv input.valedit')`, "amount field")
      await cdp.send("Input.insertText", { text: "40" }, session); await press("Enter")
      await until(`document.getElementById('randamt').value === '40' && document.getElementById('randamtv').textContent === '40%'`, "amount typed")
      await evaluate(`document.getElementById('randamt').focus()`)
      await press("ArrowLeft"); await until(`document.getElementById('randamt').value === '39'`, "amount -1")
      await evaluate(`document.activeElement.blur(); (() => { const a = document.getElementById('randamt'); a.value = '100'; a.dispatchEvent(new Event('input', { bubbles: true })) })()`)
      // put the shared page's stored mixer state back: the FX values live in localStorage
      await evaluate(`(() => { const set = (k, v) => { const i = document.querySelector('input[data-fx="' + k + '"]'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })) }; set('delay.filter', 20000); set('reverb.send', 0); set('limiter.attack', 100) })()`)
    }, 90_000)

    test("every readout of every engine shows the host's text or the macro format, never a raw float (neutral bipolar macros, MIDI macro CCs)", async () => {
      if (await evaluate(`!document.getElementById('midi').disabled`)) {
        await evaluate(`document.getElementById('midi').click()`)
        await until(`document.getElementById('midistate').textContent.includes('1 of 1')`, "the MIDI device")
      }
      const engines: string[] = await evaluate(`[...document.querySelectorAll('#engines button')].map((b) => b.dataset.engine)`)
      expect(engines.length).toBeGreaterThanOrEqual(16)
      const digits = /\d+\.\d{4,}/ // more decimals than any readout format has
      const macroFormat = /^\d+(\.\d)? %$/
      const readouts = () => evaluate(`({ vals: Object.assign([], ...[...document.querySelectorAll('.param')].map((r) => ({ [r.dataset.param]: r.querySelector('.val').textContent }))), macros: [...document.querySelectorAll('.macro .mval')].map((v) => v.textContent) })`)
      let bipolarSeen = 0
      for (const name of engines) {
        await evaluate(`[...document.querySelectorAll('#engines button')].find((b) => b.dataset.engine === '${name}').click()`)
        await until(`(() => { const b = document.querySelector('#engines button.on'); return b?.dataset.engine === '${name}' && document.getElementById('status').textContent.startsWith(b.firstChild.textContent + ':') && document.querySelectorAll('.param').length > 0 })()`, name)
        const meta = await (await fetch(srv.url + "/api/meta/" + name)).json()
        // the readouts of a fresh engine: the macros rest at their neutral position (bipolar ones at CC 63 = 49.606...)
        const neutral = Array.from({ length: 6 }, (_, m) => (meta.macros[m]?.bipolar ? (63 * 100) / 127 : 0))
        await sleep(120)
        let r = await readouts()
        expect(r.macros.length).toBe(6)
        for (const t of r.macros) expect(t).toMatch(macroFormat)
        meta.macros.slice(0, 6).forEach((mac: any, m: number) => { if (mac.bipolar) { bipolarSeen++; expect(r.macros[m]).toBe("49.6 %") } })
        // the parameter readouts are the host's own text: describe gives them (and the macro "->" part) for the same macro values
        const d = await (await fetch(srv.url + "/api/describe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: name, patch: meta.init, macroValues: neutral }) })).json()
        const expected = meta.params.map((p: any, i: number) => (p.names ? "" : d.finalTexts[i] !== d.texts[i] ? `${d.texts[i]} \u2192 ${d.finalTexts[i]}` : d.texts[i]))
        const shown = r.vals.map((t: string | null, i: number) => (t === null ? null : i)).filter((i: number | null) => i !== null) as number[]
        expect(shown.length).toBeGreaterThan(5)
        expect(shown.map((i) => r.vals[i])).toEqual(shown.map((i) => expected[i]))
        for (const t of r.vals) if (t !== null) expect(t).not.toMatch(digits)
        // MIDI macro CCs land on cc * 100 / 127: odd values, 1 decimal at most on the page
        for (let m = 0; m < 6; m++) await evaluate(`window.__midi.send(0xb0, ${102 + m}, ${[63, 1, 100, 77, 31, 126][m]})`)
        await sleep(200)
        r = await readouts()
        expect(r.macros).toEqual(["49.6 %", "0.8 %", "78.7 %", "60.6 %", "24.4 %", "99.2 %"])
        for (const t of [...r.vals.filter((x: string | null) => x !== null), ...r.macros]) expect(t).not.toMatch(digits)
      }
      expect(bipolarSeen).toBeGreaterThan(0)
      // the typed field starts from the same short text
      await evaluate(`document.querySelectorAll('.macro .val')[0].click()`)
      await until(`!!document.querySelector('.macro .val input.valedit')`, "macro field")
      expect(await evaluate(`document.querySelector('.macro .val input.valedit').value`)).toBe("49.6")
      await press("Escape")
      await evaluate(`document.activeElement.blur()`)
    }, 180_000)

    test("release mode: the same readouts and arrow keys work on the release server", async () => {
      const relDir = mkdtempSync(join(tmpdir(), "poly-editor-rel-typed-"))
      const rel = await startServer({ port: 0, dir: relDir, release: true })
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" })
      const sid = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId
      const ev = async (expr: string) => {
        const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sid)
        if (r.exceptionDetails) throw new Error("page error: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
        return r.result.value
      }
      try {
        await cdp.send("Page.enable", {}, sid); await cdp.send("Runtime.enable", {}, sid)
        await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: FAKE_MIDI }, sid)
        await cdp.send("Page.navigate", { url: rel.url + "/" }, sid)
        await until0(ev, `document.querySelectorAll('.param').length > 0 && document.getElementById('status').textContent.startsWith('ACD')`)
        expect(await ev(`document.getElementById('strict')`)).toBeNull() // really the release page
        await typeInto("Cutoff", "440 Hz", "Enter", sid, ev)
        await until0(ev, `${row("Cutoff")}.querySelector('.val').textContent === '440 Hz'`)
        const k0 = Math.round(Number(await ev(`${row("Cutoff")}.querySelector('input[type=range]').value`)) * K)
        await ev(`${row("Cutoff")}.querySelector('input[type=range]').focus()`)
        await press("ArrowRight", 0, sid)
        await until0(ev, `${row("Cutoff")}.querySelector('.val').textContent === '441 Hz'`)
        expect(Math.round(Number(await ev(`${row("Cutoff")}.querySelector('input[type=range]').value`)) * K)).toBeGreaterThan(k0)
        // the endpoint exists on the release server and refuses what the page would not offer
        expect((await fetch(rel.url + "/api/typed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "NOSUCHA", param: 0, text: "1" }) })).status).toBe(400)
        expect((await fetch(rel.url + "/api/typed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "ACD", param: 9, text: "banana" }) })).status).toBe(422)
      } finally {
        await cdp.send("Target.closeTarget", { targetId }).catch(() => {})
        rel.stop(); rmSync(relDir, { recursive: true, force: true })
      }
    }, 90_000)
  })

  // ---- octave shift of the on-screen keyboard and the computer keys (Z down, X up, the buttons next to the Keyboard toggle).
  // Every test opens its own tab and clears the stored octave before and after, so the shared page and the other tests never see it.
  describe("keyboard octave", () => {
    const OCT_KEY = "poly-editor.octave"
    const RECORD = `(() => {
      window.__renders = []; window.__done = 0; window.__live = []
      const f = window.fetch; window.fetch = function (u, o) { const r = f.apply(this, arguments); try { if (String(u).includes("/api/render")) { window.__renders.push(JSON.parse(o.body).note); r.finally(() => window.__done++).catch(() => {}) } } catch {} return r }
      const s = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (m.cmd === "live.note") window.__live.push((m.on ? "on " : "off ") + m.note) } catch {} return s.apply(this, arguments) }
    })()`
    const VK: Record<string, number> = { ";": 186 }
    async function withTab(fn: (t: { ev: (e: string) => Promise<any>; wait: (e: string) => Promise<void>; down: (k: string) => Promise<void>; up: (k: string) => Promise<void>; tap: (k: string) => Promise<void>; open: (url?: string) => Promise<void> }) => Promise<void>, base = srv.url) {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" })
      const sid = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId
      const ev = async (expr: string) => {
        const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sid)
        if (r.exceptionDetails) throw new Error("page error: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
        return r.result.value
      }
      const wait = async (expr: string) => { for (let i = 0; i < 160; i++) { if (await ev(expr).catch(() => false)) return; await sleep(50) } throw new Error("timed out: " + expr) }
      const part = (k: string) => ({ key: k, code: /^[a-z]$/.test(k) ? "Key" + k.toUpperCase() : "Semicolon", windowsVirtualKeyCode: VK[k] ?? k.toUpperCase().charCodeAt(0) })
      const down = async (k: string) => { await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...part(k), text: k }, sid) }
      const up = async (k: string) => { await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...part(k) }, sid) }
      const tap = async (k: string) => { await down(k); await up(k) }
      const open = async (url = base + "/") => {
        await cdp.send("Page.navigate", { url }, sid)
        await wait(`document.querySelectorAll('#patches option').length >= 1 && !!document.getElementById('octread')`)
      }
      try {
        await cdp.send("Page.enable", {}, sid); await cdp.send("Runtime.enable", {}, sid)
        await cdp.send("Target.activateTarget", { targetId })
        await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: FAKE_MIDI + ";" + RECORD }, sid)
        await cdp.send("Page.navigate", { url: base + "/" }, sid)
        await wait(`document.querySelectorAll('#patches option').length >= 1 && !!document.getElementById('octread')`)
        await ev(`localStorage.removeItem(${JSON.stringify(OCT_KEY)})`)
        await open()
        await fn({ ev, wait, down, up, tap, open })
      } finally {
        await cdp.send("Runtime.evaluate", { expression: `localStorage.removeItem(${JSON.stringify(OCT_KEY)})` }, sid).catch(() => {})
        await cdp.send("Target.closeTarget", { targetId }).catch(() => {})
      }
    }
    const read = (ev: (e: string) => Promise<any>) => ev(`document.getElementById('octread').textContent`)
    const notes = (ev: (e: string) => Promise<any>) => ev(`[...document.querySelectorAll('#keys .key')].map((k) => Number(k.dataset.note))`)

    test("X shifts up and Z down: the computer key plays another note, the on-screen keys and the readout follow", async () => {
      await withTab(async ({ ev, wait, tap }) => {
        expect(await read(ev)).toBe("C3 - C5")
        expect((await notes(ev))[0]).toBe(48)
        await tap("a"); await wait(`window.__renders.length === 1 && window.__done === 1`)
        expect(await ev(`window.__renders`)).toEqual([60]) // the default is unchanged: a is C4
        await tap("x")
        expect(await read(ev)).toBe("C4 - C6")
        expect((await notes(ev))[0]).toBe(60)
        expect((await notes(ev)).at(-1)).toBe(84)
        expect(await ev(`document.querySelector('#keys .key.w').textContent`)).toBe("C4")
        await tap("a"); await wait(`window.__renders.length === 2 && window.__done === 2`)
        expect((await ev(`window.__renders`))[1]).toBe(72)
        await tap("z"); await tap("z")
        expect(await read(ev)).toBe("C2 - C4")
        await tap("s"); await wait(`window.__renders.length === 3 && window.__done === 3`)
        expect((await ev(`window.__renders`))[2]).toBe(50) // s is the third key of the map (D4 = 62 in the default octave), two octaves lower
        expect(await ev(`localStorage.getItem(${JSON.stringify(OCT_KEY)})`)).toBe("3") // C2 is octave 3 (0 is C-1)
        // the buttons do the same
        await ev(`document.getElementById('octup').click()`)
        expect(await read(ev)).toBe("C3 - C5")
        await ev(`document.getElementById('octdown').click()`)
        await ev(`document.getElementById('octdown').click()`)
        expect(await read(ev)).toBe("C1 - C3")
        // a click on an on-screen key plays the note it shows
        await ev(`document.querySelector('#keys .key').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
        await wait(`window.__renders.length === 4 && window.__done === 4`)
        expect((await ev(`window.__renders`))[3]).toBe(24)
      })
    }, 60_000)

    test("the octave stops at MIDI 0 and 127: the two octaves stay inside, the button is disabled at each end, Z and X do nothing there", async () => {
      await withTab(async ({ ev, wait, tap }) => {
        for (let i = 0; i < 12; i++) await tap("z")
        expect(await read(ev)).toBe("C-1 - C1")
        expect((await notes(ev))[0]).toBe(0)
        expect(await ev(`document.getElementById('octdown').disabled`)).toBe(true)
        expect(await ev(`document.getElementById('octup').disabled`)).toBe(false)
        await tap("z")
        expect(await read(ev)).toBe("C-1 - C1")
        await ev(`document.getElementById('octdown').click()`) // a disabled button does nothing
        expect(await read(ev)).toBe("C-1 - C1")
        for (let i = 0; i < 12; i++) await tap("x")
        expect(await read(ev)).toBe("C7 - C9")
        const n = await notes(ev)
        expect(n[0]).toBe(96); expect(n.at(-1)).toBe(120)
        expect(await ev(`document.getElementById('octup').disabled`)).toBe(true)
        expect(await ev(`document.getElementById('octdown').disabled`)).toBe(false)
        await tap("x")
        expect(await read(ev)).toBe("C7 - C9")
        // the highest computer key (;) is still a legal note
        await tap(";"); await wait(`window.__renders.length === 1 && window.__done === 1`)
        expect(await ev(`window.__renders`)).toEqual([124])
        expect(await ev(`localStorage.getItem(${JSON.stringify(OCT_KEY)})`)).toBe("8")
        await tap("z")
        expect(await read(ev)).toBe("C6 - C8")
      })
    }, 60_000)

    test("a key held while the octave shifts gets the note-off of the note it started, MIDI is not shifted and still lights the right key", async () => {
      await withTab(async ({ ev, wait, down, up, tap }) => {
        await ev(`document.getElementById('midi').click()`) // MIDI on also starts live audio
        await wait(`document.getElementById('midistate').textContent.includes('1 of 1') && document.getElementById('livebtn').textContent === 'Live audio: on'`)
        await wait(`window.__live.length === 0 || true`)
        await ev(`window.__live.length = 0`)
        await down("a")
        await wait(`window.__live.includes('on 60')`)
        expect(await ev(`document.querySelector('#keys .key[data-note="60"]').classList.contains('down')`)).toBe(true)
        await tap("x") // the held key moves out of the lowest octave
        await down("w") // a second key while shifted: C#5 = 73
        await up("a")
        await wait(`window.__live.includes('off 60')`)
        await up("w")
        await wait(`window.__live.includes('off 73')`)
        expect(await ev(`window.__live`)).toEqual(["on 60", "on 73", "off 60", "off 73"])
        expect(await ev(`document.querySelectorAll('#keys .key.down').length`)).toBe(0)
        // shift down while holding, release the key: the note that was started is the one released
        await ev(`window.__live.length = 0`)
        await down("d") // E5 = 76
        await tap("z"); await tap("z")
        await up("d")
        await wait(`window.__live.length === 2`)
        expect(await ev(`window.__live`)).toEqual(["on 76", "off 76"])
        // MIDI: the note numbers are sent as played, whatever the octave
        await ev(`window.__live.length = 0`)
        await ev(`window.__midi.send(0xb0, 123, 0)`)
        expect(await read(ev)).toBe("C2 - C4")
        await ev(`window.__midi.send(0x90, 40, 100)`)  // E2: the third white key... in range now
        await wait(`window.__live.includes('on 40')`)
        expect(await ev(`document.querySelector('#keys .key[data-note="40"]').classList.contains('down')`)).toBe(true)
        await ev(`window.__midi.send(0x90, 100, 100)`) // out of the visible range: sounds, lights nothing
        await wait(`window.__live.includes('on 100')`)
        expect(await ev(`document.querySelectorAll('#keys .key.down').length`)).toBe(1)
        // shifting keeps the lit state of a held MIDI note: it follows the key that now shows it, or goes dark when it is out of range
        await tap("x") // C3 - C5 (48 .. 72): 40 is out of range
        expect(await ev(`document.querySelectorAll('#keys .key.down').length`)).toBe(0)
        await tap("z") // back to 36 .. 60: 40 is lit again, on the right key
        expect(await ev(`[...document.querySelectorAll('#keys .key.down')].map((k) => k.dataset.note).join()`)).toBe("40")
        await ev(`window.__midi.send(0x80, 40, 0); window.__midi.send(0x80, 100, 0)`)
        await wait(`window.__live.includes('off 40') && window.__live.includes('off 100')`)
        expect(await ev(`document.querySelectorAll('#keys .key.down').length`)).toBe(0)
        await wait(`!document.getElementById('voices').textContent.includes('held')`) // the label follows the next block the host sends, not the note-off itself
        expect(await ev(`document.getElementById('voices').textContent.includes('held')`)).toBe(false)
      })
    }, 60_000)

    test("the computer keys play with the focus on a slider, a select, a checkbox, a button or a readout, and not in a text field", async () => {
      await withTab(async ({ ev, wait, tap }) => {
        // every time an on-screen key lights up (a render is cached after the first identical note, a key light is not)
        await ev(`window.__lit = []; new MutationObserver((ms) => { for (const m of ms) if (m.target.classList.contains('down')) window.__lit.push(Number(m.target.dataset.note)) }).observe(document.getElementById('keys'), { subtree: true, attributes: true, attributeFilter: ['class'] })`)
        let count = 0
        const expectPlays = async (what: string) => {
          count++
          await wait(`!document.querySelector('#keys .key.down')`)
          await tap("a")
          await wait(`window.__lit.length === ${count}`).catch(() => { throw new Error("no note with the focus on " + what) })
          expect((await ev(`window.__lit`)).at(-1)).toBe(60)
        }
        const focus = (expr: string) => ev(`(() => { const e = ${expr}; e.focus(); return document.activeElement === e })()`)
        // a parameter slider: the note plays, and the arrow keys still step it
        expect(await focus(`document.querySelector('.param input[type=range]')`)).toBe(true)
        await expectPlays("a slider")
        const slider = `document.querySelector('.param input[type=range]')`
        const before = await ev(`Number(${slider}.value)`)
        await ev(`${slider}.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true, cancelable: true }))`)
        await wait(`Number(${slider}.value) !== ${before}`)
        await expectPlays("a slider after an arrow key")
        // a select: the letter plays and does not jump to an option that starts with it
        expect(await focus(`document.querySelector('.param select') ?? document.getElementById('poly')`)).toBe(true)
        const chosen = await ev(`document.activeElement.value`)
        await expectPlays("a select")
        expect(await ev(`document.activeElement.value`)).toBe(chosen)
        expect(await focus(`document.getElementById('poly')`)).toBe(true)
        await expectPlays("the polyphony select")
        expect(await focus(`document.getElementById('randmacros')`)).toBe(true)
        await expectPlays("a checkbox")
        expect(await focus(`document.getElementById('kbtoggle')`)).toBe(true)
        await expectPlays("a button")
        expect(await focus(`document.querySelector('.param .val')`)).toBe(true)
        await expectPlays("a readout")
        expect(await focus(`document.querySelector('.macro input[type=range]')`)).toBe(true)
        await expectPlays("a macro slider")
        // a text field keeps the letters
        expect(await focus(`document.getElementById('randseed')`)).toBe(true)
        await tap("a"); await sleep(250)
        expect(await ev(`window.__lit.length`)).toBe(count)
        expect(await ev(`document.getElementById('randseed').value`)).toBe("a")
        await ev(`document.getElementById('randseed').value = ''; document.activeElement.blur()`)
        await expectPlays("nothing")
      })
    }, 60_000)
    test("a readout field gives the focus back on Enter, on Escape and on a click elsewhere, and the keys play again", async () => {
      await withTab(async ({ ev, wait, tap }) => {
        await ev(`window.__lit = []; new MutationObserver((ms) => { for (const m of ms) if (m.target.classList.contains('down')) window.__lit.push(Number(m.target.dataset.note)) }).observe(document.getElementById('keys'), { subtree: true, attributes: true, attributeFilter: ['class'] })`)
        const openField = async () => {
          await ev(`document.querySelector('.param .val').click()`)
          await wait(`document.activeElement?.classList.contains('valedit')`)
        }
        const key = (k: string) => ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`)
        const playsNow = async (count: number) => { await wait(`!document.querySelector('#keys .key.down')`); await tap("a"); await wait(`window.__lit.length === ${count}`) }
        // typing in the open field is text, not notes
        await openField()
        await tap("a"); await sleep(250)
        expect(await ev(`window.__lit.length`)).toBe(0)
        expect(await ev(`document.activeElement.value.endsWith('a')`)).toBe(true)
        await key("Escape")
        expect(await ev(`document.activeElement === document.body`)).toBe(true)
        await playsNow(1)
        await openField()
        await key("Enter")
        expect(await ev(`document.activeElement === document.body`)).toBe(true)
        await playsNow(2)
        // a click elsewhere: the page's blur closes the field
        await openField()
        await ev(`document.getElementById('engname').click(); document.activeElement.blur()`)
        expect(await ev(`!!document.querySelector('.val input.valedit')`)).toBe(false)
        await playsNow(3)
      })
    }, 60_000)
    test("typing Z or X in the Seed field (or any text field) does not shift", async () => {
      await withTab(async ({ ev, tap }) => {
        await ev(`(() => { const e = document.getElementById('randseed'); e.focus(); e.select(); return document.activeElement === e })()`)
        await tap("z"); await tap("x"); await tap("z")
        expect(await ev(`document.getElementById('randseed').value`)).toBe("zxz")
        expect(await read(ev)).toBe("C3 - C5")
        expect(await ev(`localStorage.getItem(${JSON.stringify(OCT_KEY)})`)).toBeNull()
        await ev(`document.activeElement.blur()`)
        await tap("x")
        expect(await read(ev)).toBe("C4 - C6") // outside the field the same key shifts
      })
    }, 60_000)

    test("the octave is remembered after a reload, a bad stored value falls back to C3", async () => {
      await withTab(async ({ ev, wait, tap, open }) => {
        await tap("x"); await tap("x")
        expect(await ev(`localStorage.getItem(${JSON.stringify(OCT_KEY)})`)).toBe("6")
        await open()
        expect(await read(ev)).toBe("C5 - C7")
        expect((await notes(ev))[0]).toBe(72)
        await tap("a"); await wait(`window.__renders.length === 1 && window.__done === 1`)
        expect(await ev(`window.__renders`)).toEqual([84])
        for (const bad of ["9", "-1", "abc", "4.5", ""]) {
          await ev(`localStorage.setItem(${JSON.stringify(OCT_KEY)}, ${JSON.stringify(bad)})`)
          await open()
          expect(await read(ev)).toBe("C3 - C5")
        }
        await ev(`localStorage.setItem(${JSON.stringify(OCT_KEY)}, "8")`)
        await open()
        expect(await read(ev)).toBe("C7 - C9")
        expect(await ev(`document.getElementById('octup').disabled`)).toBe(true)
      })
    }, 90_000)

    test("release mode page has the octave buttons and shortcuts too", async () => {
      const relDir = mkdtempSync(join(tmpdir(), "poly-editor-rel-oct-"))
      const rel = await startServer({ port: 0, dir: relDir, release: true })
      try {
        await withTab(async ({ ev, wait, tap }) => {
          expect(await ev(`document.getElementById('strict')`)).toBeNull() // really the release page
          expect(await read(ev)).toBe("C3 - C5")
          await tap("x")
          expect(await read(ev)).toBe("C4 - C6")
          await ev(`document.getElementById('octdown').click()`)
          await ev(`document.getElementById('octdown').click()`)
          expect(await read(ev)).toBe("C2 - C4")
          await tap("a"); await wait(`window.__renders.length === 1 && window.__done === 1`)
          expect(await ev(`window.__renders`)).toEqual([48])
        }, rel.url)
      } finally { rel.stop(); rmSync(relDir, { recursive: true, force: true }) }
    }, 60_000)
  })

  describe("randomizer", () => {
    const rows = (): Promise<string[]> => evaluate(`[...document.querySelectorAll('.param')].map((r) => r.querySelector('input:not(.lock), select').value)`)
    const names = (): Promise<string[]> => evaluate(`[...document.querySelectorAll('.param')].map((r) => r.querySelector('.pname').textContent)`)
    const diffIdx = (a: string[], b: string[]) => a.map((v, i) => (v !== b[i] ? i : -1)).filter((i) => i >= 0)
    const click = (id: string) => evaluate(`document.getElementById('${id}').click()`)
    const setSeed = (v: string) => evaluate(`(() => { const e = document.getElementById('randseed'); e.value = ${JSON.stringify(v)}; return true })()`)
    const setAmount = (v: number) => evaluate(`(() => { const e = document.getElementById('randamt'); e.value = ${v}; e.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    const steps = () => evaluate(`document.getElementById('randundo').title`)
    const key = async (k: string, modifiers = 0) => {
      const code = k.length === 1 ? "Key" + k.toUpperCase() : k
      const base = { key: k, code, modifiers, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0 }
      await cdp.send("Input.dispatchKeyEvent", { type: modifiers ? "rawKeyDown" : "keyDown", ...base, text: modifiers ? undefined : k }, session)
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, session)
    }
    const roll = async (seed: string) => {
      const before = await evaluate(`document.getElementById('randundo').title`)
      await setSeed(seed); await click("randgo")
      await until(`document.getElementById('randundo').title !== ${JSON.stringify(before)}`, "the roll")
      await until(`document.getElementById('randlast').textContent === 'seed ${sc(seed)}'`, "the seed shown")
      await sleep(150)
    }
    const reset = async () => {
      await evaluate(`localStorage.removeItem('poly-editor.locks'); localStorage.removeItem('poly-editor.rand')`)
      await setAmount(100)
      await evaluate(`(() => { const c = document.getElementById('randmacros'); c.checked = false; c.dispatchEvent(new Event('change')) })()`)
      await click("init"); await until(`document.getElementById('status').textContent === 'Init patch'`, "Init")
      await evaluate(`document.getElementById('engines').querySelector('[data-engine=FAT]').click()`)
      await until(`document.querySelector('#engines button.on')?.dataset.engine === 'FAT' && document.querySelectorAll('.param').length === 25`, "FAT")
      await evaluate(`document.getElementById('engines').querySelector('[data-engine=ACD]').click()`)
      await until(`document.querySelector('#engines button.on')?.dataset.engine === 'ACD' && document.querySelectorAll('.param').length === 29`, "ACD again")
      await evaluate(`document.getElementById('randseed').value = ''; document.activeElement.blur()`)
    }

    test("the panel: Randomize, Amount, Seed, one toggle per engine section, a padlock on every parameter", async () => {
      await reset()
      expect(await evaluate(`document.getElementById('randgo').textContent`)).toContain("Randomize")
      expect(await evaluate(`document.getElementById('randamt').value`)).toBe("100")
      expect(await evaluate(`[...document.querySelectorAll('#randsecs input')].map((c) => c.dataset.section).join('|')`)).toBe("Oscillator|Filter|Amp Envelope|Envelope|LFO|Voice")
      expect(await evaluate(`document.querySelectorAll('.param .lock').length`)).toBe(29)
      expect(await evaluate(`document.getElementById('randundo').disabled`)).toBe(true)
      expect(await evaluate(`document.getElementById('randmacros').checked`)).toBe(false) // macros are off by default
    })

    test("Randomize changes parameters but not Volume, marks the patch dirty, the seed is shown, Undo restores and Redo repeats it", async () => {
      await reset()
      const ns = await names(), start = await rows()
      const vol = ns.indexOf("Volume")
      await roll("42")
      const rolled = await rows()
      const changed = diffIdx(start, rolled)
      expect(changed.length).toBeGreaterThan(10)
      expect(changed).not.toContain(vol)
      expect(rolled[vol]).toBe(start[vol])
      expect(await evaluate(`document.getElementById('randlast').dataset.seed`)).toBe(sc(42))
      // the patch is dirty (the flag the unsaved-edits confirm reads)
      expect(await evaluate(`document.getElementById('dirtymark').textContent`)).toBe("unsaved edits")
      // undo puts every control back
      await click("randundo")
      await until(`document.getElementById('status').textContent === 'Undid a randomize'`, "undo")
      await sleep(100)
      expect(await rows()).toEqual(start)
      expect(await evaluate(`document.getElementById('randundo').disabled`)).toBe(true)
      expect(await evaluate(`document.getElementById('randredo').disabled`)).toBe(false)
      // the patch was clean before the roll, so it is clean again
      expect(await evaluate(`document.getElementById('dirtymark').textContent`)).toBe("")
      // the same seed from the same patch gives the same result
      await roll("42")
      expect(await rows()).toEqual(rolled)
      await click("randundo"); await sleep(150)
      await click("randredo"); await until(`document.getElementById('status').textContent === 'Redid a randomize'`, "redo"); await sleep(100)
      expect(await rows()).toEqual(rolled)
      await roll("43")
      expect(await rows()).not.toEqual(rolled)
    }, 60_000)

    test("a locked parameter stays (click the padlock or Alt-click the row), locks are remembered per engine in the browser", async () => {
      await reset()
      const ns = await names(), start = await rows()
      const cut = ns.indexOf("Cutoff"), res = ns.indexOf("Resonance")
      await evaluate(`document.querySelectorAll('.param')[${cut}].querySelector('.lock').click()`)
      // Alt-click on the row (a real mouse event with the modifier)
      const box = await evaluate(`(() => { const n = document.querySelectorAll('.param')[${res}].querySelector('.pname'); n.scrollIntoView({ block: 'end' }); const r = n.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box[0], y: box[1], button: "left", clickCount: 1, modifiers: 1 }, session)
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box[0], y: box[1], button: "left", clickCount: 1, modifiers: 1 }, session)
      await until(`document.querySelectorAll('.param.locked').length === 2`, "two padlocks")
      expect(await evaluate(`document.getElementById('randlocks').textContent`)).toBe("2 locked")
      expect(JSON.parse(await evaluate(`localStorage.getItem('poly-editor.locks')`))).toEqual({ ACD: [cut, res].sort((a, b) => a - b) })
      for (const seed of ["1", "2", "3"]) { await roll(seed); const now = await rows(); expect(now[cut]).toBe(start[cut]); expect(now[res]).toBe(start[res]); await click("randundo"); await sleep(100) }
      // another engine has its own (empty) locks, ACD gets them back
      await evaluate(`document.getElementById('engines').querySelector('[data-engine=FAT]').click()`)
      await until(`document.querySelectorAll('.param').length === 25 && document.querySelectorAll('.param.locked').length === 0`, "FAT without locks")
      await evaluate(`document.getElementById('engines').querySelector('[data-engine=ACD]').click()`)
      await until(`document.querySelectorAll('.param').length === 29 && document.querySelectorAll('.param.locked').length === 2`, "ACD locks back")
      await click("randunlock")
      expect(await evaluate(`document.querySelectorAll('.param.locked').length`)).toBe(0)
    }, 60_000)

    test("Alt+Shift-click on a parameter solos it: every other parameter locked, again restores, no history step", async () => {
      await reset()
      const ns = await names()
      const cut = ns.indexOf("Cutoff"), res = ns.indexOf("Resonance"), n = ns.length
      const shiftAlt = async (idx: number) => {
        // a real mouse event with Alt+Shift (CDP modifiers: Alt 1, Shift 8)
        const box = await evaluate(`(() => { const n = document.querySelectorAll('.param')[${idx}].querySelector('.pname'); n.scrollIntoView({ block: 'end' }); const r = n.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box[0], y: box[1], button: "left", clickCount: 1, modifiers: 9 }, session)
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box[0], y: box[1], button: "left", clickCount: 1, modifiers: 9 }, session)
      }
      const stepsBefore = await evaluate(`document.querySelectorAll('#randhist li').length`)
      await shiftAlt(cut)
      await until(`document.querySelectorAll('.param.locked').length === ${n - 1}`, "all but one locked")
      expect(await evaluate(`document.querySelectorAll('.param')[${cut}].classList.contains('locked')`)).toBe(false)
      expect(await evaluate(`document.getElementById('randlocks').textContent`)).toBe(`${n - 1} locked`)
      expect(JSON.parse(await evaluate(`localStorage.getItem('poly-editor.locks')`)).ACD).not.toContain(cut)
      // lock changes are not history steps
      expect(await evaluate(`document.querySelectorAll('#randhist li').length`)).toBe(stepsBefore)
      expect(await evaluate(`document.getElementById('randundo').disabled`)).toBe(true)
      // a roll moves nothing but the free parameter
      const start = await rows()
      await roll("7")
      expect(diffIdx(start, await rows()).filter((i) => i !== cut)).toEqual([])
      await click("randundo"); await sleep(100)
      // Alt+Shift on another parameter solos that one instead
      await shiftAlt(res)
      await until(`!document.querySelectorAll('.param')[${res}].classList.contains('locked') && document.querySelectorAll('.param')[${cut}].classList.contains('locked')`, "solo moved to Resonance")
      expect(await evaluate(`document.querySelectorAll('.param.locked').length`)).toBe(n - 1)
      // again on the only free one: unlock all
      await shiftAlt(res)
      await until(`document.querySelectorAll('.param.locked').length === 0`, "restored")
      expect(await evaluate(`localStorage.getItem('poly-editor.locks')`)).not.toContain("ACD")
    }, 60_000)

    test("sections: only the ticked ones are randomized", async () => {
      await reset()
      const start = await rows()
      const secOf: string[] = await evaluate(`[...document.querySelectorAll('.section')].flatMap((s) => [...s.querySelectorAll('.param')].map(() => s.querySelector('h2').textContent))`)
      await evaluate(`[...document.querySelectorAll('#randsecs input')].forEach((c) => { c.checked = c.dataset.section === 'Filter'; c.dispatchEvent(new Event('change')) })`)
      await roll("5")
      const changed = diffIdx(start, await rows())
      expect(changed.length).toBeGreaterThan(0)
      expect(new Set(changed.map((i) => secOf[i]))).toEqual(new Set(["Filter"]))
      await click("randundo"); await sleep(100)
      await evaluate(`[...document.querySelectorAll('#randsecs input')].forEach((c) => { c.checked = false; c.dispatchEvent(new Event('change')) })`)
      await click("randgo")
      await until(`document.getElementById('status').textContent.startsWith('Nothing to randomize')`, "nothing to do")
      expect(await rows()).toEqual(start)
    }, 60_000)

    test("Amount 0 changes nothing, a small Amount stays near, macros only move with their toggle", async () => {
      await reset()
      const start = await rows()
      await setAmount(0); await click("randgo")
      await until(`document.getElementById('status').textContent.startsWith('Amount is 0%')`, "amount 0")
      expect(await rows()).toEqual(start)
      expect(await evaluate(`document.getElementById('randundo').disabled`)).toBe(true)
      expect(JSON.parse(await evaluate(`localStorage.getItem('poly-editor.rand')`)).amount).toBe(0)
      await setAmount(5); await roll("9")
      const now = await rows()
      const knobMoves = diffIdx(start, now).filter((i) => !Number.isInteger(Number(start[i])) || start[i].includes("."))
      expect(knobMoves.length).toBeGreaterThan(5)
      for (const i of knobMoves) expect(Math.abs(Number(now[i]) - Number(start[i]))).toBeLessThanOrEqual(0.05 + 1e-6) // 5% of the knob (the sliders are knob positions 0..1)
      await click("randundo"); await sleep(100)
      // macros
      await setAmount(100)
      const targets = () => evaluate(`[...document.querySelectorAll('.macro .targets')].map((t) => t.textContent).join('|')`)
      const t0 = await targets()
      await roll("11")
      expect(await targets()).toBe(t0)
      await click("randundo"); await sleep(100)
      await evaluate(`(() => { const c = document.getElementById('randmacros'); c.checked = true; c.dispatchEvent(new Event('change')) })()`)
      await roll("12")
      expect(await targets()).not.toBe(t0)
      await click("randundo"); await sleep(100)
      expect(await targets()).toBe(t0)
    }, 60_000)

    test("keys: R rolls, Ctrl+Z undoes, Ctrl+Shift+Z redoes, nothing fires while a text field has the focus", async () => {
      await reset()
      const start = await rows()
      await evaluate(`document.activeElement.blur(); window.focus()`)
      await key("r")
      await until(`!document.getElementById('randundo').disabled`, "R rolled")
      const rolled = await rows()
      expect(rolled).not.toEqual(start)
      await key("z", 2) // Ctrl+Z
      await until(`document.getElementById('randundo').disabled`, "Ctrl+Z undid it")
      await sleep(100)
      expect(await rows()).toEqual(start)
      await key("z", 2 | 8) // Ctrl+Shift+Z
      await until(`!document.getElementById('randundo').disabled`, "Ctrl+Shift+Z redid it")
      await key("z", 4) // Cmd+Z
      await until(`document.getElementById('randundo').disabled`, "Cmd+Z undid it")
      // typing in the seed field: r is a letter there
      await evaluate(`document.getElementById('randseed').focus()`)
      await key("r")
      await sleep(300)
      expect(await evaluate(`document.getElementById('randseed').value`)).toBe("r")
      expect(await evaluate(`document.getElementById('randundo').disabled`)).toBe(true)
      expect(await rows()).toEqual(start)
      // a slider with the focus is not typing: R still rolls
      await evaluate(`document.getElementById('randseed').value = ''; document.querySelector('.param input[type=range]').focus()`)
      await key("r")
      await until(`!document.getElementById('randundo').disabled`, "R rolled with a slider focused")
      await click("randundo"); await sleep(100)
    }, 60_000)

    test("Undo and Redo keep at least 20 steps", async () => {
      await reset()
      const start = await rows()
      for (let i = 1; i <= 22; i++) { await setSeed(String(100 + i)); await click("randgo"); await until(`document.getElementById('randlast').textContent === 'seed ${sc(100 + i)}'`, "roll " + i); await sleep(40) }
      await until(`document.getElementById('randundo').title.includes('22 step')`, "22 steps kept")
      for (let i = 0; i < 22; i++) await click("randundo")
      await until(`document.getElementById('randundo').disabled`, "all undone")
      await sleep(150)
      expect(await rows()).toEqual(start) // 22 rolls back to the patch before the first
    }, 120_000)

    test("live audio picks the change up at once through live.patch, a silent result is kept with a hint", async () => {
      await reset()
      expect(await evaluate(`document.getElementById('livebtn').textContent`)).toBe("Live audio: on") // switched on by the MIDI test above
      await evaluate(`window.__sent = []; if (!window.__wrapped) { window.__wrapped = true; const s = WebSocket.prototype.send; WebSocket.prototype.send = function (m) { try { window.__sent.push(JSON.parse(m).cmd) } catch {} return s.call(this, m) } }`)
      await roll("77")
      expect(await evaluate(`window.__sent.filter((c) => c === 'live.patch').length`)).toBeGreaterThanOrEqual(1)
      await click("randundo"); await sleep(100)
      expect(await evaluate(`window.__sent.filter((c) => c === 'live.patch').length`)).toBeGreaterThanOrEqual(2) // undo swaps the patch too
      // Volume 0 is never randomized: every result is silent, it is kept and a hint says so (no retry loop)
      const ns = await names()
      await evaluate(`(() => { const r = document.querySelectorAll('.param')[${ns.indexOf("Volume")}].querySelector('input'); r.value = 0; r.dispatchEvent(new Event('input', { bubbles: true })) })()`)
      await sleep(300)
      const before = await rows()
      await roll("78")
      await until(`document.getElementById('randhint').textContent.includes('silent')`, "the silence hint")
      expect(await rows()).not.toEqual(before) // kept
      await roll("79") // and the next roll clears the hint
      await until(`document.getElementById('randhint').textContent.includes('silent')`, "silent again")
    }, 60_000)

    // ---- history panel, seed restore, recipes
    const hist = () => evaluate(`[...document.querySelectorAll('#randhist li')].map((li) => ({ text: li.textContent, cur: li.classList.contains('cur'), fwd: li.classList.contains('fwd') }))`) as Promise<{ text: string; cur: boolean; fwd: boolean }[]>
    const field = (id: string) => evaluate(`document.getElementById('${id}').value`)
    const text = (id: string) => evaluate(`document.getElementById('${id}').textContent`)
    const checked = (sel: string) => evaluate(`[...document.querySelectorAll('${sel}')].map((c) => c.checked)`)
    const clickEntry = (i: number) => evaluate(`document.querySelectorAll('#randhist li button')[${i}].click()`)
    const lockRow = (i: number) => evaluate(`document.querySelectorAll('.param .lock')[${i}].click()`)
    const setMacros = (on: boolean) => evaluate(`(() => { const c = document.getElementById('randmacros'); c.checked = ${on}; c.dispatchEvent(new Event('change')) })()`)
    const onlySection = (name: string) => evaluate(`[...document.querySelectorAll('#randsecs input')].forEach((c) => { c.checked = c.dataset.section === ${JSON.stringify(name)}; c.dispatchEvent(new Event('change')) })`)
    const allSections = () => evaluate(`[...document.querySelectorAll('#randsecs input')].forEach((c) => { c.checked = true; c.dispatchEvent(new Event('change')) })`)
    const settle = async () => { await sleep(250) }

    test("undo and redo put the seed field, the last seed, Amount, sections, locks and Macros back to what the step used", async () => {
      await reset()
      await roll("11") // 100%, every section, no lock, no macros
      await setAmount(40); await setMacros(true); await onlySection("Filter"); await lockRow(0)
      await roll("22")
      expect(await field("randseed")).toBe("22") // what was typed stays until a step is restored
      await setSeed("999"); await setAmount(10); await setMacros(false); await allSections() // the panel wanders off
      await click("randundo"); await settle()
      expect(await field("randseed")).toBe(sc(11))
      expect(await text("randlast")).toBe(`seed ${sc(11)}`)
      expect(await field("randamt")).toBe("100")
      expect(await text("randamtv")).toBe("100%")
      expect(await evaluate(`document.getElementById('randmacros').checked`)).toBe(false)
      expect(await checked("#randsecs input")).toEqual([true, true, true, true, true, true])
      expect(await text("randlocks")).toBe("") // the lock of the second roll is not part of the first
      await click("randundo"); await settle() // the base: no roll made this state
      expect(await field("randseed")).toBe("")
      expect(await text("randlast")).toBe("")
      await click("randredo"); await settle()
      expect(await field("randseed")).toBe(sc(11))
      await click("randredo"); await settle()
      expect(await field("randseed")).toBe(sc(22))
      expect(await text("randlast")).toBe(`seed ${sc(22)}`)
      expect(await field("randamt")).toBe("40")
      expect(await evaluate(`document.getElementById('randmacros').checked`)).toBe(true)
      expect(await checked("#randsecs input")).toEqual([false, true, false, false, false, false])
      expect(await text("randlocks")).toBe("1 locked")
      // rolling again from a step reproduces the step after it
      await click("randundo"); await settle()
      const at11 = await rows()
      await setSeed("22"); await setAmount(40); await setMacros(true); await onlySection("Filter")
      await click("randgo"); await until(`document.getElementById('randundo').title.includes('2 step')`, "rolled again"); await settle()
      const again = await rows()
      await click("randundo"); await settle()
      expect(await rows()).toEqual(at11)
      await click("randredo"); await settle()
      expect(await rows()).toEqual(again)
      await click("randunlock"); await allSections(); await setMacros(false); await setAmount(100)
    }, 90_000)

    test("history panel: base and every roll listed, the current step is highlighted, a click jumps like repeated undo or redo", async () => {
      await reset()
      let h = await hist()
      expect(h.map((e) => e.text)).toEqual(["baseInit"])
      expect(h[0].cur).toBe(true)
      const states: string[][] = [await rows()]
      await evaluate(`window.__sent = []; if (!window.__wrapped) { window.__wrapped = true; const s = WebSocket.prototype.send; WebSocket.prototype.send = function (m) { try { window.__sent.push(JSON.parse(m).cmd) } catch {} return s.call(this, m) } }`)
      for (const [seed, amount] of [["301", 100], ["302", 50], ["303", 25], ["304", 100]] as const) {
        await setAmount(amount); await roll(seed); states.push(await rows())
      }
      h = await hist()
      expect(h.length).toBe(5)
      expect(h.map((e) => e.cur)).toEqual([false, false, false, false, true])
      expect(h[1].text).toContain(`seed ${sc(301)}`)
      expect(h[1].text).toContain("100%")
      expect(h[1].text).toContain("all sections")
      expect(h[2].text).toContain(`seed ${sc(302)} · 50%`)
      expect(h[3].text).toContain("25%")
      // a jump back = the same number of undos
      await evaluate(`window.__sent = []`)
      await clickEntry(1); await until(`document.querySelectorAll('#randhist li')[1].classList.contains('cur')`, "jump to #1"); await settle()
      expect(await rows()).toEqual(states[1])
      expect(await evaluate(`window.__sent.filter((c) => c === 'live.patch').length`)).toBeGreaterThanOrEqual(1) // live gets the patch
      expect(await evaluate(`document.getElementById('dirtymark').textContent`)).toBe("unsaved edits")
      expect(await field("randseed")).toBe(sc(301))
      h = await hist()
      expect(h.map((e) => e.cur)).toEqual([false, true, false, false, false])
      expect(h.map((e) => e.fwd)).toEqual([false, false, true, true, true])
      await clickEntry(4); await until(`document.querySelectorAll('#randhist li')[4].classList.contains('cur')`, "jump forward"); await settle()
      expect(await rows()).toEqual(states[4]) // forward jump = redos
      for (let i = 0; i < 3; i++) { await click("randundo"); await settle() }
      expect(await rows()).toEqual(states[1])
      expect(await field("randseed")).toBe(sc(301)) // seed and settings are the same however you got there
      await clickEntry(0); await settle()
      expect(await rows()).toEqual(states[0])
      expect(await evaluate(`document.getElementById('dirtymark').textContent`)).toBe("") // the base is clean
      expect(await field("randseed")).toBe("")
      expect(await evaluate(`document.getElementById('randundo').disabled`)).toBe(true)
      // keys still work, and rolling from a middle step drops the forward tail
      await clickEntry(2); await settle()
      await key("z", 4) // Ctrl+Z
      await until(`document.querySelectorAll('#randhist li')[1].classList.contains('cur')`, "Ctrl+Z moved the highlight")
      await setAmount(100); await roll("305")
      h = await hist()
      expect(h.length).toBe(3)
      expect(h[2].cur).toBe(true)
      expect(h[2].text).toContain(`seed ${sc(305)}`)
      expect(await evaluate(`document.getElementById('randredo').disabled`)).toBe(true)
    }, 120_000)

    test("the Seed field: a seed code in any case with or without hyphens, a number and a text all roll, a mistyped code is refused with a message", async () => {
      await reset()
      const code = formatSeed(0x0123456789abcdefn, 2)
      const shown = (c: string) => until(`document.getElementById('randlast').textContent === ${JSON.stringify("seed " + c)}`, "the seed " + c)
      await setSeed(code.toLowerCase().replace(/-/g, "")); await click("randgo"); await shown(code)
      await settle()
      const a = await rows()
      await click("randundo"); await settle()
      await setSeed(code); await click("randgo"); await shown(code); await settle()
      expect(await rows()).toEqual(a) // the same seed, however it was typed
      await click("randundo"); await settle()
      await setSeed("hello world"); await click("randgo")
      await shown(formatSeed(fnv1a64("hello world"), 2)) // a text is hashed
      await settle()
      await click("randundo"); await settle()
      const before = (await hist()).length
      await setSeed(code.slice(0, 5) + (code[5] === "A" ? "B" : "A") + code.slice(6)); await click("randgo")
      await until(`document.getElementById('status').textContent.includes('check symbol')`, "the typo message")
      expect(await evaluate(`document.getElementById('status').className`)).toContain("err")
      expect((await hist()).length).toBe(before) // nothing was rolled
      await setSeed(formatSeed(code.length ? 5n : 0n, 9)); await click("randgo") // an algorithm this editor does not have
      await until(`document.getElementById('status').textContent.includes('algorithm 9')`, "the unknown algorithm message")
      expect((await hist()).length).toBe(before)
      await setSeed("")
    }, 90_000)

    // Bug report: "randomize is not working when I put something to SEED". Typed with real key events (focus in the field, Enter or the button).
    // Cause: the roll worked, but rolling the SAME seed again on the patch it produced lands on the same values (at Amount 100% on the same
    // targets), so nothing visibly moved, while the status said "Randomized N parameters". Now the panel says "Same seed, same result" and the
    // no-op stays out of the history. A refused seed (bad check symbol) is shown next to the field, not only in the status line.
    describe("typing something into Seed", () => {
      const named = async (k: string, vk: number, text?: string) => { // a key without a character of its own (Backspace, Enter)
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) }, session)
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: vk }, session)
      }
      const typeSeed = async (text: string) => {
        await evaluate(`(() => { const e = document.getElementById('randseed'); e.focus(); e.select(); return document.activeElement === e })()`)
        await named("Backspace", 8)
        await cdp.send("Input.insertText", { text }, session)
        expect(await evaluate(`document.getElementById('randseed').value`)).toBe(text)
      }
      const hint = () => evaluate(`document.getElementById('randhint').textContent`)
      const code = formatSeed(0x0123456789abcdefn, 2)
      const kinds: [string, string, string][] = [
        ["a plain number", "42", sc(42)],
        ["a word", "banana", formatSeed(fnv1a64("banana"), 2)],
        ["a valid base32 seed code", code, code],
        ["the same code in lower case without hyphens", code.toLowerCase().replace(/-/g, ""), code],
      ]
      for (const [what, text, shown] of kinds) {
        test(`${what} (${JSON.stringify(text)}): the Roll button changes the patch, the same seed again says so instead of doing nothing`, async () => {
          await reset()
          const h0 = (await hist()).length
          const base = await rows()
          await typeSeed(text)
          await click("randgo")
          await until(`document.getElementById('randlast').textContent === ${JSON.stringify("seed " + shown)}`, "the roll")
          await settle()
          const rolled = await rows()
          expect(diffIdx(base, rolled).length).toBeGreaterThan(5) // the patch changed
          expect(await hint()).toBe("")
          expect((await hist()).length).toBe(h0 + 1)
          // the same seed on the patch it made: same values, and the page says why
          await click("randgo")
          await until(`document.getElementById('randhint').textContent.includes('Same seed, same result')`, "the same-seed hint")
          expect(await rows()).toEqual(rolled)
          expect(await evaluate(`document.getElementById('status').textContent`)).toContain("Same seed, same result")
          expect((await hist()).length).toBe(h0 + 1) // nothing was added
          // typing another seed clears the hint and rolls on
          await typeSeed("another seed")
          expect(await hint()).toBe("")
          await click("randgo")
          await until(`document.getElementById('randlast').textContent === ${JSON.stringify("seed " + formatSeed(fnv1a64("another seed"), 2))}`, "the next roll")
          await settle()
          expect(diffIdx(rolled, await rows()).length).toBeGreaterThan(5)
        }, 60_000)
      }
      test("Enter in the Seed field rolls (the R key types an r there), R after leaving the field rolls", async () => {
        await reset()
        const base = await rows()
        await typeSeed("77")
        await key("r")
        expect(await evaluate(`document.getElementById('randseed').value`)).toBe("77r") // typing, not rolling
        expect(await rows()).toEqual(base)
        await typeSeed("77")
        await named("Enter", 13, "\r")
        await until(`document.getElementById('randlast').textContent === 'seed ${sc(77)}'`, "Enter rolled")
        await settle()
        expect(diffIdx(base, await rows()).length).toBeGreaterThan(5)
        await evaluate(`document.activeElement.blur()`)
        const rolled = await rows()
        // R with the 77 still in the field rolls 77 again: the same patch, and the page says why (this was the "R does nothing" report)
        await key("r")
        await until(`document.getElementById('randhint').textContent.includes('Same seed, same result')`, "R with the seed still in the field")
        expect(await rows()).toEqual(rolled)
        await setSeed("")
        await key("r")
        await until(`document.getElementById('randlast').textContent !== 'seed ${sc(77)}'`, "R rolled a new seed")
        await settle()
        expect(diffIdx(rolled, await rows()).length).toBeGreaterThan(5)
      }, 60_000)
      test("a mistyped seed code is refused with a visible message next to the field, and nothing is rolled", async () => {
        await reset()
        const h0 = (await hist()).length, base = await rows()
        const bad = code.slice(0, -1) + (code.endsWith("A") ? "B" : "A")
        await typeSeed(bad)
        await click("randgo")
        await until(`document.getElementById('randhint').textContent.includes('check symbol')`, "the refusal next to the field")
        expect(await evaluate(`document.getElementById('randhint').className`)).toBe("err")
        expect(await evaluate(`document.getElementById('randseed').getAttribute('aria-invalid')`)).toBe("true")
        expect(await evaluate(`document.getElementById('status').className`)).toContain("err")
        expect(await rows()).toEqual(base)
        expect((await hist()).length).toBe(h0)
        await typeSeed(code) // typing a good one clears it
        expect(await hint()).toBe("")
        expect(await evaluate(`document.getElementById('randseed').getAttribute('aria-invalid')`)).toBe("false")
        await click("randgo")
        await until(`document.getElementById('randlast').textContent === ${JSON.stringify("seed " + code)}`, "the good code rolls")
        await settle()
        expect(diffIdx(base, await rows()).length).toBeGreaterThan(5)
      }, 60_000)
      test("a lower Amount keeps moving toward the same target, so only Amount 100% repeats", async () => {
        await reset()
        await setAmount(30)
        await typeSeed("42"); await click("randgo")
        await until(`document.getElementById('randlast').textContent === 'seed ${sc(42)}'`, "first roll")
        await settle()
        const first = await rows()
        await click("randgo"); await settle()
        expect(diffIdx(first, await rows()).length).toBeGreaterThan(0) // 30% more of the way
        expect(await hint()).not.toContain("Same seed")
        await setSeed("")
      }, 60_000)
    })

    test("manual knob edits are an edits step in the panel and survive undo and redo", async () => {
      await reset()
      await roll("401"); const rolled = await rows()
      await nudge(); await sleep(250)
      const edited = await rows()
      expect(edited).not.toEqual(rolled)
      let h = await hist()
      expect(h.length).toBe(3)
      expect(h[2].text).toContain("edits (")
      expect(h[2].cur).toBe(true)
      await nudge(); await sleep(150)
      expect((await hist()).length).toBe(3) // more moves in a row are the same step
      await click("randundo"); await settle()
      expect(await rows()).toEqual(rolled) // the roll as it was, without the hand edit
      await click("randredo"); await settle()
      expect(await rows()).toEqual(edited)
      await clickEntry(0); await settle()
      await click("randgo") // a roll from the base drops the roll and the edits after it
      await until(`document.getElementById('randundo').title.includes('1 step')`, "rolled from base"); await settle()
      expect((await hist()).length).toBe(2)
    }, 90_000)

    test("Copy recipe, a fresh page, Paste recipe: the same patch, manual edit included, and the panel is rebuilt", async () => {
      await reset()
      await setAmount(100); await roll("501")
      await nudge(); await sleep(250)
      await setAmount(60); await roll("502")
      const want = await evaluate(`({ rows: [...document.querySelectorAll('.param')].map((r) => r.querySelector('input:not(.lock), select').value), vals: [...document.querySelectorAll('.param .val')].map((v) => v.textContent) })`)
      const panel = (await hist()).map((e) => e.text)
      expect(panel.length).toBe(4)
      expect(panel[2]).toContain("edits")
      await click("recipecopy")
      await until(`document.getElementById('recipetext').value.startsWith('polyrec.')`, "the recipe")
      const code = String(await field("recipetext"))
      expect(code).toMatch(/^polyrec\.[A-Za-z0-9_-]+$/)
      expect(await text("recipenote")).toContain("3 steps")
      expect(await text("recipenote")).toContain("algorithm 2")
      // a fresh page: everything the page remembered is gone, only the text is carried over
      await evaluate(`location.reload()`)
      await until(`document.querySelectorAll('.param').length === 29 && document.querySelectorAll('#randhist li').length === 1 && document.getElementById('randgo')`, "a fresh page")
      expect(await rows()).not.toEqual(want.rows)
      await evaluate(`(() => { const f = document.getElementById('recipetext'); f.value = ${JSON.stringify("  " + code + "\n")}; return true })()`)
      await click("recipepaste")
      await until(`document.getElementById('status').textContent.startsWith('Recipe replayed: 3 steps')`, "the replay")
      await settle()
      const got = await evaluate(`({ rows: [...document.querySelectorAll('.param')].map((r) => r.querySelector('input:not(.lock), select').value), vals: [...document.querySelectorAll('.param .val')].map((v) => v.textContent) })`)
      expect(got).toEqual(want)
      expect((await hist()).map((e) => e.text)).toEqual(panel)
      expect(await field("randseed")).toBe(sc(502))
      expect(await text("randlast")).toBe(`seed ${sc(502)}`)
      expect(await field("randamt")).toBe("60")
      // the same through the server: the patch bytes of the replay equal the bytes of the original
      // (both go through /api/encode in the page when a recipe has a base patch, here the values and their text are identical)
      await click("randundo"); await settle()
      expect((await hist())[2].cur).toBe(true)
      // the roll code of the current step: one roll
      await click("rollcopy")
      await until(`document.getElementById('recipetext').value.startsWith('polyroll.')`, "the roll code")
      expect(await text("recipenote")).toContain("Roll code")
      await click("init"); await until(`document.getElementById('status').textContent === 'Init patch'`, "Init")
      await evaluate(`document.getElementById('randseed').value = ''`)
      await click("recipepaste")
      await until(`document.getElementById('randlast').textContent !== '' && !document.getElementById('randundo').disabled`, "the roll code roll")
      expect(await text("randlast")).toMatch(/^seed \d-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{2}$/)
      expect((await hist()).length).toBe(2)
      await click("randundo"); await settle()
      await evaluate(`document.getElementById('recipetext').value = ''`)
    }, 120_000)

    test("Paste recipe: a recipe from another algorithm or garbage is refused, a recipe whose base patch is missing warns and still replays", async () => {
      await reset()
      const b64 = (o: object) => "polyrec." + Buffer.from(JSON.stringify(o)).toString("base64url")
      const paste = async (t: string) => { await evaluate(`document.getElementById('recipetext').value = ${JSON.stringify(t)}`); await click("recipepaste") }
      await paste(b64({ f: 2, e: "ACD", b: { b: "init" }, s: [["r", formatSeed(5n, 1), 100, 0, [], 0]] }))
      await until(`document.getElementById('recipenote').textContent.includes('algorithm 1')`, "the refusal")
      expect(await evaluate(`document.getElementById('recipenote').className`)).toContain("err")
      await paste("not a recipe at all")
      await until(`document.getElementById('recipenote').textContent.includes('not a recipe')`, "the garbage refusal")
      expect((await hist()).length).toBe(1)
      // base: a patch that is not in the folder
      await choose("Two"); await until(`document.getElementById('status').textContent.startsWith('Loaded Two')`, "Two loaded")
      const loaded = await rows()
      await paste(b64({ f: 2, e: "ACD", b: { b: "patch", n: "Ghost", h: "deadbeef" }, s: [["r", sc(5), 100, 0, [], 0]] }))
      await until(`document.getElementById('status').textContent.startsWith('Recipe replayed')`, "the replay with a missing base")
      expect(await text("recipenote")).toContain("Ghost")
      expect(await text("recipenote")).toContain("Replaying from Two")
      expect(await evaluate(`document.getElementById('recipenote').className`)).toContain("warn")
      const h = await hist()
      expect(h[0].text).toContain("Two")
      expect(h[1].text).toContain(`seed ${sc(5)}`)
      await clickEntry(0); await settle()
      expect(await rows()).toEqual(loaded) // the base of the replayed history is the loaded patch
      // base: the patch itself is found by name and hash: no warning
      await choose("One"); await until(`document.getElementById('status').textContent.startsWith('Loaded One')`, "One loaded")
      await roll("601")
      await evaluate(`document.getElementById('recipetext').value = ''`)
      await click("recipecopy"); await until(`document.getElementById('recipetext').value.startsWith('polyrec.')`, "the recipe of One")
      const one = String(await field("recipetext")), after = await rows()
      await choose("Three") // dirty after the roll: confirm
      await until(`document.getElementById('discard').open`, "the confirm")
      await click("discardyes"); await until(`document.getElementById('status').textContent.startsWith('Loaded Three')`, "Three loaded")
      await evaluate(`document.getElementById('recipetext').value = ${JSON.stringify(one)}`)
      await click("recipepaste")
      await until(`document.getElementById('status').textContent.startsWith('Recipe replayed: 1 step') && document.getElementById('recipenote').textContent.startsWith('Replayed')`, "replay of One's recipe").catch(async (e) => { throw new Error(e.message + " note: " + (await text("recipenote"))) })
      expect(await text("recipenote")).toBe("Replayed 1 step from One")
      await settle()
      expect(await rows()).toEqual(after) // found One in the folder, same hash, same result even though Three was loaded
      // the name exists but the patch is another one (hash differs): warning, replayed from what is loaded
      await paste(b64({ f: 2, e: "ACD", b: { b: "patch", n: "One", h: "00000000" }, s: [["r", sc(6), 100, 0, [], 0]] }))
      await until(`document.getElementById('discard').open`, "the confirm: a replayed recipe has unsaved edits") // a recipe replaces them
      await click("discardyes")
      await until(`document.getElementById('recipenote').textContent.includes('hash differs')`, "the hash warning")
      expect(await text("recipenote")).toContain("Replaying from One instead") // One is what the last replay left loaded
      expect((await hist()).length).toBe(2)
      // the base is fine but the replay ends in other bytes than the recipe says (the engine's ranges drifted): replayed, with a warning
      await click("init"); await until(`document.getElementById('status').textContent === 'Init patch'`, "Init")
      await paste(b64({ f: 2, e: "ACD", b: { b: "init" }, s: [["r", sc(7), 100, 0, [], 0]], h: "00000000" }))
      await until(`document.getElementById('status').textContent.startsWith('Recipe replayed')`, "the replay with a wrong result hash")
      expect(await text("recipenote")).toContain("other patch bytes")
      expect(await evaluate(`document.getElementById('recipenote').className`)).toContain("warn")
      expect((await hist()).length).toBe(2)
      // a recipe records the firmware tag, and one made on another release names both versions in its warning (and still replays)
      expect(JSON.parse(Buffer.from(one.slice("polyrec.".length), "base64url").toString()).w).toBe("tracker-ff-v1.2.0")
      await click("init"); await until(`document.getElementById('status').textContent === 'Init patch'`, "Init")
      await paste(b64({ f: 2, e: "ACD", b: { b: "init" }, s: [["r", sc(8), 100, 0, [], 0]], w: "tracker-ff-v1.0.0" }))
      await until(`document.getElementById('status').textContent.startsWith('Recipe replayed')`, "the replay of a recipe from another firmware")
      expect(await text("recipenote")).toContain("made on tracker-ff 1.0.0, you are on tracker-ff 1.2.0")
      expect(await evaluate(`document.getElementById('recipenote').className`)).toContain("warn")
      // the same release: no warning
      await click("init"); await until(`document.getElementById('status').textContent === 'Init patch'`, "Init")
      await paste(b64({ f: 2, e: "ACD", b: { b: "init" }, s: [["r", sc(9), 100, 0, [], 0]], w: "tracker-ff-v1.2.0" }))
      await until(`document.getElementById('status').textContent.startsWith('Recipe replayed')`, "the replay on the same firmware")
      expect(await text("recipenote")).toBe("Replayed 1 step from Init")
      await evaluate(`document.getElementById('recipetext').value = ''`)
    }, 120_000)
  })
})
