// The runtime module page: the wasm host in an AudioWorklet (modules-worklet.js) with the engines and master inserts of build/modules
// (scripts/modules.ts), loaded at run time. Verifies each module (size, sha256, ABI) before the worklet sees it.
import { checkManifest, verify } from "/ffmod.js"

const $ = (id) => document.getElementById(id)
const status = (t) => { $("status").textContent = t }
const state = { node: null, ctx: null, inserts: [], engines: [], ready: false, slots: [null, null], stats: null, answers: [] }
window.__modules = state // the page test reads it


async function loadSet() {
  const idx = await (await fetch("/modules/index.json")).json()
  const out = { engines: [], inserts: [] }
  const rows = []
  for (const m of idx.modules) {
    const man = await (await fetch(`/modules/${m.manifest}`)).json()
    const bytes = new Uint8Array(await (await fetch(`/modules/${m.wasm}`)).arrayBuffer())
    checkManifest(man, idx.host, m.kind) // idx.host: the plugin SDK the wasm host is built with (host/sdk), the worklet checks the running host again
    await verify(bytes, man, idx.host, m.kind)
    const module = await WebAssembly.compile(bytes)
    ;(m.kind === "synth" ? out.engines : out.inserts).push({ module, man })
    rows.push(`<tr><td>${m.kind === "synth" ? "engine" : "insert"}</td><td>${man.name}</td><td>${man.version}</td><td>${m.set} (${m.visibility}) ${m.tag}</td><td>${man.licence}</td><td>${(bytes.length / 1024).toFixed(1)} KB, sha256 ${man.files.wasm.sha256.slice(0, 12)}</td></tr>`)
  }
  $("mods").innerHTML = rows.join("")
  $("notices").innerHTML = Object.entries(idx.sets).filter(([, s]) => s.notice).map(([n, s]) => `<a href="/modules/${s.notice}">Notices of ${n} (${s.repo ? s.repo + " " : ""}${s.tag})</a>`).join(" &middot; ")
  return { ...out, firmware: idx.firmware }
}

function paramControl(slot, p, i) {
  const name = document.createElement("span")
  name.textContent = p.name
  const val = document.createElement("span")
  let input
  if (p.enum) {
    input = document.createElement("select")
    p.enum.forEach((n, k) => input.add(new Option(n, String(k))))
    input.value = String(p.def)
  } else {
    input = document.createElement("input")
    Object.assign(input, { type: "range", min: p.min, max: p.max, step: p.step || "any", value: p.def })
  }
  input.className = "pv"
  input.dataset.index = String(i)
  const show = () => { val.textContent = p.enum ? "" : `${input.value}${p.unit ? " " + p.unit : ""}` }
  input.addEventListener("input", () => { show(); state.node.port.postMessage({ type: "param", slot, index: i, value: Number(input.value) }) })
  show()
  return [name, input, val]
}

function slotUi(slot) {
  const box = document.createElement("div")
  box.className = "slot"
  box.innerHTML = `<b>Insert ${slot + 1}</b>`
  const sel = document.createElement("select")
  sel.className = "ins"
  sel.add(new Option("None", ""))
  for (const i of state.inserts) sel.add(new Option(`${i.man.name} ${i.man.version}`, i.man.name))
  const byp = document.createElement("label")
  byp.innerHTML = `<input type="checkbox" class="byp"> Bypass`
  const head = document.createElement("div")
  head.append(sel, " ", byp)
  const params = document.createElement("div")
  params.className = "params"
  box.append(head, params)
  sel.addEventListener("change", () => {
    params.replaceChildren()
    const ins = state.inserts.find((i) => i.man.name === sel.value)
    state.node.port.postMessage({ type: "insert", slot, name: ins ? ins.man.name : null })
    if (ins) ins.man.params.forEach((p, i) => params.append(...paramControl(slot, p, i)))
  })
  byp.querySelector("input").addEventListener("change", (e) => state.node.port.postMessage({ type: "bypass", slot, on: e.target.checked }))
  return box
}

function keys() {
  for (let n = 48; n <= 72; n++) {
    const b = document.createElement("button")
    b.textContent = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][n % 12]
    b.dataset.note = String(n)
    const on = () => line({ cmd: "live.note", on: true, note: n, velocity: 100 })
    const off = () => line({ cmd: "live.note", on: false, note: n })
    b.addEventListener("pointerdown", on)
    b.addEventListener("pointerup", off)
    b.addEventListener("pointerleave", off)
    $("keys").append(b)
  }
}

const line = (o) => state.node?.port.postMessage({ type: "line", line: o })

async function start(set) {
  const ctx = new AudioContext({ sampleRate: 44100, latencyHint: "interactive" }) // the engines run at 44,117.647 Hz: played 1:1, 0.7 cents flat
  await ctx.audioWorklet.addModule("/modules-worklet.js")
  const host = await WebAssembly.compileStreaming(fetch("/wasm/runtime/poly.wasm"))
  const node = new AudioWorkletNode(ctx, "poly-modules", { numberOfInputs: 0, outputChannelCount: [2] })
  node.connect(ctx.destination)
  state.node = node
  state.ctx = ctx
  node.port.onmessage = (e) => {
    const m = e.data
    if (m.type === "ready") {
      state.engines = m.engines
      state.noSlot = m.noSlot
      state.ready = true
      $("engine").replaceChildren(...m.engines.map((n) => new Option(n, n)))
      $("engine").value = m.engines.includes("PHZ") ? "PHZ" : m.engines[0]
      $("engine").disabled = false
      line({ cmd: "live.open", engine: $("engine").value, voices: 4 })
      const loaded = set.engines.map((e) => e.man.name).filter((n) => !m.noSlot.includes(n))
      status(`ready: ${m.engines.length} engines (${loaded.join(", ")} loaded at run time, ${m.noSlot.length} more modules without a slot in this host build), ${set.inserts.length} insert module(s), firmware ${set.firmware}`)
    } else if (m.type === "error") status("error: " + m.error)
    else if (m.type === "answer") state.answers.push(m.answer)
    else if (m.type === "slots") state.slots = m.slots
    else if (m.type === "stats") { state.stats = m; $("meter").textContent = `rms ${m.rms.toFixed(4)} peak ${m.peak.toFixed(3)} voices ${m.voices}` }
  }
  node.port.postMessage({ type: "init", host, engines: set.engines, inserts: set.inserts })
  await ctx.resume()
}

try {
  const set = await loadSet()
  state.inserts = set.inserts
  status(`module set verified (${set.engines.length + set.inserts.length} modules), press Start audio`)
  $("start").disabled = false
  $("start").addEventListener("click", () => start(set).catch((e) => status("error: " + e.message)), { once: true })
  $("engine").addEventListener("change", () => line({ cmd: "live.open", engine: $("engine").value, voices: 4 }))
  $("inserts").append(slotUi(0), slotUi(1))
  keys()
} catch (e) {
  status("error: " + e.message)
}
