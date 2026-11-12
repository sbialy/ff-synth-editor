// The page's MIDI layer (public/midi.js) without a browser: message parsing, what is forwarded to the host, and the Web MIDI
// wrapper with a fake access object (device and channel selection, hot-plug, no hanging notes).
import { describe, expect, test } from "bun:test"
// @ts-ignore plain browser module
import { createMidiInput, macroOfCC, parseMidi, toLive } from "../public/midi.js"

describe("parseMidi / toLive", () => {
  test("note on with velocity, note on velocity 0 is a note off, note off", () => {
    expect(parseMidi([0x93, 60, 100])).toEqual({ kind: "on", ch: 3, note: 60, velocity: 100 })
    expect(parseMidi([0x90, 60, 0])).toEqual({ kind: "off", ch: 0, note: 60 })
    expect(parseMidi([0x8f, 61, 64])).toEqual({ kind: "off", ch: 15, note: 61 })
    expect(toLive(parseMidi([0x90, 60, 99]))).toEqual({ cmd: "live.note", on: true, note: 60, velocity: 99 })
    expect(toLive(parseMidi([0x80, 60, 0]))).toEqual({ cmd: "live.note", on: false, note: 60 })
  })
  test("pitch bend is 14 bit around 8192", () => {
    expect(parseMidi([0xe0, 0, 64])).toEqual({ kind: "bend", ch: 0, value: 0 })
    expect(parseMidi([0xe0, 0, 0])?.value).toBe(-8192)
    expect(parseMidi([0xe0, 127, 127])?.value).toBe(8191)
    expect(toLive(parseMidi([0xe2, 0, 127]))).toEqual({ cmd: "live.bend", value: 8064 })
  })
  test("CC: mod wheel, sustain, macros 102..107 and notes off are forwarded, the rest is not", () => {
    for (const c of [1, 64, 102, 107, 120, 123]) expect(toLive(parseMidi([0xb0, c, 5]))).toEqual({ cmd: "live.cc", cc: c, value: 5 })
    for (const c of [7, 10, 101, 108]) expect(toLive(parseMidi([0xb0, c, 5]))).toBeNull()
    expect([101, 102, 107, 108].map(macroOfCC)).toEqual([-1, 0, 5, -1])
  })
  test("clock, sysex, aftertouch, program change and garbage are ignored", () => {
    for (const m of [[0xf8], [0xf0, 1, 0xf7], [0xd0, 5], [0xc0, 3], [0xa0, 60, 5], [5, 6], []]) expect(toLive(parseMidi(m))).toBeNull()
  })
})

/** A fake MIDIAccess: ports can be plugged and unplugged, messages injected. */
function fakeAccess() {
  const inputs = new Map<string, any>()
  const access: any = { inputs, onstatechange: null }
  const port = (id: string, name: string) => ({ id, name, type: "input", state: "connected", onmidimessage: null as null | ((m: any) => void) })
  return {
    access,
    plug(id: string, name = id) {
      const p = port(id, name)
      inputs.set(id, p)
      access.onstatechange?.({ port: p })
      return p
    },
    unplug(id: string) {
      const p = inputs.get(id)
      p.state = "disconnected"
      inputs.delete(id)
      access.onstatechange?.({ port: p })
    },
    send: (id: string, ...data: number[]) => inputs.get(id).onmidimessage?.({ data: Uint8Array.from(data) }),
  }
}

async function setup() {
  const f = fakeAccess()
  const events: any[] = [], lists: any[] = []
  const midi = createMidiInput({ onEvent: (e: any) => events.push(e), onDevices: (d: any) => lists.push(d), requestAccess: async () => f.access })
  await midi.enable()
  return { f, midi, events, lists }
}

describe("createMidiInput", () => {
  test("lists the devices, listens to all by default, picks one device", async () => {
    const { f, midi, events, lists } = await setup()
    expect(lists.at(-1).devices).toEqual([])
    f.plug("a", "Keys"); f.plug("b", "Pads")
    expect(lists.at(-1).devices.map((d: any) => d.name)).toEqual(["Keys", "Pads"])
    f.send("a", 0x90, 60, 90); f.send("b", 0x90, 36, 80)
    expect(events.map((e) => e.note)).toEqual([60, 36])
    midi.select("b")
    expect(f.access.inputs.get("a").onmidimessage).toBeNull()
    f.send("b", 0x90, 37, 80)
    expect(events.filter((e) => !e.synthetic).map((e) => e.note)).toEqual([60, 36, 37])
    // the notes held on device a were let go when it was deselected
    expect(events.filter((e) => e.synthetic).map((e) => [e.kind, e.note])).toEqual([["off", 60]])
  })

  test("channel filter: omni passes all, a channel passes only that one, changing it lets go of held notes", async () => {
    const { f, midi, events } = await setup()
    f.plug("a")
    f.send("a", 0x91, 60, 90); f.send("a", 0x92, 62, 90)
    expect(events.length).toBe(2)
    midi.setChannel("1") // MIDI channel 2
    expect(events.filter((e) => e.synthetic).map((e) => e.note).sort()).toEqual([60, 62])
    events.length = 0
    f.send("a", 0x91, 64, 90); f.send("a", 0x92, 65, 90); f.send("a", 0xe1, 0, 100)
    expect(events.map((e) => e.kind)).toEqual(["on", "bend"])
    expect(events[0].note).toBe(64)
  })

  test("hot-plug: a device unplugged with keys and the pedal down releases them, a replug listens again", async () => {
    const { f, midi, events, lists } = await setup()
    f.plug("a", "Keys")
    midi.select("a")
    f.send("a", 0x90, 60, 90); f.send("a", 0x90, 64, 90); f.send("a", 0xb0, 64, 127)
    events.length = 0
    f.unplug("a")
    expect(events.map((e) => [e.kind, e.note ?? e.cc, e.synthetic])).toEqual([["off", 60, true], ["off", 64, true], ["cc", 64, true]])
    expect(lists.at(-1).devices).toEqual([])
    expect(lists.at(-1).notice).toContain("disconnected")
    expect(midi.selected).toBe("a") // the choice survives, the picker shows it as unplugged
    events.length = 0
    f.plug("a", "Keys")
    expect(lists.at(-1).listening).toBe(1)
    f.send("a", 0x90, 62, 70)
    expect(events.map((e) => e.note)).toEqual([62])
  })

  test("all notes off and a pedal up clear the tracking, so nothing is released twice", async () => {
    const { f, events } = await setup()
    f.plug("a")
    f.send("a", 0x90, 60, 90); f.send("a", 0xb0, 64, 127); f.send("a", 0xb0, 123, 0); f.send("a", 0xb0, 64, 0)
    events.length = 0
    f.unplug("a")
    expect(events).toEqual([])
  })

  test("one controller on two inputs: the same key is one note, whichever input delivers it first", async () => {
    const { f, events } = await setup()
    f.plug("a", "Keys"); f.plug("b", "Keys MIDI 2")
    f.send("a", 0x90, 60, 90); f.send("b", 0x90, 60, 90)
    expect(events.map((e) => [e.kind, e.note])).toEqual([["on", 60]])
    f.send("b", 0x80, 60, 0) // the twin's off is not the owner's: the key is still down
    expect(events.length).toBe(1)
    f.send("a", 0x80, 60, 0); f.send("b", 0x90, 60, 0)
    expect(events.map((e) => [e.kind, e.note])).toEqual([["on", 60], ["off", 60]])
    // the other input can own it next time
    f.send("b", 0x90, 60, 90); f.send("a", 0x90, 60, 90); f.send("b", 0x80, 60, 0)
    expect(events.map((e) => [e.kind, e.note])).toEqual([["on", 60], ["off", 60], ["on", 60], ["off", 60]])
    // different notes on the two inputs are both played
    events.length = 0
    f.send("a", 0x90, 60, 90); f.send("b", 0x90, 64, 90)
    expect(events.map((e) => e.note)).toEqual([60, 64])
  })

  test("a status change and a replug do not bind a second handler, and an unplugged owner frees the key", async () => {
    const { f, events } = await setup()
    f.plug("a", "Keys"); f.plug("b", "Pads")
    const handler = f.access.inputs.get("a").onmidimessage
    for (let i = 0; i < 3; i++) f.access.onstatechange({ port: f.access.inputs.get("a") })
    expect(f.access.inputs.get("a").onmidimessage).toBe(handler)
    f.send("a", 0x90, 60, 90)
    expect(events.map((e) => e.kind)).toEqual(["on"])
    f.unplug("a")
    expect(events.map((e) => [e.kind, e.synthetic])).toEqual([["on", undefined], ["off", true]])
    f.send("b", 0x90, 60, 90) // the key is free again
    expect(events.at(-1)).toMatchObject({ kind: "on", note: 60 })
    f.plug("a", "Keys")
    f.send("a", 0x90, 60, 90) // b owns 60 now
    expect(events.filter((e) => e.kind === "on").length).toBe(2)
  })
})
