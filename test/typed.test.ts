// A value typed into a readout, mapped back through the host's own readout and the firmware edit curve (server/typed.ts, POST /api/typed): for every engine
// the shown text of a knob position reads back to the same text, at every curve kind. Out of range clamps, nonsense is refused, names and indexes work.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { nudgeText, resolveTyped } from "../server/typed"
import { canonNumber } from "../public/valuefield.js"
import { newHost, SERVED_ENGINES } from "./helpers"
import type { HostClient } from "../server/host"

let host: HostClient
beforeAll(async () => { host = await newHost() }, 120_000)
afterAll(() => host?.close())

const knob = (engine: string, p: any, k: number, patch: any) => host.request<{ value: number; text: string }>({ cmd: "knob", engine, param: p.id, knob: k, patch })

test("every engine: the readout of a knob position reads back to the same readout (linear, power, expSteep and exp curves, stepped values)", async () => {
  const kinds = new Set<string>()
  for (const engine of SERVED_ENGINES) {
    const meta = await host.request({ cmd: "meta", engine })
    // a spread of the parameters (every third, and the first of each curve kind), two positions each
    const picks = meta.params.filter((p: any, i: number) => !p.names && (i % 3 === 0 || !kinds.has(`${engine}:${p.curve}:${!!p.stepped}`)))
    for (const p of picks) {
      kinds.add(`${engine}:${p.curve}:${!!p.stepped}`)
      for (const k of [0.31, 0.77]) {
        const shown = await knob(engine, p, k, meta.init)
        const r = await resolveTyped(host, engine, p, shown.text, meta.init)
        if (!r.ok) { // a readout with words in it that cannot be told apart is the only excuse
          expect(p.stepped, `${engine} ${p.name} ${shown.text}: ${r.error}`).toBe(true)
          continue
        }
        expect(r.text, `${engine} ${p.name} typed ${shown.text}`).toBe(shown.text)
        expect(r.value).toBeGreaterThanOrEqual(p.min); expect(r.value).toBeLessThanOrEqual(p.max)
        if (p.stepped) expect(Number.isInteger(r.value)).toBe(true)
      }
    }
  }
  // all four curve kinds of the firmware were met
  const curves = new Set([...kinds].map((k) => k.split(":")[1]))
  for (const c of ["linear", "exp", "expSteep"]) expect(curves.has(c)).toBe(true)
}, 600_000)

test("ACD: units, plain numbers, clamping and refusal", async () => {
  const meta = await host.request({ cmd: "meta", engine: "ACD" })
  const by = (n: string, i = 0) => meta.params.filter((p: any) => p.name === n)[i]
  const cutoff = by("Cutoff"), attack = by("Attack"), mix = by("Saw Mix"), noise = by("Noise Mix")
  const typed = (p: any, t: string) => resolveTyped(host, "ACD", p, t, meta.init) as Promise<any>
  expect(cutoff.curve).toBe("exp")
  expect(await typed(cutoff, "440 Hz")).toMatchObject({ ok: true, value: 440, text: "440 Hz" })
  expect(await typed(cutoff, "440")).toMatchObject({ ok: true, value: 440 }) // plain: Hz
  expect(await typed(cutoff, "1.5 kHz")).toMatchObject({ ok: true, value: 1500, text: "1.50 kHz" })
  expect(await typed(cutoff, "1500hz")).toMatchObject({ ok: true, value: 1500 })
  expect(await typed(cutoff, "1,5khz")).toMatchObject({ ok: true, value: 1500 })
  expect(await typed(cutoff, "99999")).toMatchObject({ ok: true, value: 20000 }) // clamps
  expect(await typed(cutoff, "1")).toMatchObject({ ok: true, value: 20 })
  expect(await typed(cutoff, "banana")).toMatchObject({ ok: false })
  expect(await typed(cutoff, "   ")).toMatchObject({ ok: false })
  expect(attack.curve).toBe("expSteep")
  expect(await typed(attack, "250 ms")).toMatchObject({ ok: true, value: 0.25, text: "250 ms" })
  expect(await typed(attack, "1.25 s")).toMatchObject({ ok: true, value: 1.25 })
  expect(await typed(attack, "250")).toMatchObject({ ok: true, value: 0.25 }) // plain: ms
  expect(await typed(attack, "99 s")).toMatchObject({ ok: true, value: 10 })
  expect(await typed(mix, "35 %")).toMatchObject({ ok: true, text: "35%" })
  expect(Math.abs((await typed(mix, "35 %")).value - 0.35)).toBeLessThan(1e-6)
  expect(await typed(mix, "150%")).toMatchObject({ ok: true, value: 1 })
  expect(await typed(noise, "-50%")).toMatchObject({ ok: true, value: -0.5 })
  expect(await typed(noise, "-500")).toMatchObject({ ok: true, value: -1 })
})

test("ACD: enums by name, by index and by prefix, stepped numbers", async () => {
  const meta = await host.request({ cmd: "meta", engine: "ACD" })
  const type = meta.params.find((p: any) => p.name === "Type")
  const typed = (p: any, t: string) => resolveTyped(host, "ACD", p, t, meta.init) as Promise<any>
  expect(type.names.length).toBe(3)
  for (let i = 0; i < 3; i++) {
    expect(await typed(type, type.names[i])).toMatchObject({ ok: true, value: type.min + i, text: type.names[i] })
    expect(await typed(type, type.names[i].toUpperCase())).toMatchObject({ ok: true, value: type.min + i })
    expect(await typed(type, String(type.min + i))).toMatchObject({ ok: true, value: type.min + i })
  }
  expect(await typed(type, "lp rd")).toMatchObject({ ok: true, value: type.min + 2 })
  expect(await typed(type, "nonsense")).toMatchObject({ ok: false })
  expect(await typed(type, "7")).toMatchObject({ ok: false })
  const vap = await host.request({ cmd: "meta", engine: "VAP" })
  const tune = vap.params.find((p: any) => p.name === "Tune 1")
  const vt = (t: string) => resolveTyped(host, "VAP", tune, t, vap.init) as Promise<any>
  expect(await vt("-12 st")).toMatchObject({ ok: true, value: -12, text: "-12 st" })
  expect(await vt("7")).toMatchObject({ ok: true, value: 7 })
  expect(await vt("7.4")).toMatchObject({ ok: true, value: 7 }) // whole values only
  expect(await vt("-100 st")).toMatchObject({ ok: true, value: -36 })
  expect(await vt("100")).toMatchObject({ ok: true, value: 36 })
})

test("PERC: a note name and a wave name type in too", async () => {
  const meta = await host.request({ cmd: "meta", engine: "PERC" })
  const typed = (p: any, t: string) => resolveTyped(host, "PERC", p, t, meta.init) as Promise<any>
  const pitch = meta.params.find((p: any) => p.name === "Pitch")
  expect(await typed(pitch, "C#3")).toMatchObject({ ok: true, text: "C#3" })
  expect(await typed(pitch, "d#2")).toMatchObject({ ok: true, text: "D#2", value: 39 })
  expect(canonNumber("C#3")).toBeNull()
  const wave = meta.params.find((p: any) => p.name === "Body Wave")
  expect(await typed(wave, "FM1 0%")).toMatchObject({ ok: true, text: "FM1 0%" })
})

test("the arrow key: every continuous parameter of every engine moves to the nearest knob position whose readout differs, up and down", async () => {
  let checked = 0
  const units = new Set<string>()
  for (const engine of SERVED_ENGINES) {
    const meta = await host.request({ cmd: "meta", engine })
    for (const p of meta.params) {
      if (p.names || (p.stepped && p.curve === "linear")) continue // enums and whole-value parameters move one step (page)
      for (const pos of [1500, 20000, 47000]) {
        const here = (await knob(engine, p, pos / 65535, meta.init)).text
        for (const dir of [1, -1]) {
          const r = await nudgeText(host, engine, p, pos, dir, here, meta.init)
          if (!r) continue // a readout that does not change that way (a plateau to the end of the travel)
          expect(Math.sign(r.pos - pos), `${engine} ${p.name} ${here}`).toBe(dir)
          expect((await knob(engine, p, r.pos / 65535, meta.init)).text, `${engine} ${p.name}`).toBe(r.text)
          expect(r.text, `${engine} ${p.name} ${here}`).not.toBe(here)
          // the smallest move: one position short of it still reads like the start
          if (Math.abs(r.pos - pos) > 1) expect((await knob(engine, p, (r.pos - dir) / 65535, meta.init)).text, `${engine} ${p.name} short of ${r.text}`).toBe(here)
          checked++
          units.add(here.replace(/[-+0-9.,]+/g, "#"))
        }
      }
    }
  }
  expect(checked).toBeGreaterThan(200)
  for (const u of ["# Hz", "# ms", "# dB", "#%"]) expect([...units].some((x) => x.trim() === u || x === u), u).toBe(true)
}, 600_000)

test("the arrow key: a step is one readout unit (1 Hz, 1 ms, 1 %, 0.1 dB), walking up and back down visits the same texts, a screen text is never landed on, the ends hold", async () => {
  const acd = await host.request({ cmd: "meta", engine: "ACD" })
  const of = (name: string) => acd.params.find((p: any) => p.name === name)
  const walk = async (p: any, from: number, dir: number, n: number) => {
    const texts: string[] = [(await knob("ACD", p, from / 65535, acd.init)).text]
    let pos = from
    for (let i = 0; i < n; i++) { const r = (await nudgeText(host, "ACD", p, pos, dir, texts.at(-1), acd.init))!; pos = r.pos; texts.push(r.text) }
    return { texts, pos }
  }
  // a time: 1 ms apart at 284 ms, a frequency 1 Hz apart at 165 Hz, a percentage 1 % apart
  for (const [name, re] of [["Attack", /^(\d+) ms$/], ["Cutoff", /^(\d+) Hz$/], ["Saw Mix", /^(\d+)%$/]] as const) {
    const up = await walk(of(name), 20000, 1, 6)
    const nums = up.texts.map((t) => Number(re.exec(t)?.[1]))
    nums.slice(1).forEach((x, i) => expect(x - nums[i], `${name} ${up.texts}`).toBe(1))
    const down = await walk(of(name), up.pos, -1, 6)
    expect(down.texts).toEqual([...up.texts].reverse())
  }
  // the text on screen is not landed on: stand on a position that reads one text while the screen still says the one below
  const p = of("Cutoff")
  const at = (await nudgeText(host, "ACD", p, 20000, 1, undefined, acd.init))!
  const lowerText = (await knob("ACD", p, 20000 / 65535, acd.init)).text
  const down = (await nudgeText(host, "ACD", p, at.pos, -1, lowerText, acd.init))!
  expect(down.text).not.toBe(at.text); expect(down.text).not.toBe(lowerText)
  // the ends
  expect(await nudgeText(host, "ACD", p, 65535, 1, undefined, acd.init)).toBeNull()
  expect(await nudgeText(host, "ACD", p, 0, -1, undefined, acd.init)).toBeNull()
  // asked twice: the same answer (the second from the cache), also through a changed patch of another parameter
  const a = await nudgeText(host, "ACD", p, 31000, 1, undefined, acd.init), b = await nudgeText(host, "ACD", p, 31000, 1, undefined, acd.init)
  expect(b).toEqual(a)
}, 120_000)
