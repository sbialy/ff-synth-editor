// MIDI input for the page. Web MIDI in the browser, not CoreMIDI in the native host: the audio already plays in the browser
// (AudioWorklet), so the note and its sound meet there with no extra hop, the host stays a plain stdin / stdout process that
// the tests can drive, and the picker, hot-plug and permission prompt come with the browser. Cost: Chrome (Safari has no Web MIDI).
//
// parseMidi / toLive are pure (tested in test/midi-page.test.ts). createMidiInput wraps requestMIDIAccess with device and
// channel selection and hot-plug.

/** CCs the host cares about: 1 mod wheel (the firmware ignores it, forwarded anyway), 64 sustain, 102..107 macros M1..M6, 120 / 123 notes off. */
export const FORWARDED_CC = new Set([1, 64, 102, 103, 104, 105, 106, 107, 120, 123])
export const MACRO_CC_FIRST = 102

/** Raw bytes -> {kind, ch (0..15), ...} or null for what the editor does not use (clock, sysex, aftertouch, program change...). */
export function parseMidi(data) {
  if (!data || data.length < 1) return null
  const s = data[0]
  if (s < 0x80 || s >= 0xf0) return null
  const ch = s & 15, a = data[1] ?? 0, b = data[2] ?? 0
  switch (s & 0xf0) {
    case 0x90: return b > 0 ? { kind: "on", ch, note: a, velocity: b } : { kind: "off", ch, note: a }
    case 0x80: return { kind: "off", ch, note: a }
    case 0xb0: return { kind: "cc", ch, cc: a, value: b }
    case 0xe0: return { kind: "bend", ch, value: ((b << 7) | a) - 8192 }
    default: return null
  }
}

/** Event -> the control line for the streaming host, or null when it is not forwarded. */
export function toLive(ev) {
  switch (ev?.kind) {
    case "on": return { cmd: "live.note", on: true, note: ev.note, velocity: ev.velocity }
    case "off": return { cmd: "live.note", on: false, note: ev.note }
    case "cc": return FORWARDED_CC.has(ev.cc) ? { cmd: "live.cc", cc: ev.cc, value: ev.value } : null
    case "bend": return { cmd: "live.bend", value: ev.value }
    default: return null
  }
}

/** CC 102..107 -> macro index 0..5, else -1 */
export const macroOfCC = (cc) => (cc >= MACRO_CC_FIRST && cc < MACRO_CC_FIRST + 6 ? cc - MACRO_CC_FIRST : -1)

/**
 * Web MIDI wrapper. `onEvent(ev, input)` gets the parsed messages of the selected device(s) that pass the channel filter.
 * When a device goes away, or the device / channel selection changes, it first emits the note offs (and a pedal up) of
 * everything that device still holds, so no note hangs. `onDevices({devices, selected, channel, notice})` fires after every change.
 * `access` is injectable for tests (navigator.requestMIDIAccess by default).
 */
export function createMidiInput({ onEvent, onDevices, requestAccess = () => navigator.requestMIDIAccess() }) {
  let access = null
  let selected = "all" // "all" or a port id
  let channel = "omni" // "omni" or 0..15
  const held = new Map() // port id -> {notes:Set, pedal:boolean}
  const bound = new Map() // port id -> port, the inputs we put a handler on
  // note -> id of the port that holds it. One physical controller can reach the page twice (two Web MIDI inputs for one device, or a
  // device plus a loopback while "All inputs" listens to both), so the same note on arrives twice and the host starts a second voice
  // for one key. The first port to play a note owns it until it lets go, a note on or off from another port is the same key and is dropped.
  const owner = new Map()

  const connected = () => [...(access?.inputs?.values() ?? [])].filter((p) => p.state !== "disconnected")
  const heldOf = (id) => held.get(id) ?? held.set(id, { notes: new Set(), pedal: false }).get(id)

  function releaseHeld(id, port) {
    const h = held.get(id)
    if (!h) return
    for (const note of h.notes) { if (owner.get(note) === id) owner.delete(note); onEvent({ kind: "off", ch: 0, note, synthetic: true }, port) }
    if (h.pedal) onEvent({ kind: "cc", ch: 0, cc: 64, value: 0, synthetic: true }, port)
    held.delete(id)
  }
  const releaseAll = () => { for (const id of [...held.keys()]) releaseHeld(id, bound.get(id) ?? null) }

  function handle(port, m) {
    const ev = parseMidi(m.data)
    if (!ev) return
    if (channel !== "omni" && ev.ch !== channel) return
    const h = heldOf(port.id)
    if (ev.kind === "on") {
      const o = owner.get(ev.note)
      if (o !== undefined && o !== port.id) return // the same key already sounds from another input
      owner.set(ev.note, port.id); h.notes.add(ev.note)
    } else if (ev.kind === "off") {
      if (!h.notes.has(ev.note)) return // not held by this input: the twin of a dropped note on, or a stray off
      owner.delete(ev.note); h.notes.delete(ev.note)
    } else if (ev.kind === "cc" && ev.cc === 64) h.pedal = ev.value >= 64
    else if (ev.kind === "cc" && (ev.cc === 123 || ev.cc === 120)) { for (const n of h.notes) owner.delete(n); h.notes.clear() }
    onEvent(ev, port)
  }

  function sync(notice = "") {
    if (!access) return
    const ports = connected()
    const ids = new Set(ports.map((p) => p.id))
    for (const [id, port] of [...bound]) {
      if (!ids.has(id)) { releaseHeld(id, port); port.onmidimessage = null; bound.delete(id) }
    }
    for (const p of ports) {
      const listen = selected === "all" || selected === p.id
      if (listen && !bound.has(p.id)) { p.onmidimessage = (m) => handle(p, m); bound.set(p.id, p) }
      else if (!listen && bound.has(p.id)) { releaseHeld(p.id, p); p.onmidimessage = null; bound.delete(p.id) }
    }
    onDevices?.({ devices: ports.map((p) => ({ id: p.id, name: p.name || p.id })), selected, channel, notice, listening: bound.size })
  }

  return {
    async enable() {
      if (access) return
      access = await requestAccess()
      access.onstatechange = (e) => {
        const p = e.port
        sync(p?.type === "input" ? `${p.name || "MIDI device"} ${p.state === "connected" ? "connected" : "disconnected"}` : "")
      }
      sync()
    },
    get enabled() { return access !== null },
    select(id) { selected = id; sync() },
    setChannel(ch) { releaseAll(); channel = ch === "omni" ? "omni" : Number(ch); sync() },
    /** The selected device was unplugged: the picker falls back to "all" on the next sync only if it is no longer listed. */
    get selected() { return selected },
    get channel() { return channel },
    releaseAll,
    sync,
  }
}
