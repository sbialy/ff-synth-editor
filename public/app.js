// FF SYNTH EDITOR page: no framework. All sound, value text and curves come from the native host through /api.
import { createMidiInput, toLive, macroOfCC } from "/midi.js"
import { createPatchLoader } from "/loader.js"
import { attachCombobox } from "/combobox.js"
import { defaultNames, fetchManifest } from "/defaults.js"
import { saveName } from "/filename.js"
import { createHistory, parseSeed, newSeed, formatSeed, sectionNames, SILENT_PEAK, ALGO, ALGORITHMS, unknownAlgo } from "/randomize.js"
import { MIXERS, emptyState, normalizeState, defaults as insertDefaults, clampParam, loadInsertModules, loadHost, InsertChain, parseFloatWav, FX_PARAMS, LIMITER_PARAMS, TEMPO, sendOf, fxSending, limiterOn } from "/inserts.js"
import { sends as SEND_GAINS, levels as LEVEL_GAINS, limiter as LIMITER_STEPS } from "/fx-tables.js"
import { K_STEPS, isTypingTarget, macroText, fmtNum, MACRO_DECIMALS, nextTextPosition, parseNumber, parsePlain, parseDb, parseMilli, stepsOf, movePosition, attachArrows, attachNativeArrows, attachValueEdit } from "/valuefield.js"
import { rollSettings, describeSettings, applyRoll, buildRecipe, encodeRecipe, encodeRollCode, decodeCode, replaySteps, diffEdits, shortHash, resultWarning, firmwareWarning } from "/recipe.js"
const $ = (id) => document.getElementById(id)
// The static site (GitHub Pages, scripts/pages.ts marks its index.html with data-static="1"): no server. The /api requests are answered in the page by the
// wasm host (static-api.js, a file only that build has), live audio runs the host in the AudioWorklet (worklet-static.js), files are opened and downloaded.
const STATIC = document.documentElement.dataset.static === "1"
let staticP = null
const staticApi = () => (staticP ??= import("./static-api.js"))
const api = async (method, path, body) => {
  const r = await (STATIC ? (await staticApi()).staticFetch : fetch)(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined })
  const data = r.headers.get("content-type")?.includes("json") ? await r.json() : r
  if (!r.ok) throw new Error(data.error ?? r.statusText)
  return data
}

const st = { release: false, strict: false, firmware: null, engine: null, meta: null, patch: null, macroValues: [], texts: [], finalTexts: [], knobs: [], finalKnobs: [], dir: "", defaults: false }
// unsaved edits: the flag the discard confirm reads, shown next to the Save button
let dirty = false
Object.defineProperty(st, "dirty", { get: () => dirty, set(v) { dirty = !!v; const m = document.getElementById("dirtymark"); if (m) m.textContent = dirty ? "unsaved edits" : "" }, enumerable: true })
const els = { params: [], macros: [] }
let ctx = null
const cache = new Map()
// engines the host builds and the server serves that the page does not offer (server/engines.ts HIDDEN_ENGINES), by name, for messages
const HIDDEN_ENGINES = {} // none since tracker-ff 1.2.0 (Hand-Type is a release engine)

// resting position of the six macro knobs: bipolar ones sit at CC 63, as the firmware does after a patch load
const neutralMacros = () => Array.from({ length: 6 }, (_, m) => (st.patch.macros[m]?.bipolar ? (63 * 100) / 127 : 0))

let statusSeq = 0 // counts status lines: a slow engine switch does not replace a line written after it started (a recipe pasted while the inserts load)
function status(msg, kind = "") { statusSeq++; const s = $("status"); s.textContent = msg; s.title = msg; s.className = kind }
// Fader fill: the lit part of a range input's track follows its value (CSS reads --v)
const fill = (input) => { if (input.type === "range") input.style.setProperty("--v", ((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100).toFixed(2) + "%") }

/** a value typed on a plain range input: set it and let the usual "input" handler do the rest. true when applied, else the reason. */
function commitNative(input, v) {
  if (v === null || v === undefined) return false
  if (v !== Number(input.value)) { input.value = String(v); input.dispatchEvent(new Event("input", { bubbles: true })) }
  return true
}

// ---- engines
async function init() {
  const { engines, firmware, release } = await api("GET", "/api/engines")
  st.engines = engines; st.firmware = firmware
  // The server decides the mode: the release page has no Strict box, Strict is on and the server runs everything as Strict
  st.release = release === true
  if (st.release) st.strict = true
  else { try { st.strict = localStorage.getItem("poly-editor.strict") === "1" } catch {}; $("strict").checked = st.strict }
  $("fwbadge").textContent = firmware.matches
  const box = $("engines")
  // The closed source engines (every engine of firmware.private.engines: today PHZ and PLK, the server marks them `closed`) sit together in their own group, whatever
  // family the host gives them. Pluck is a release engine since tracker-ff 1.2.0.
  const groupOf = (e) => (e.closed ? "ff" : e.group)
  const groups = [["polyend", "OpenTracker 2.x"], ["polyend-oss", "Polyend open source"], ["ot3", "OpenTracker 3.x"], ["ff", "FF-engines"]]
  for (const [g, title] of groups) {
    const list = engines.filter((x) => groupOf(x) === g)
    if (!list.length) continue
    const grp = document.createElement("div"); grp.className = "egroup"; grp.dataset.group = g
    grp.innerHTML = `<div class="ghead">${title}</div><div class="gbtns"></div>`
    for (const e of list) {
      const b = document.createElement("button")
      b.dataset.engine = e.name; b.className = e.onTracker ? "fw" : "preview offtracker"
      b.innerHTML = `<span></span><small class="trk"></small>`
      b.firstChild.textContent = e.display
      b.querySelector(".trk").textContent = e.onTracker ? "" : "not on your Tracker"
      b.onclick = () => selectEngine(e.name)
      grp.querySelector(".gbtns").append(b)
    }
    box.append(grp)
  }
  if (STATIC) staticFiles()
  const cfg = await api("GET", "/api/config")
  st.dir = cfg.dir; $("dir").value = cfg.dir
  const dl = $("vols"); dl.innerHTML = ""
  for (const v of cfg.volumes) { const o = document.createElement("option"); o.value = v.path; o.label = v.hasPatches ? v.name : v.name + " (no Patches folder)"; dl.append(o) }
  if (!st.dir) { const v = cfg.volumes.find((x) => x.hasPatches); if (v) { st.dir = v.path; $("dir").value = v.path; await api("POST", "/api/config", { dir: v.path }) } }
  paintStrictEngines()
  await selectEngine(engines[0].name)
}
// Strict (match my Tracker) hides the engines the release image of the pinned firmware does not have (Pluck), and a group that is left empty
function paintStrictEngines() {
  for (const b of $("engines").querySelectorAll("button.offtracker")) b.hidden = st.strict
  for (const g of $("engines").querySelectorAll(".egroup")) g.hidden = ![...g.querySelectorAll("button")].some((b) => !b.hidden)
}

function paintInfo() {
  const e = st.engines.find((x) => x.name === st.engine)
  $("engname").textContent = e.display
  $("engtag").hidden = !e.closed
}

let engineSeq = 0 // the latest selectEngine call wins: an earlier one whose answers arrive late must not paint over it
async function selectEngine(name) {
  const mine = ++engineSeq, quiet = statusSeq
  st.engine = name
  for (const b of $("engines").querySelectorAll("button")) b.classList.toggle("on", b.dataset.engine === name)
  const meta = await api("GET", "/api/meta/" + name)
  if (mine !== engineSeq) return
  st.meta = meta
  st.patch = structuredClone(st.meta.init)
  $("name").value = "" // the Save as name belongs to the patch of the engine it was typed or loaded for, the init patch of the new engine starts unnamed
  st.macroValues = neutralMacros()
  st.dirty = false; loader.setCurrent(null); patchCombo.sync(); resetHistory({ kind: "init" })
  buildUi()
  paintPoly()
  paintInfo()
  liveOpen()
  await ins.ready // the stored state first: painting or saving before it is read would put the defaults over it
  if (mine !== engineSeq) return
  paintFx(); insPost() // the Delay send and Reverb send are the loaded engine's own
  await refresh()
  if (mine !== engineSeq) return
  await refreshPatchList()
  if (mine !== engineSeq || statusSeq !== quiet) return
  status(`${st.engines.find((x) => x.name === name).display}: ${st.meta.params.length} parameters, ${st.meta.sections.length} sections`)
}

// ---- UI
function buildUi() {
  const sec = $("sections"); sec.innerHTML = ""; els.params = []
  for (const s of st.meta.sections) {
    const card = document.createElement("div"); card.className = "section"
    card.innerHTML = `<h2>${s.name}</h2>`
    for (const id of s.params) {
      const p = st.meta.params[id]
      const row = document.createElement("div"); row.className = "param"
      const name = document.createElement("div"); name.className = "pname"; name.textContent = p.name; 
      const val = document.createElement("div"); val.className = "val"
      let input
      if (p.names) {
        input = document.createElement("select")
        p.names.forEach((n, i) => { const o = document.createElement("option"); o.value = String(p.min + i); o.textContent = n; input.append(o) })
        input.onchange = () => setValue(id, Number(input.value))
      } else {
        // step "any": the slider holds any of the 65535 knob positions (the finest move, see nudgeParam), not the 1000 a 0.001 step snapped to
        input = document.createElement("input"); input.type = "range"; input.min = 0; input.max = 1; input.step = "any"; fill(input)
        // a stepped parameter (whole values) stores whole values: the knob rounds to the nearest one, as the arrow keys do
        input.oninput = () => {
          fill(input)
          const n = Number(input.value)
          if (p.stepped && p.curve === "linear" && p.max > p.min) { const v = Math.round(p.min + n * (p.max - p.min)); if (v !== st.patch.values[id]) setValue(id, v) } else onKnob(id, n)
        }
        input.ondblclick = () => setValue(id, p.def)
        attachArrows(input, (dir, size) => nudgeParam(id, input, dir, size))
      }
      input.setAttribute("aria-label", p.name)
      const lock = document.createElement("button"); lock.className = "lock"; lock.type = "button"
      lock.innerHTML = LOCK_SVG; lock.onclick = () => toggleLock(id)
      row.dataset.param = id; row.append(name, input, val, lock); card.append(row)
      // Alt-click anywhere on the row locks or unlocks the parameter instead of editing it, Alt+Shift-click solos it
      row.addEventListener("pointerdown", (e) => { if (e.altKey) { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) soloLock(id); else toggleLock(id) } }, true)
      row.addEventListener("click", (e) => { if (e.altKey) { e.preventDefault(); e.stopPropagation() } }, true)
      els.params[id] = { input, val, row, lock }
      if (!p.names) attachValueEdit(val, { label: `${p.name} value`, text: () => typedText(id), commit: (t) => commitTyped(id, t), fail: (m) => status(m, "err") })
    }
    sec.append(card)
  }
  const mc = $("macros"); mc.innerHTML = ""; els.macros = []
  for (let m = 0; m < 6; m++) {
    const card = document.createElement("div"); card.className = "macro"
    card.innerHTML = `<h3>Macro ${m + 1}</h3><div class="name"></div>`
    const input = document.createElement("input"); input.type = "range"; input.min = 0; input.max = 100; input.step = 0.5; input.value = st.macroValues[m]
    input.oninput = () => { fill(input); st.macroValues[m] = Number(input.value); liveSend({ cmd: "live.macro", macro: m, value: st.macroValues[m] }); scheduleDescribe() }
    input.setAttribute("aria-label", `Macro ${m + 1}`)
    const mval = document.createElement("div"); mval.className = "val mval"
    const showMacro = () => { if (!mval.dataset.editing) mval.textContent = macroText(st.macroValues[m]) }
    input.addEventListener("input", showMacro); input.dataset.macro = String(m)
    attachNativeArrows(input)
    attachValueEdit(mval, { label: `Macro ${m + 1} value`, text: () => fmtNum(st.macroValues[m], MACRO_DECIMALS), fail: (msg) => status(msg, "err"),
      commit: (t) => { const v = parsePlain(t, { min: 0, max: 100, step: 0.5 }); if (v === null) return false; input.value = String(v); input.dispatchEvent(new Event("input", { bubbles: true })); return true } })
    const t = document.createElement("div"); t.className = "targets"
    card.append(input, mval, t); mc.append(card); els.macros[m] = { input, name: card.querySelector(".name"), targets: t, val: mval, show: showMacro }
  }
  renderMacroLabels()
  buildRandUi()
}

function renderMacroLabels() {
  for (let m = 0; m < 6; m++) {
    const mac = st.patch.macros[m]; const e = els.macros[m]
    e.name.textContent = mac?.name || `Macro ${m + 1}`
    e.input.value = st.macroValues[m]; fill(e.input); e.show()
    e.targets.textContent = (mac?.targets ?? []).map((t) => `${st.meta.params[t.param]?.name ?? "?"} ${t.amount >= 0 ? "+" : ""}${Math.round(t.amount * 100)}%`).join(", ") || "no targets"
  }
}

function paintParams() {
  st.meta.params.forEach((p, id) => {
    const e = els.params[id]; if (!e) return
    const v = st.patch.values[id] ?? p.def
    if (p.names) e.input.value = String(Math.round(v))
    else if (document.activeElement !== e.input) { e.input.value = st.knobs[id] ?? 0; fill(e.input) }
    if (e.val.dataset.editing) return // a value is being typed there
    const fin = st.finalTexts[id], base = st.texts[id]
    e.val.innerHTML = fin !== undefined && fin !== base ? `${base} <small>→ ${fin}</small>` : p.names ? "" : (base ?? "")
  })
}

// ---- state updates through the host
let descTimer = null
function scheduleDescribe() { clearTimeout(descTimer); descTimer = setTimeout(refresh, 40) }
let refreshSeq = 0 // the latest describe wins: an answer for an older patch state (before an undo, a roll, an engine switch) must not paint over the newer one
async function refresh() {
  const mine = ++refreshSeq
  const d = await api("POST", "/api/describe", { engine: st.engine, patch: st.patch, macroValues: st.macroValues })
  if (mine !== refreshSeq) return
  st.texts = d.texts; st.finalTexts = d.finalTexts; st.knobs = d.knobs; st.finalKnobs = d.finalKnobs
  paintParams()
}

const knobBusy = new Map()
async function onKnob(id, knob) {
  st.dirty = true
  liveSend({ cmd: "live.param", param: id, knob })
  if (knobBusy.has(id)) { knobBusy.set(id, knob); return }
  knobBusy.set(id, null)
  let k = knob
  while (k !== null && k !== undefined) {
    const r = await api("POST", "/api/knob", { engine: st.engine, param: id, knob: k, patch: st.patch })
    st.patch.values[id] = r.value; st.texts[id] = r.text; st.knobs[id] = k; syncEdits()
    const e = els.params[id]
    if (!e.val.dataset.editing) e.val.textContent = r.text
    scheduleDescribe()
    const next = knobBusy.get(id); knobBusy.set(id, null); k = next
  }
  knobBusy.delete(id)
}
async function setValue(id, value) { st.dirty = true; st.patch.values[id] = value; syncEdits(); liveSend({ cmd: "live.param", param: id, value }); await refresh() }

// ---- typed values and arrow keys (public/valuefield.js, server/typed.ts). A typed or arrowed value is a hand edit like a drag: setValue puts it in the one merged
// "edits" step of the history, the live stream gets it, a locked parameter takes it too (a lock only keeps Randomize away).
/** the text a parameter's value field starts with: the stored value's readout (without the macro "->" part) */
function typedText(id) { return st.texts[id] ?? "" }
/** a typed text on parameter `id`: true when it was applied, a message when it cannot be read */
async function commitTyped(id, text) {
  let value
  try { value = (await api("POST", "/api/typed", { engine: st.engine, param: id, text, patch: st.patch })).value }
  catch (e) { return e.message }
  if (Object.is(value, st.patch.values[id])) return true
  await setValue(id, value)
  return true
}
/**
 * one arrow key on the slider of parameter `id`. A whole-value parameter moves one value. A continuous one moves "fine" to the nearest knob position whose readout
 * differs (0.1 dB, 1 Hz, 1 ms: the host's own readout decides, POST /api/nudge), Shift is 1/100 of the travel and PageUp / PageDown a tenth.
 * Presses of one slider queue, each starts where the one before ended.
 */
const nudgeChain = new Map()
function nudgeParam(id, input, dir, size) {
  const run = () => nudgeNow(id, input, dir, size).catch((e) => status(String(e?.message ?? e), "err"))
  const next = (nudgeChain.get(id) ?? Promise.resolve()).then(run)
  nudgeChain.set(id, next)
  next.then(() => { if (nudgeChain.get(id) === next) nudgeChain.delete(id) })
  return next
}
async function nudgeNow(id, input, dir, size) {
  const p = st.meta.params[id]
  if (p.stepped && p.curve === "linear") {
    const v = movePosition((st.patch.values[id] ?? p.def) - p.min, dir, stepsOf(p), size) + p.min
    input.value = String((v - p.min) / (p.max - p.min)); fill(input)
    return setValue(id, v)
  }
  const pos = Math.round(Number(input.value) * K_STEPS)
  let to = movePosition(pos, dir, K_STEPS, size)
  if (size === "fine") {
    const shown = st.texts[id] // the text on screen: the previous press has set it, painted or not
    const hit = (await api("POST", "/api/nudge", { engine: st.engine, param: id, pos, dir, text: shown, patch: st.patch })).step
    if (!hit) return // the end of the travel: the readout cannot change that way
    to = hit.pos
    st.texts[id] = hit.text // so a quick next press does not wait for the paint
  }
  const k = to / K_STEPS
  input.value = String(k); fill(input)
  return onKnob(id, k)
}


// ---- randomizer (public/randomize.js has the maths, public/recipe.js the codes). Locks are remembered per engine in this browser,
// the rest of the panel (amount, macros toggle) too. The history lists every step of the current patch: the base, each roll with
// the settings it used, and the manual edits between rolls. It holds 200 steps and is dropped when a patch is loaded.
const LOCK_SVG = `<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`
const readJson = (key) => { try { return JSON.parse(localStorage.getItem(key) ?? "{}") } catch { return {} } }
const writeJson = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)) } catch {} }
const lockStore = readJson("poly-editor.locks")
const randPrefs = readJson("poly-editor.rand")
const rand = { history: createHistory(200), sections: new Set(), checkId: 0, busy: false, base: { kind: "init" } }
const locksOf = (engine) => new Set(lockStore[engine] ?? [])

function toggleLock(id) {
  const l = locksOf(st.engine)
  if (!l.delete(id)) l.add(id)
  setLocks([...l])
}
// Alt+Shift-click: lock every other parameter of the engine and leave this one free. Again on the only free one: unlock all.
// Locks are a browser preference, not a history step, so there is nothing to undo here (Unlock all is the way back too).
function soloLock(id) {
  const all = st.meta.params.map((_, i) => i)
  const l = locksOf(st.engine)
  const isSolo = !l.has(id) && l.size === all.length - 1
  setLocks(isSolo ? [] : all.filter((i) => i !== id))
}
function setLocks(ids) {
  const l = [...new Set(ids)].sort((a, b) => a - b)
  if (l.length) lockStore[st.engine] = l; else delete lockStore[st.engine]
  writeJson("poly-editor.locks", lockStore); paintLocks()
}
function paintLocks() {
  const l = locksOf(st.engine)
  st.meta.params.forEach((p, id) => {
    const e = els.params[id]; if (!e?.row) return
    const on = l.has(id)
    e.row.classList.toggle("locked", on); e.lock.setAttribute("aria-label", on ? `Unlock ${p.name}` : `Lock ${p.name}`)
    e.lock.setAttribute("aria-pressed", String(on))
  })
  $("randlocks").textContent = l.size ? `${l.size} locked` : ""
}
function buildRandUi() {
  rand.sections = new Set(sectionNames(st.meta))
  const box = $("randsecs"); box.innerHTML = ""
  for (const name of sectionNames(st.meta)) {
    const lab = document.createElement("label"); const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = true; cb.dataset.section = name
    cb.onchange = () => { if (cb.checked) rand.sections.add(name); else rand.sections.delete(name); lab.classList.toggle("off", !cb.checked) }
    lab.append(cb, " " + name); box.append(lab)
  }
  $("randamt").value = String(randPrefs.amount ?? 100); fill($("randamt")); $("randamtv").textContent = $("randamt").value + "%"
  $("randmacros").checked = !!randPrefs.macros
  seedMessage(""); $("randlast").textContent = ""; $("randlast").dataset.seed = ""; $("recipenote").textContent = ""
  paintLocks(); paintRandHistory()
}
$("randamt").oninput = () => { fill($("randamt")); $("randamtv").textContent = $("randamt").value + "%"; randPrefs.amount = Number($("randamt").value); writeJson("poly-editor.rand", randPrefs) }
attachNativeArrows($("randamt"))
attachValueEdit($("randamtv"), { label: "Randomizer amount", text: () => $("randamt").value, fail: (m) => status(m, "err"), commit: (t) => commitNative($("randamt"), parsePlain(t, { min: 0, max: 100, step: 1 })) })
$("randmacros").onchange = () => { randPrefs.macros = $("randmacros").checked; writeJson("poly-editor.rand", randPrefs) }
$("randunlock").onclick = () => { delete lockStore[st.engine]; writeJson("poly-editor.locks", lockStore); paintLocks() }
$("randlast").onclick = () => { if ($("randlast").dataset.seed) $("randseed").value = $("randlast").dataset.seed }

// What the panel says now, as the settings of a roll (seed null: the field is blank).
const controls = (seed, algo = ALGO) => rollSettings(st.meta, { seed: seed ?? 0n, algo, amount: Number($("randamt").value), sections: [...rand.sections], locks: locksOf(st.engine), macros: $("randmacros").checked })
// Put the panel back to the settings of a step (null: the base, no roll has produced this state: seed field and last seed are cleared).
function applyControls(s) {
  const last = $("randlast")
  if (!s) { $("randseed").value = ""; last.textContent = ""; last.dataset.seed = ""; return }
  const code = formatSeed(s.seed, s.algo)
  $("randseed").value = code
  last.textContent = `seed ${code}`; last.dataset.seed = code
  $("randamt").value = String(s.amount); fill($("randamt")); $("randamtv").textContent = s.amount + "%"
  $("randmacros").checked = s.macros
  const all = sectionNames(st.meta)
  rand.sections = new Set(s.sections ?? all)
  for (const cb of $("randsecs").querySelectorAll("input")) { cb.checked = rand.sections.has(cb.dataset.section); cb.parentElement.classList.toggle("off", !cb.checked) }
  setLocks(s.locks)
}

// ---- history
const snapshot = () => ({ values: [...st.patch.values], macros: structuredClone(st.patch.macros ?? []), dirty: st.dirty })
const sameState = (a, b) => a.values.length === b.values.length && a.values.every((v, i) => Object.is(v, b.values[i])) && JSON.stringify(a.macros) === JSON.stringify(b.macros)
/** A new base: Init, or a loaded patch ({ kind: "patch", name }). Drops every step. */
function resetHistory(base) {
  rand.base = base; rand.checkId++
  rand.history.reset({ kind: "base", label: base.kind === "patch" ? base.name : "Init", snap: { ...snapshot(), dirty: false } })
  if ($("randhist")) paintRandHistory()
}
// Manual knob moves become an "edits" step (several moves in a row are one step): called whenever the patch changed by hand, and
// before a roll or a jump so nothing is lost. A change on a step in the middle of the list drops the steps after it.
function syncEdits() {
  const cur = rand.history.current
  if (!cur || !st.patch || sameState(cur.snap, snapshot())) return
  const snap = { ...snapshot(), dirty: true }
  if (cur.kind === "edits") rand.history.replaceCurrent({ ...cur, snap, collapsed: false })
  else rand.history.push({ kind: "edits", snap })
  paintRandHistory()
}
const lastRoll = (i) => { for (; i >= 0; i--) if (rand.history.entries[i].kind === "roll") return rand.history.entries[i].settings; return null }
function entryLabel(e, i) {
  if (e.kind === "base") return e.label
  if (e.kind === "roll") return describeSettings(st.meta, e.settings)
  const n = Object.keys(diffEdits(rand.history.entries[i - 1].snap, e.snap).values).length
  return e.collapsed ? `earlier steps (${n} parameter${n === 1 ? "" : "s"} changed)` : `edits (${n} parameter${n === 1 ? "" : "s"})`
}
function paintRandHistory() {
  const h = rand.history
  $("randundo").disabled = !h.undoCount; $("randredo").disabled = !h.redoCount
  $("randundo").title = `${h.undoCount} step(s) kept`
  const ol = $("randhist"); ol.innerHTML = ""
  h.entries.forEach((e, i) => {
    const li = document.createElement("li"), b = document.createElement("button"), n = document.createElement("span")
    n.className = "n"; n.textContent = i === 0 ? "base" : "#" + i
    b.append(n, entryLabel(e, i)); b.type = "button"; b.dataset.index = String(i)
    b.onclick = () => jumpTo(i)
    li.className = i === h.index ? "cur" : i > h.index ? "fwd" : ""
    if (i === h.index) li.setAttribute("aria-current", "step")
    li.append(b); ol.append(li)
  })
  const cur = ol.querySelector("li.cur")
  if (cur) { if (cur.offsetTop < ol.scrollTop) ol.scrollTop = cur.offsetTop; else if (cur.offsetTop + cur.offsetHeight > ol.scrollTop + ol.clientHeight) ol.scrollTop = cur.offsetTop + cur.offsetHeight - ol.clientHeight }
}
// Land on a step: the patch and the unsaved-edits flag as they were, the panel as that step used it, the stream gets live.patch.
async function land(entry) {
  st.patch.values = [...entry.snap.values]; st.patch.macros = structuredClone(entry.snap.macros); st.dirty = entry.snap.dirty
  rand.checkId++; seedMessage("")
  applyControls(lastRoll(rand.history.index))
  renderMacroLabels(); liveSwap(); paintRandHistory(); await refresh()
}
async function jumpTo(i) {
  if (rand.busy || !st.meta) return
  syncEdits()
  const from = rand.history.current, entry = rand.history.goto(i)
  if (!entry || entry === from) { paintRandHistory(); return }
  await land(entry)
  status(`Step ${i === 0 ? "base" : "#" + i}: ${entryLabel(entry, i)}`)
}
async function randStep(kind) {
  if (rand.busy || !st.meta) return
  syncEdits()
  const from = rand.history.current, entry = rand.history[kind]()
  if (!entry) { status(kind === "undo" ? "Nothing to undo" : "Nothing to redo", "warn"); return }
  await land(entry)
  const what = (kind === "undo" ? from : entry).kind
  status(kind === "undo" ? (what === "roll" ? "Undid a randomize" : "Undid manual edits") : (what === "roll" ? "Redid a randomize" : "Redid manual edits"))
}

// A message next to the Seed field (the status line is far away and gets replaced): kind "err" for a seed that is refused, "warn" otherwise
function seedMessage(msg, kind = "warn") {
  const h = $("randhint"); h.textContent = msg; h.className = msg ? kind : ""; h.dataset.kind = msg ? kind : ""
  $("randseed").setAttribute("aria-invalid", String(kind === "err" && !!msg))
}
const samePatchState = (a, b) => a.values.length === b.values.length && a.values.every((v, i) => Object.is(v, b.values[i])) && JSON.stringify(a.macros ?? []) === JSON.stringify(b.macros ?? [])
async function doRandomize() {
  if (rand.busy || !st.meta) return
  rand.busy = true
  try {
    syncEdits()
    let parsed
    // a seed that is refused is never silent: the reason is shown next to the field and in the status line, and nothing is rolled
    try { parsed = parseSeed($("randseed").value) } catch (e) { seedMessage("Seed refused: " + e.message, "err"); status("Seed: " + e.message, "err"); return }
    if (parsed?.algo != null && !ALGORITHMS[parsed.algo]) { seedMessage("Seed refused: " + unknownAlgo(parsed.algo), "err"); status("Seed: " + unknownAlgo(parsed.algo), "err"); return }
    const seed = parsed?.seed ?? newSeed(), algo = parsed?.algo ?? ALGO
    const settings = controls(seed, algo), code = formatSeed(seed, algo)
    $("randlast").textContent = `seed ${code}`; $("randlast").dataset.seed = code; seedMessage("")
    const { plan, patch } = applyRoll(st.meta, st.patch, settings)
    if (!plan.touched) { status(plan.percent === 0 ? "Amount is 0%: nothing to change" : "Nothing to randomize: every section is off or every parameter is locked", "warn"); return }
    // The same seed on the same patch at the same settings always lands on the same values (at Amount 100% on the same targets), so rolling it
    // again is a no-op. Say so instead of reporting a roll that changed nothing, and keep it out of the history.
    if (samePatchState(patch, st.patch)) {
      const why = parsed ? `Same seed, same result: the Seed field holds ${JSON.stringify($("randseed").value.trim())} (seed ${code}), and this patch already is what that seed gives at ${settings.amount}%, so rolling it again changes nothing. Clear the Seed field (R and Randomize then draw a new seed) or type another seed${settings.amount < 100 ? "" : ", or lower Amount"}`
        : `The roll landed on the values the patch already has at ${settings.amount}%. Roll again (R) for another draw`
      seedMessage(why, "warn"); status(why, "warn"); return
    }
    st.patch = patch; st.dirty = true
    rand.history.push({ kind: "roll", settings, snap: snapshot() })
    renderMacroLabels(); liveSwap(); await refresh(); paintRandHistory()
    status(`Randomized ${Object.keys(plan.values).length} parameter(s)${plan.macros.length ? ` and ${plan.macros.length} macro amount(s)` : ""} at ${settings.amount}%, seed ${code}. Ctrl/Cmd+Z undoes`)
    checkAudible()
  } catch (e) { seedMessage("Randomize failed: " + e.message, "err"); status("Randomize failed: " + e.message, "err") } finally { rand.busy = false }
}
// A silent result is kept (no retry loop): a short render of the new patch says so in a hint.
async function checkAudible() {
  const id = ++rand.checkId
  try {
    const r = await api("POST", "/api/render", { engine: st.engine, patch: st.patch, macroValues: st.macroValues, note: st.engine === "TTYPE" ? 60 : 57, velocity: 100, seconds: 0.8, hold: 0.5 })
    if (id !== rand.checkId) return
    const peak = Number(r.headers.get("x-render-peak"))
    seedMessage(Number.isFinite(peak) && peak >= SILENT_PEAK ? "" : "This result is silent (or not a number). It is kept: roll again (R) or undo (Ctrl/Cmd+Z)")
    $("randhint").dataset.peak = String(peak)
  } catch { /* the render is only a hint */ }
}
$("randgo").onclick = doRandomize
// R rolls only outside text fields (a seed may contain an r), so inside the Seed field Enter rolls. Typing clears an old refusal.
$("randseed").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); doRandomize() } })
$("randseed").addEventListener("input", () => { if ($("randhint").dataset.kind === "err" || $("randhint").dataset.kind === "warn") seedMessage("") })
$("randundo").onclick = () => randStep("undo")
$("randredo").onclick = () => randStep("redo")

// ---- recipes and roll codes (public/recipe.js)
const note = (msg, kind = "") => { const n = $("recipenote"); n.textContent = msg; n.className = kind ? "dim " + kind : "dim" }
// The base of the history as a recipe base: Init, or the loaded patch's name and a short hash of its encoded bytes.
async function baseInfo() {
  if (rand.base.kind !== "patch") return { kind: "init" }
  return { kind: "patch", name: rand.base.name, hash: await patchHash(entryPatch(rand.history.entries[0])) }
}
const entryPatch = (entry) => ({ ...st.patch, values: [...entry.snap.values], macros: structuredClone(entry.snap.macros) })
const patchHex = async (patch) => (await api("POST", "/api/encode", { patch })).hex
const patchHash = async (patch) => shortHash(await patchHex(patch))
async function copyText(text) {
  const f = $("recipetext"); f.value = text
  try { await navigator.clipboard.writeText(text); return true } catch { f.focus(); f.select(); return false }
}
$("recipecopy").onclick = async () => {
  if (!st.meta) return
  try {
    syncEdits()
    const h = rand.history, recipe = buildRecipe(st.meta, st.engine, await baseInfo(), h.entries, h.index, await patchHash(entryPatch(h.current)), st.firmware.tag)
    const text = encodeRecipe(recipe)
    const ok = await copyText(text)
    const algos = [...new Set(h.entries.slice(1, h.index + 1).filter((e) => e.kind === "roll").map((e) => e.settings.algo))]
    note(`Recipe of ${recipe.s.length} step${recipe.s.length === 1 ? "" : "s"}, ${text.length} characters, algorithm ${algos.length ? algos.join(" and ") : ALGO}. ${ok ? "Copied to the clipboard." : "It is in the field: select it and copy it (Ctrl/Cmd+C)."}`)
  } catch (e) { note("Could not make the recipe: " + e.message, "err") }
}
$("rollcopy").onclick = async () => {
  const s = lastRoll(rand.history.index)
  if (!s) { note("There is no roll yet in this history: roll first", "warn"); return }
  const text = encodeRollCode(st.engine, s)
  const ok = await copyText(text)
  note(`Roll code of seed ${formatSeed(s.seed, s.algo)} at ${s.amount}%. ${ok ? "Copied to the clipboard." : "It is in the field: select it and copy it (Ctrl/Cmd+C)."}`)
}
// A recipe replaces the patch and the history, so it asks like a patch load does when there are unsaved edits.
async function confirmReplace(what) { if (!st.dirty) return true; const a = await askDiscard(what); return !!a?.ok }
async function pasteCode() {
  if (rand.busy || !st.meta) return
  rand.busy = true
  try {
    if (!$("recipetext").value.trim()) { try { $("recipetext").value = await navigator.clipboard.readText() } catch { /* no clipboard access: the field stays empty */ } }
    let code
    try { code = decodeCode($("recipetext").value) } catch (e) { note(e.message, "err"); return }
    if (!st.engines.some((x) => x.name === code.engine)) {
      if (st.release) { note("The code is for an engine that this editor does not offer, so it cannot be opened here", "err"); return }
      note(HIDDEN_ENGINES[code.engine] ? `The code is for ${HIDDEN_ENGINES[code.engine]}, which this editor hides: it is not on your Tracker release, so it cannot be opened here` : `The code is for engine ${code.engine}, which this editor does not have`, "err"); return
    }
    if (code.type === "roll") {
      if (code.engine !== st.engine) {
        if (!(await confirmReplace(`the ${code.engine} engine`))) return
        await selectEngine(code.engine)
      }
      applyControls(code.settings)
      note(`Roll code applied to the current patch: seed ${formatSeed(code.settings.seed, code.settings.algo)} at ${code.settings.amount}%`)
      rand.busy = false; await doRandomize(); return
    }
    if (!(await confirmReplace("the recipe"))) return
    if (code.engine !== st.engine) await selectEngine(code.engine)
    await replayRecipe(code)
  } catch (e) { note("Paste failed: " + e.message, "err") } finally { rand.busy = false }
}
async function replayRecipe(code) {
  // the base: Init, or the patch the recipe names when it is there with the same hash, else what is loaded now (with a warning)
  let base = { kind: "init" }, basePatch = structuredClone(st.meta.init), warn = ""
  if (code.base.kind === "patch") {
    const loaded = rand.base.kind === "patch" ? rand.base : null
    const cur = rand.history.entries[0]
    let ok = false
    if (loaded?.name === code.base.name && cur) {
      const p = entryPatch(cur)
      if ((await patchHash(p)) === code.base.hash) { base = loaded; basePatch = p; ok = true }
    }
    if (!ok && (st.dir || st.defaults)) {
      try {
        const r = await api("POST", "/api/load", st.defaults ? { engine: st.engine, bundled: true, name: code.base.name } : { engine: st.engine, dir: st.dir, name: code.base.name })
        if ((await patchHash(r.patch)) === code.base.hash) { base = { kind: "patch", name: code.base.name }; basePatch = r.patch; ok = true }
        else warn = `the patch ${code.base.name} in the folder is not the one the recipe was made from (hash differs)`
      } catch { warn = `no patch named ${code.base.name} in the folder` }
    }
    if (!ok) {
      base = rand.base.kind === "patch" ? rand.base : { kind: "init" }
      basePatch = rand.history.entries[0] ? entryPatch(rand.history.entries[0]) : structuredClone(st.meta.init)
      warn = `Warning: the recipe starts from the patch ${code.base.name} (hash ${code.base.hash}) but ${warn || "it is not the loaded patch"}. Replaying from ${base.kind === "patch" ? base.name : "Init"} instead, so the sound will differ.`
    }
  }
  const { entries, patch } = replaySteps(st.meta, basePatch, code.steps)
  if (!warn) warn = resultWarning(code, await patchHex(patch)) ?? ""
  warn = [firmwareWarning(code, st.firmware.tag), warn].filter(Boolean).join(" ")
  st.patch = patch; st.macroValues = neutralMacros()
  st.dirty = false; resetHistoryFrom(base, basePatch, entries)
  st.dirty = entries.length > 0
  if (base.kind === "patch") { loader.setCurrent(base.name); if ([...$("patches").options].some((o) => o.value === base.name)) $("patches").value = base.name } else loader.setCurrent(null)
  patchCombo.sync()
  applyControls(lastRoll(rand.history.index))
  renderMacroLabels(); liveSwap(); await refresh(); paintRandHistory()
  const n = entries.length
  note(warn || `Replayed ${n} step${n === 1 ? "" : "s"} from ${base.kind === "patch" ? base.name : "Init"}`, warn ? "warn" : "")
  status(`Recipe replayed: ${n} step${n === 1 ? "" : "s"}`, warn ? "warn" : "")
  if (n) checkAudible()
}
function resetHistoryFrom(base, basePatch, entries) {
  rand.base = base; rand.checkId++
  rand.history.reset({ kind: "base", label: base.kind === "patch" ? base.name : "Init", snap: { values: [...basePatch.values], macros: structuredClone(basePatch.macros ?? []), dirty: false } })
  for (const e of entries) rand.history.push(e)
}
$("recipepaste").onclick = pasteCode
$("recipetext").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); pasteCode() } })

// R rolls, Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z or Ctrl+Y redoes. Not while text is being typed (a text or number field, a list) or a dialog is open.
const typingTarget = () => {
  const a = document.activeElement
  if (!a) return false
  if (a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable) return true
  return a.tagName === "INPUT" && !["range", "checkbox", "radio", "button"].includes(a.type)
}
window.addEventListener("keydown", (e) => {
  if (typingTarget() || $("discard").open) return
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase()
  if (mod && !e.altKey && k === "z") { e.preventDefault(); randStep(e.shiftKey ? "redo" : "undo") }
  else if (e.ctrlKey && !e.altKey && k === "y") { e.preventDefault(); randStep("redo") }
  else if (!mod && !e.altKey && !e.shiftKey && !e.repeat && k === "r") { e.preventDefault(); doRandomize() }
})

// ---- files
let listSeq = 0 // answers can arrive out of order (engine switched fast): only the latest request may fill the list, in one go
async function refreshPatchList() {
  const sel = $("patches"), mine = ++listSeq
  const engine = st.engine
  rate.map = new Map(); rate.readOnly = true
  if (!st.dir) { // no folder: the bundled default patches, listed from their static manifest. No stars here and no /api/ratings call.
    st.defaults = true
    const names = defaultNames(await fetchManifest(), engine)
    if (mine !== listSeq) return
    const opts = names.map((n) => { const o = document.createElement("option"); o.value = o.textContent = n; return o })
    if (!opts.length) { const o = document.createElement("option"); o.value = ""; o.textContent = STATIC ? `(no bundled ${engine} defaults yet, start from Init or Open file)` : `(no default ${engine} patches, set a folder)`; opts.push(o) }
    sel.replaceChildren(...opts)
    patchCombo?.sync()
    return
  }
  st.defaults = false
  const q = `engine=${engine}&dir=${encodeURIComponent(st.dir)}`
  const [r, stars] = await Promise.all([api("GET", `/api/patches?${q}`), api("GET", `/api/ratings?${q}`).catch(() => ({ ratings: {}, readOnly: true }))]) // no ratings is never an error
  if (mine !== listSeq) return
  rate.map = new Map(Object.entries(stars.ratings ?? {})); rate.readOnly = !!stars.readOnly
  const opts = r.names.map((n) => { const o = document.createElement("option"); o.value = o.textContent = n; return o })
  if (!opts.length) { const o = document.createElement("option"); o.value = ""; o.textContent = `(no ${engine} patches in ${r.root})`; opts.push(o) }
  sel.replaceChildren(...opts)
  patchCombo?.sync()
}

$("setdir").onclick = async () => {
  try {
    const r = await api("POST", "/api/config", { dir: $("dir").value.trim() })
    st.dir = r.dir; await refreshPatchList()
    status(r.exists ? "Folder set" : "Folder does not exist yet (it is created on save)", r.exists ? "" : "warn")
  } catch (e) { status(e.message, "err") }
}
$("dir").addEventListener("keydown", (e) => { if (e.key === "Enter") $("setdir").click() })

// Choosing a patch in the list loads it at once (public/loader.js). Notes that are held keep sounding, now with the new patch.
function askDiscard(name) {
  const d = $("discard"); $("discardmsg").textContent = `The current patch has unsaved edits. Replace it with ${name}?`
  $("discardquiet").checked = false
  return new Promise((resolve) => {
    const done = (ok) => { d.close(); resolve({ ok, dontAsk: ok && $("discardquiet").checked }) }
    $("discardyes").onclick = () => done(true)
    $("discardno").onclick = () => done(false)
    d.oncancel = (e) => { e.preventDefault(); done(false) }
    d.showModal(); $("discardyes").focus()
  })
}
const loader = createPatchLoader({
  getDirty: () => st.dirty,
  ask: askDiscard,
  fetchPatch: (name) => api("POST", "/api/load", st.defaults ? { engine: st.engine, bundled: true, name } : { engine: st.engine, dir: st.dir, name }),
  async apply(name, r) {
    st.patch = r.patch; st.dirty = false; resetHistory({ kind: "patch", name })
    st.macroValues = neutralMacros()
    renderMacroLabels(); liveSwap(); await refresh()
    $("name").value = name; patchCombo?.sync()
    status(r.warnings?.length ? `Loaded ${name}. Warning: ${r.warnings.join("; ")}` : `Loaded ${name} (${r.size} bytes)`, r.warnings?.length ? "warn" : "")
  },
  revert: (name) => { if (name !== null && [...$("patches").options].some((o) => o.value === name)) $("patches").value = name; patchCombo?.sync() },
  onError: (e, name) => status(`Load of ${name} failed: ${e.message}`, "err"),
})
$("patches").addEventListener("change", () => loader.select($("patches").value)) // the hidden list is the model: the search field below sets it and fires this
$("load").onclick = () => loader.reload($("patches").value)
// ---- ratings: 0 to 5 stars per patch, kept in ratings.json next to the patches (server/ratings.ts). A star click sets, the same star again clears.
// The star buttons never take the focus from a mouse press, so the computer keys keep playing notes after a click.
const rate = { map: new Map(), readOnly: true }
function paintStars() {
  $("stars").hidden = !!st.defaults // the default set has no rating control at all
  const cur = loader.current, n = cur ? rate.map.get(cur) || 0 : 0
  const can = !!cur && !rate.readOnly && [...$("patches").options].some((o) => o.value === cur)
  for (const b of $("stars").querySelectorAll("button")) {
    const k = Number(b.dataset.star)
    b.classList.toggle("on", k <= n); b.setAttribute("aria-pressed", String(k === n)); b.disabled = !can
  }
  $("stars").title = !cur ? "" : rate.readOnly ? "Ratings of this folder are read-only" : `${n} of 5`
}
async function setRating(k) {
  const name = loader.current, engine = st.engine, dir = st.dir
  if (!name || rate.readOnly) return
  const prev = rate.map.get(name) || 0, next = prev === k ? 0 : k
  const same = () => st.engine === engine && st.dir === dir
  const put = (v) => { if (v) rate.map.set(name, v); else rate.map.delete(name); paintStars() }
  put(next)
  try {
    const r = await api("PUT", "/api/ratings", { engine, dir, name, stars: next })
    if (same()) { rate.map = new Map(Object.entries(r.ratings)); paintStars() }
    status(next ? `Rated ${name}: ${next} of 5` : `Cleared the rating of ${name}`)
  } catch (e) {
    if (same()) put(prev)
    status("Rating failed: " + e.message, "err")
  }
}
for (const type of ["pointerdown", "mousedown"]) $("stars").addEventListener(type, (e) => e.preventDefault()) // a mouse press must not move the focus onto a button
$("stars").addEventListener("click", (e) => { const b = e.target.closest?.("button[data-star]"); if (b && !b.disabled) setRating(Number(b.dataset.star)) })
// The patch search: type to filter the names of the folder of this engine, Arrow Up / Down move, Enter loads, Escape closes. Picking and closing let go of the focus.
const patchNames = () => [...$("patches").options].map((o) => o.value).filter(Boolean)
const patchCombo = attachCombobox({
  input: $("patchsearch"), list: $("patchlist"),
  getNames: patchNames,
  getCurrent: () => loader.current,
  getEmpty: () => $("patches").options[0]?.textContent || "No patches",
  getRating: (name) => rate.map.get(name) || 0,
  hasRatings: () => !st.defaults,
  onSync: paintStars,
  onPick: (name) => { $("patches").value = name; $("patches").dispatchEvent(new Event("change", { bubbles: true })) },
})

$("save").onclick = async () => {
  const name = $("name").value.trim()
  if (STATIC) { await downloadPatch(name); return }
  if (!name) { status("Give the patch a name first", "warn"); return }
  if (!st.dir) { status("Set a patch folder first", "warn"); return }
  try {
    let overwrite = false
    try { await api("POST", "/api/save", { dir: st.dir, name, patch: st.patch }) }
    catch (e) {
      if (e.message !== "exists") throw e
      if (!confirm(`${name}.patch exists in ${st.engine}. Overwrite?`)) return
      overwrite = true; await api("POST", "/api/save", { dir: st.dir, name, patch: st.patch, overwrite })
    }
    await refreshPatchList(); $("patches").value = name
    st.dirty = false; loader.setCurrent(name); patchCombo.sync()
    status(`Saved ${st.engine}/${name}.patch`)
  } catch (e) { status("Save failed: " + e.message, "err") }
}
$("init").onclick = () => { st.patch = structuredClone(st.meta.init); st.dirty = false; resetHistory({ kind: "init" }); loader.setCurrent(null); patchCombo.sync(); st.macroValues = neutralMacros(); renderMacroLabels(); liveSwap(); refresh(); status("Init patch") }

// ---- files of the static site: no folder. Open reads a .patch from the disk (any engine of this site: the page switches to it), Save downloads one.
function staticFiles() {
  $("dir").closest(".grp").hidden = true
  const pick = document.createElement("input"); Object.assign(pick, { type: "file", accept: ".patch", hidden: true, id: "openfile" })
  const btn = document.createElement("button"); btn.id = "open"; btn.textContent = "Open file"; btn.title = "Open a .patch file from your computer or the Tracker's card"
  btn.onclick = () => pick.click()
  pick.onchange = () => { const f = pick.files?.[0]; pick.value = ""; if (f) openFile(f) }
  $("load").after(btn, pick)
  $("save").textContent = "Save file"; $("save").title = "Download the patch as <name>.patch (copy it to Patches/<ENGINE>/ on the card)"
}
async function openFile(file) {
  const name = file.name.replace(/\.patch$/i, "").slice(0, 64)
  try {
    const r = await (await staticApi()).openPatchFile(file)
    if (st.dirty && !(await askDiscard(name)).ok) return
    if (r.engine !== st.engine) await selectEngine(r.engine)
    st.patch = r.patch; st.dirty = false; resetHistory({ kind: "patch", name })
    st.macroValues = neutralMacros()
    renderMacroLabels(); liveSwap(); await refresh()
    $("name").value = name; loader.setCurrent(null); patchCombo?.sync()
    status(r.warnings?.length ? `Opened ${file.name}. Warning: ${r.warnings.join("; ")}` : `Opened ${file.name} (${r.size} bytes)`, r.warnings?.length ? "warn" : "")
  } catch (e) { status(`Open of ${file.name} failed: ${e.message}`, "err") }
}
async function downloadPatch(typed) {
  const name = saveName(typed) // what the file is really called: the name box shows it too, so the status line and the file agree
  try {
    const bytes = await (await staticApi()).patchFile(st.patch)
    const a = document.createElement("a")
    a.href = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" })); a.download = name + ".patch"
    window.__lastDownload = { name: a.download, bytes: [...bytes] } // the static site test reads it
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000)
    st.dirty = false; $("name").value = name
    status(`Saved ${name}.patch (${bytes.length} bytes) to your downloads: copy it to Patches/${st.engine}/ on the card`)
  } catch (e) { status("Save failed: " + e.message, "err") }
}

// ---- live audio: notes and knobs go to the native host over a WebSocket, its audio comes back as 128 sample blocks into an
// AudioWorklet jitter buffer (public/worklet.js). Off by default, the per-note render below is the fallback.
const live = { gapMax: 0, lastMsg: 0, on: false, ws: null, node: null, nextId: 1, sent: new Map(), stats: null, heardMs: null, loaded: false, down: new Map() }
const TARGET_FRAMES = 384 // jitter buffer target: 3 blocks, 8.7 ms at 44.1 kHz

function liveSend(msg, track = false) {
  if (!live.on || live.ws?.readyState !== WebSocket.OPEN) return
  if (track) { msg.id = live.nextId++; live.sent.set(msg.id, performance.now()); if (live.sent.size > 64) live.sent.delete(live.sent.keys().next().value) }
  live.ws.send(JSON.stringify(msg))
}
const liveOpen = () => liveSend({ cmd: "live.open", engine: st.engine, patch: st.patch, macroValues: st.macroValues, voices: voicesOf(st.engine), strict: st.strict })
// a patch swap keeps the voices (and the held notes) sounding, liveOpen cuts them
const liveSwap = () => liveSend({ cmd: "live.patch", patch: st.patch, macroValues: st.macroValues })
const lit = new Set() // notes lit on the on-screen keys by the live path (computer keys, mouse, MIDI), kept so an octave shift can paint them again
const liveNote = (on, note, velocity = Number($("vel").value)) => {
  liveSend({ cmd: "live.note", on, note, velocity }, on)
  if (on) lit.add(note); else lit.delete(note)
  const k = keysEl.querySelector(`[data-note="${note}"]`); if (k) k.classList.toggle("down", on)
}
function liveStatus() {
  const b = $("livestate"); if (!live.on) { b.textContent = ""; return }
  const s = live.stats; if (!s) { b.textContent = "connecting…"; return }
  const buf = (s.target / 44117.647) * 1000, dev = ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000
  b.textContent = `buffer ${buf.toFixed(1)} ms (target) + output ${dev.toFixed(1)} ms` + (live.heardMs != null ? `, last note ${live.heardMs.toFixed(0)} ms to the worklet output` : "") + `, underruns ${s.underruns}, longest gap between blocks ${live.gapMax.toFixed(0)} ms`
}

async function startLive() {
  ctx ??= new AudioContext({ latencyHint: "interactive" })
  await ctx.resume()
  await ins.ready
  if (STATIC) return startStaticLive()
  if (!live.loaded) {
    // the worklet with the Mixer and the master inserts needs the wasm host (bun run build:wasm), else the plain jitter buffer
    try { await insHost(); await ctx.audioWorklet.addModule("/worklet-inserts.js"); live.loaded = "inserts" } catch (e) { insProblem("master inserts off in live audio: " + e.message) }
    if (!live.loaded) { await ctx.audioWorklet.addModule("/worklet.js"); live.loaded = "plain" }
  }
  const node = new AudioWorkletNode(ctx, "poly-live", { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { engineRate: 44117.647, target: TARGET_FRAMES } })
  node.connect(ctx.destination)
  ins.node = live.loaded === "inserts" ? node : null
  node.port.onmessage = (e) => {
    const m = e.data
    if (m.type === "chain-ready") { ins.live = true; insStatus() }
    else if (m.type === "chain-error") { ins.live = false; insProblem("live chain: " + m.error) }
    else if (m.type === "stats") { live.stats = m; ins.heard = { rms: m.rms, peak: m.peak }; liveStatus() }
    else if (m.type === "heard") {
      const t0 = live.sent.get(m.cmdId); if (t0 === undefined) return
      const ts = ctx.getOutputTimestamp(), played = ts.performanceTime + (m.frame / ctx.sampleRate - ts.contextTime) * 1000
      live.heardMs = Math.max(0, played - t0); live.sent.delete(m.cmdId)
    }
  }
  const ws = new WebSocket(`ws://${location.host}/api/live`)
  ws.binaryType = "arraybuffer"
  ws.onopen = () => liveOpen()
  ws.onmessage = (e) => {
    if (typeof e.data === "string") { const m = JSON.parse(e.data); if (m.ok === false) status("Live: " + m.error, "err"); return }
    const now = performance.now(); if (live.lastMsg) live.gapMax = Math.max(live.gapMax, now - live.lastMsg); live.lastMsg = now
    const dv = new DataView(e.data)
    const pcm = new Float32Array(e.data.slice(24))
    live.voiceNow = dv.getUint32(16, true); live.heldNow = dv.getUint32(20, true); paintVoices()
    node.port.postMessage({ type: "frames", pcm, cmdId: dv.getUint32(8, true) }, [pcm.buffer])
  }
  ws.onclose = () => { if (live.ws === ws) stopLive("Live audio connection closed, back to per-note render", "warn") }
  Object.assign(live, { on: true, ws, node, stats: null, heardMs: null, gapMax: 0, lastMsg: 0 })
  if (ins.node) startChain(node)
  $("livebtn").classList.add("on"); $("livebtn").textContent = "Live audio: on"
  status("Live audio on")
}
/** Live audio of the static site: the wasm host in the AudioWorklet (worklet-static.js), the page sends it the request lines the server page sends over the WebSocket. */
async function startStaticLive() {
  const sapi = await staticApi()
  const { host, engines } = await sapi.liveHost()
  if (!live.loaded) { await ctx.audioWorklet.addModule("/worklet-static.js"); live.loaded = "static" }
  const node = new AudioWorkletNode(ctx, "poly-live", { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { engineRate: 44117.647, target: TARGET_FRAMES } })
  node.connect(ctx.destination)
  ins.node = node
  // what liveSend writes to: the WebSocket of the server page, here the worklet's port. Open once the host in the worklet is up
  const link = { readyState: WebSocket.CONNECTING, send: (s) => node.port.postMessage({ type: "line", line: JSON.parse(s) }), close() { link.readyState = WebSocket.CLOSED } }
  // a worklet that never answers (a browser that refuses what was posted, a processor that threw) must not leave "Live audio: on" and silence
  const fail = (why) => { clearTimeout(watchdog); if (live.ws === link) stopLive("Live audio failed: " + why + ". Using the per-note render.", "err") }
  const watchdog = setTimeout(() => fail("the audio worklet did not start within 10 s"), 10000)
  node.onprocessorerror = () => fail("the audio worklet stopped with an error")
  node.port.onmessageerror = () => fail("this browser could not pass the sound engine to the audio worklet")
  node.port.onmessage = (e) => {
    const m = e.data
    if (m.type === "host-ready") { clearTimeout(watchdog); link.readyState = WebSocket.OPEN; liveOpen() }
    else if (m.type === "host-error") { clearTimeout(watchdog); if (live.ws === link) stopLive("Live audio failed: " + m.error + ". Using the per-note render.", "err") }
    else if (m.type === "answer") status("Live: " + m.answer.error, "err")
    else if (m.type === "voices") { live.voiceNow = m.voices; live.heldNow = m.held; paintVoices() }
    else if (m.type === "chain-ready") { ins.live = true; insStatus() }
    else if (m.type === "chain-error") { ins.live = false; insProblem("live chain: " + m.error) }
    else if (m.type === "stats") { live.stats = m; ins.heard = { rms: m.rms, peak: m.peak }; liveStatus() }
    else if (m.type === "heard") {
      const t0 = live.sent.get(m.cmdId); if (t0 === undefined) return
      const ts = ctx.getOutputTimestamp(), played = ts.performanceTime + (m.frame / ctx.sampleRate - ts.contextTime) * 1000
      live.heardMs = Math.max(0, played - t0); live.sent.delete(m.cmdId)
    }
  }
  node.port.postMessage({ type: "host-init", host, engines })
  Object.assign(live, { on: true, ws: link, node, stats: null, heardMs: null, gapMax: 0, lastMsg: 0 })
  startChain(node)
  $("livebtn").classList.add("on"); $("livebtn").textContent = "Live audio: on"
  status("Live audio on")
}
function stopLive(msg, kind = "") {
  live.ws?.close(); live.node?.disconnect(); live.node?.port.close()
  Object.assign(live, { on: false, ws: null, node: null, stats: null }); live.down.clear(); paintVoices()
  ins.node = null; ins.live = false; ins.heard = null
  $("livebtn").classList.remove("on"); $("livebtn").textContent = "Live audio: off"; liveStatus()
  lit.clear(); for (const k of keysEl.querySelectorAll(".down")) k.classList.remove("down")
  if (msg) status(msg, kind)
}
$("livebtn").onclick = async () => {
  if (live.on) { stopLive("Live audio off"); return }
  try { await startLive() } catch (e) { stopLive("Live audio failed: " + e.message + ". Using the per-note render.", "err") }
}
// the window lost focus: let go of the keys held with the mouse or the computer keyboard (a MIDI controller keeps working in the background)
window.addEventListener("blur", () => { if (live.on) for (const [k, n] of [...live.down]) { live.down.delete(k); liveNote(false, n) } })

// ---- master inserts: the Mixer and the two insert slots of the device's Inserts page (public/inserts.js). The modules are the runtime .wasm
// modules the server installed (scripts/modules.ts): the public inserts always, the private ones (Console, Tube) only where their set is installed.
// A choice stored for a module that is not installed here stays in the state, the slot shows it as missing and plays empty.
// Live audio runs the chain in the AudioWorklet (worklet-inserts.js), the per-note render runs it here on the float WAV the server returns.
const insStore = "poly-editor.inserts"
const FX_TAIL = 8 // seconds of silence a per-note render may be extended by for the tail of the delay and the reverb
const ins = { mods: [], problems: [], state: emptyState(), node: null, live: false, heard: null, chain: null, hostP: null, ready: null }
window.__inserts = ins // the page test reads it

const insMod = (name) => ins.mods.find((m) => m.man.name === name)
// something that changes the sound: the Mixer is not Hard Clip, a slot holds a module that is installed, the engine sends to the delay or the reverb, or the limiter is on
const insActive = () => ins.state.mixer !== 0 || ins.state.slots.some((s) => s.name && insMod(s.name)) || fxSending(ins.state, st.engine) || limiterOn(ins.state)
const insSave = () => { try { localStorage.setItem(insStore, JSON.stringify(ins.state)) } catch {} }
// what the chain gets: the state and the loaded engine's own sends
const insPost = () => { if (ins.node) ins.node.port.postMessage({ type: "chain-state", state: { ...ins.state, send: sendOf(ins.state, st.engine) } }) }
function insChanged() {
  insSave()
  insPost()
  insStatus()
}
function initInserts() {
  buildInsertsUi()
  return (ins.ready = (async () => {
    try {
      const r = await loadInsertModules()
      ins.mods = r.inserts; ins.problems.push(...r.problems)
    } catch (e) { ins.problems.push(String(e.message ?? e)) }
    ins.state = normalizeState(readJson(insStore), ins.mods)
    paintInserts()
    ins.loaded = true
  })())
}
const insProblem = (msg) => { if (!ins.problems.includes(msg)) ins.problems.push(msg); insStatus() }
/** The wasm host { module, bytes }, once (a failure is not cached: building it later and reloading the page is enough). */
function insHost() {
  return (ins.hostP ??= loadHost().catch((e) => { ins.hostP = null; throw new Error("no wasm host (" + e.message + ")") }))
}
function startChain(node) {
  insHost().then((host) => {
    if (live.node !== node) return
    // bytes, not compiled modules: Chrome 146 refuses a WebAssembly.Module posted to an AudioWorklet and fails without a word
    node.port.postMessage({ type: "chain-init", host: host.bytes, inserts: ins.mods.map((m) => ({ module: m.bytes, man: m.man })) })
    insPost()
  }, (e) => insProblem(e.message))
}
/** The per-note render through the chain: a float32 WAV in, a stereo AudioBuffer at the engine's rate out. */
async function renderThroughChain(wav) {
  const w = parseFloatWav(wav)
  if (!w) throw new Error("the render is not a float WAV")
  if (!ins.chain) {
    const factory = (await import("/wasm/runtime/poly.mjs")).default
    ins.chain = await InsertChain.create(factory, (await insHost()).module, ins.mods.map((m) => ({ module: m.module, man: m.man })))
  }
  ins.chain.reset() // a fresh render starts from the module's initial state, not the tail of the last one
  ins.chain.apply(ins.state, sendOf(ins.state, st.engine))
  // the delay and the reverb ring on after the note: the input gets silence appended (up to FX_TAIL seconds) and the render is cut where the tail has died away
  // The master section holds a block for two passes of the audio library (the device's update order, docs/fx-device-facts.md): the input gets those 256 frames of silence
  // appended and the first 256 frames of the answer are dropped, so the render lines up with the note as the per-note render always did.
  const sending = fxSending(ins.state, st.engine)
  // the limiter, when it is on, holds the signal for its look-ahead of 5 samples (LIMITER_DELAY)
  const lag = 256 + (limiterOn(ins.state) ? 5 : 0), len = w.samples.length
  const total = lag + len + (sending ? Math.round(FX_TAIL * w.rate) : 0)
  const input = new Float32Array(total); input.set(w.samples)
  const l = new Float32Array(total), r = new Float32Array(total)
  ins.chain.processMono(input, l, r)
  let n = total - lag
  if (sending) {
    const quiet = 3 / 32768 // a few LSB of the 16 bit bus
    while (n > len && Math.abs(l[n + lag - 1]) < quiet && Math.abs(r[n + lag - 1]) < quiet) n--
    n = Math.min(total - lag, n + Math.round(0.05 * w.rate))
  }
  const buf = ctx.createBuffer(2, n, w.rate)
  buf.copyToChannel(l.subarray(lag, lag + n), 0); buf.copyToChannel(r.subarray(lag, lag + n), 1)
  return buf
}

function insStatus() {
  const note = $("insnote")
  const miss = ins.state.slots.filter((s) => s.name && !insMod(s.name)).map((s) => s.name)
  const lines = []
  if (!ins.mods.length) lines.push("No insert modules are installed")
  if (miss.length) lines.push(`${[...new Set(miss)].join(" and ")} ${miss.length > 1 ? "are" : "is"} not installed`)
  if (ins.problems.length) lines.push(ins.problems.join(". "))
  note.textContent = lines.join(" ")
  note.classList.toggle("warn", lines.length > 0)
}
function insParamRow(slot, man, p, i) {
  const row = document.createElement("div"); row.className = "ip"
  const name = document.createElement("span"); name.className = "pname"; name.textContent = p.name
  const val = document.createElement("span"); val.className = "val"
  const cur = ins.state.slots[slot].values[i] ?? p.def
  let input
  if (p.enum) {
    input = document.createElement("select")
    p.enum.forEach((n, k) => input.add(new Option(n, String(k))))
    input.value = String(cur)
  } else {
    input = document.createElement("input")
    Object.assign(input, { type: "range", min: p.min, max: p.max, step: p.step || "any", value: cur })
  }
  input.setAttribute("aria-label", `${man.name} ${p.name}`)
  input.dataset.index = String(i)
  const show = () => { val.textContent = p.enum ? "" : `${Number(input.value)}${p.unit ? " " + p.unit : ""}`; fill(input) }
  if (!p.enum) {
    attachNativeArrows(input)
    attachValueEdit(val, { label: `${man.name} ${p.name} value`, text: () => String(Number(input.value)), fail: (m) => status(m, "err"), commit: (t) => commitNative(input, parsePlain(t, p)) })
  }
  input.addEventListener("input", () => {
    const v = clampParam(p, Number(input.value))
    const s = ins.state.slots[slot]
    s.values = man.params.map((q, k) => (k === i ? v : (s.values[k] ?? q.def)))
    show(); insChanged()
  })
  show()
  row.append(name, input, val)
  return row
}
function paintInsertSlot(slot) {
  const col = $(`inscol-${slot}`), sel = col.querySelector(".inssel"), box = col.querySelector(".insparams")
  const s = ins.state.slots[slot], have = s.name && insMod(s.name)
  sel.replaceChildren(new Option("Empty", ""), ...ins.mods.map((m) => new Option(m.man.name, m.man.name)))
  if (s.name && !have) { const o = new Option(`${s.name} (not installed)`, s.name); o.dataset.missing = "1"; sel.add(o) }
  sel.value = s.name ?? ""
  col.classList.toggle("missing", !!s.name && !have)
  box.replaceChildren()
  if (have) { const man = insMod(s.name).man; man.params.forEach((p, i) => box.append(insParamRow(slot, man, p, i))) }
  else if (s.name) { const m = document.createElement("p"); m.className = "insmsg warn"; m.textContent = `${s.name} is not installed`; box.append(m) }
}
function paintInserts() {
  $("insmixer").value = String(ins.state.mixer)
  for (let slot = 0; slot < 2; slot++) paintInsertSlot(slot)
  paintFx()
  paintLimiter()
  insStatus()
  insPost()
}
function buildInsertsUi() {
  const mix = $("insmixer")
  mix.replaceChildren(...MIXERS.map((n, i) => new Option(n, String(i))))
  mix.onchange = () => { ins.state.mixer = Number(mix.value); insChanged() }
  for (let slot = 0; slot < 2; slot++) {
    $(`inscol-${slot}`).querySelector(".inssel").onchange = (e) => {
      const name = e.target.value || null, mod = name && insMod(name)
      ins.state.slots[slot] = { name, values: mod ? insertDefaults(mod.man) : [] }
      paintInsertSlot(slot); insChanged()
    }
  }
}

// ---- master delay and reverb: the Master Delay and Master Reverb pages of the device (public/inserts.js FX_PARAMS). The values live in ins.state.fx and go to the same chain
// as the inserts, the two send knobs belong to the loaded engine (ins.state.fx.sends[engine]) like the Synth screen's Delay send and Reverb send.
const dbText = (table, v) => (v <= 0 ? "-inf dB" : `${(20 * Math.log10(table[Math.round(v)])).toFixed(2)} dB`)
function fxValueText(p, v) {
  if (p.unit === "send") return dbText(SEND_GAINS, v)
  if (p.unit === "level") return dbText(LEVEL_GAINS, v)
  if (p.enum) return ""
  return `${v}${p.unit ? " " + p.unit : ""}`
}
function fxGet(sec, p) {
  if (p.key === "send") return sendOf(ins.state, st.engine)[sec]
  return ins.state.fx[sec][p.key]
}
function fxSet(sec, p, v) {
  if (p.key === "send") {
    const cur = sendOf(ins.state, st.engine)
    ins.state.fx.sends[st.engine] = { ...cur, [sec]: v }
  } else ins.state.fx[sec][p.key] = v
  insChanged()
}
function fxRow(sec, p) {
  const row = document.createElement("div"); row.className = "ip"; row.dataset.key = p.key
  const name = document.createElement("span"); name.className = "pname"; name.textContent = p.name
  const val = document.createElement("span"); val.className = "val"
  let input
  if (p.enum) {
    input = document.createElement("select")
    p.enum.forEach((n, k) => input.add(new Option(n, String(k))))
  } else input = Object.assign(document.createElement("input"), { type: "range", min: p.min, max: p.max, step: p.step })
  input.setAttribute("aria-label", `${sec === "delay" ? "Delay" : "Reverb"} ${p.name}`)
  input.dataset.fx = `${sec}.${p.key}`
  input.value = String(fxGet(sec, p))
  const show = () => { if (!val.dataset.editing) val.textContent = fxValueText(p, Number(input.value)); fill(input) }
  if (!p.enum) {
    attachNativeArrows(input)
    const dbGain = p.unit === "send" ? (v) => SEND_GAINS[Math.round(v)] : p.unit === "level" ? (v) => LEVEL_GAINS[Math.round(v)] : null
    attachValueEdit(val, { label: `${sec === "delay" ? "Delay" : "Reverb"} ${p.name} value`, text: () => fxValueText(p, Number(input.value)), fail: (m) => status(m, "err"),
      commit: (t) => commitNative(input, dbGain ? parseDb(t, p, dbGain) : parsePlain(t, p)) })
  }
  input.addEventListener("input", () => { fxSet(sec, p, Number(input.value)); show(); fxGrey() })
  show()
  row.append(name, input, val)
  return row
}
function fxMuteRow(sec) {
  const row = document.createElement("div"); row.className = "ip mute"
  const name = document.createElement("span"); name.className = "pname"; name.textContent = "Mute"
  const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: !!ins.state.fx[sec].mute })
  box.setAttribute("aria-label", `${sec === "delay" ? "Delay" : "Reverb"} mute`); box.dataset.fx = `${sec}.mute`
  box.addEventListener("change", () => { ins.state.fx[sec].mute = box.checked ? 1 : 0; insChanged() })
  const lab = document.createElement("label"); lab.className = "small"; lab.append(box)
  row.append(name, lab)
  return row
}
function fxTempoRow() {
  const row = document.createElement("div"); row.className = "ip tempo"; row.dataset.key = "tempo"
  const name = document.createElement("span"); name.className = "pname"; name.textContent = "Tempo"
  const input = Object.assign(document.createElement("input"), { type: "range", min: TEMPO.min, max: TEMPO.max, step: 1, value: ins.state.fx.tempo })
  input.setAttribute("aria-label", "Delay sync tempo"); input.dataset.fx = "tempo"
  const val = document.createElement("span"); val.className = "val"
  const show = () => { if (!val.dataset.editing) val.textContent = `${input.value} BPM`; fill(input) }
  attachNativeArrows(input)
  attachValueEdit(val, { label: "Delay sync tempo value", text: () => input.value, fail: (m) => status(m, "err"), commit: (t) => commitNative(input, parsePlain(t, { ...TEMPO, step: 1 })) })
  input.addEventListener("input", () => { ins.state.fx.tempo = Number(input.value); insChanged(); show() })
  show()
  row.append(name, input, val)
  return row
}
function paintFx() {
  for (const sec of ["delay", "reverb"]) {
    const box = $(`fx${sec}`).querySelector(".insparams")
    box.replaceChildren(...FX_PARAMS[sec].map((p) => fxRow(sec, p)))
    box.insertBefore(fxMuteRow(sec), box.children[2])
    if (sec === "delay") box.append(fxTempoRow())
    $(`fx${sec}`).querySelector(".fxengine").textContent = st.engine ? `Send of ${st.engine}` : ""
  }
  fxGrey()
}
// the device greys what the other switch makes unused: Rate and Tempo with Sync off, Time with Sync on
function fxGrey() {
  const sync = !!ins.state.fx.delay.sync
  for (const [key, off] of [["rate", !sync], ["time", sync], ["tempo", !sync]]) {
    const row = $("fxdelay").querySelector(`.ip[data-key="${key}"]`)
    if (!row) continue
    row.style.opacity = off ? ".45" : ""
    for (const c of row.querySelectorAll("input,select")) c.disabled = off
  }
}
// ---- master limiter: the Limiter screen of Master (public/inserts.js LIMITER_PARAMS), after the inserts. On at every page load as on the device (public/inserts.js fxDefaults), the switch is an A/B for the session.
function limiterText(p, v) {
  if (p.unit === "s/1000") return `${(v / 1000).toFixed(3)} s`
  if (p.unit === "limiter") return v <= 0 ? "-inf dB" : `${(20 * Math.log10(LIMITER_STEPS[v] / 32767)).toFixed(2)} dB`
  return ""
}
function limiterRow(p) {
  const row = document.createElement("div"); row.className = "ip"; row.dataset.key = p.key
  const name = document.createElement("span"); name.className = "pname"; name.textContent = p.name
  const val = document.createElement("span"); val.className = "val"
  let input
  if (p.enum) {
    input = document.createElement("select")
    p.enum.forEach((n, k) => input.add(new Option(n, String(k))))
  } else input = Object.assign(document.createElement("input"), { type: "range", min: p.min, max: p.max, step: p.step })
  input.setAttribute("aria-label", `Limiter ${p.name}`)
  input.dataset.fx = `limiter.${p.key}`
  input.value = String(ins.state.fx.limiter[p.key])
  // the state, not the slider, is the value: the Release of a new project (0.512) is below the slider's first step
  const show = () => { if (!val.dataset.editing) val.textContent = limiterText(p, ins.state.fx.limiter[p.key]); fill(input) }
  if (!p.enum) {
    attachNativeArrows(input)
    const parse = p.unit === "limiter" ? (t) => parseDb(t, p, (v) => LIMITER_STEPS[Math.round(v)] / 32767) : p.unit === "s/1000" ? (t) => parseMilli(t, p) : (t) => parsePlain(t, p)
    attachValueEdit(val, { label: `Limiter ${p.name} value`, text: () => limiterText(p, ins.state.fx.limiter[p.key]) || input.value, fail: (m) => status(m, "err"), commit: (t) => commitNative(input, parse(t)) })
  }
  input.addEventListener("input", () => { ins.state.fx.limiter[p.key] = Number(input.value); insChanged(); show() })
  show()
  row.append(name, input, val)
  return row
}
function paintLimiter() {
  const box = $("limcol").querySelector(".insparams")
  const on = document.createElement("div"); on.className = "ip mute"
  const name = document.createElement("span"); name.className = "pname"; name.textContent = "Limiter"
  const sw = Object.assign(document.createElement("input"), { type: "checkbox", checked: !!ins.state.fx.limiter.on })
  sw.setAttribute("aria-label", "Limiter on"); sw.dataset.fx = "limiter.on"
  sw.addEventListener("change", () => { ins.state.fx.limiter.on = sw.checked ? 1 : 0; insChanged() })
  const lab = document.createElement("label"); lab.className = "small"; lab.append(sw)
  on.append(name, lab)
  box.replaceChildren(on, ...LIMITER_PARAMS.map(limiterRow))
}
$("limreset").onclick = () => {
  const on = ins.state.fx.limiter.on
  ins.state.fx.limiter = { ...Object.fromEntries(LIMITER_PARAMS.map((p) => [p.key, p.def])), on }
  paintLimiter(); insChanged()
}
initInserts()

// ---- sound
async function play(note, velocity = Number($("vel").value)) {
  ctx ??= new AudioContext()
  if (ctx.state === "suspended") await ctx.resume()
  await ins.ready
  const chained = insActive() // the Mixer or an insert changes the sound: the render comes back as float and goes through the chain
  const req = { engine: st.engine, patch: st.patch, macroValues: st.macroValues, note, velocity, seconds: Number($("len").value), hold: Number($("hold").value), ...(st.strict ? { strict: true } : {}) }
  const key = JSON.stringify(chained ? [req, ins.state] : req)
  let buf = cache.get(key)
  if (!buf) {
    try {
      const r = await api("POST", "/api/render", chained ? { ...req, float: true } : req)
      buf = chained ? await renderThroughChain(await r.arrayBuffer()) : await ctx.decodeAudioData(await r.arrayBuffer())
    } catch (e) { status("Render failed: " + e.message, "err"); return }
    cache.set(key, buf); if (cache.size > 64) cache.delete(cache.keys().next().value)
  }
  { let peak = 0; for (const v of buf.getChannelData(0)) peak = Math.max(peak, Math.abs(v)); ins.lastRender = { chained, channels: buf.numberOfChannels, rate: buf.sampleRate, peak, frames: buf.length } } // the page test reads it
  const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start()
}
$("playbtn").onclick = () => play(57)

// keyboard: 25 on-screen keys from the C at OCT_BASE (48 = C3 .. 72 = C5 by default) and the computer keys 17 semitones from one octave above it
// (a = C4 by default). The octave shift (buttons, Z down, X up) moves both. A held note keeps the note it started with (live.down stores it),
// so letting go after a shift sends the right note-off. 0 .. 8 keeps the highest computer key (base + 28) inside MIDI 127.
const keysEl = $("keys"); const KEYMAP = "awsedftgyhujkolp;"
const OCT_MIN = 0, OCT_MAX = 8, OCT_DEFAULT = 4, KEY_COUNT = 25
const isBlack = (n) => [1, 3, 6, 8, 10].includes(n % 12)
const octave = (() => { try { const v = localStorage.getItem("poly-editor.octave"); const n = v === null || v === "" ? NaN : Number(v); return Number.isInteger(n) && n >= OCT_MIN && n <= OCT_MAX ? n : OCT_DEFAULT } catch { return OCT_DEFAULT } })()
const kbOct = { n: octave }
const keyBase = () => kbOct.n * 12
const noteName = (n) => "C" + (Math.floor(n / 12) - 1)
let x = 0
for (let i = 0; i < KEY_COUNT; i++) {
  const k = document.createElement("div"); k.className = "key " + (isBlack(i) ? "b" : "w")
  if (isBlack(i)) k.style.left = x - 12 + "px"; else { k.style.left = x + "px"; x += 38 }
  const ptr = "ptr" + i
  k.onpointerdown = () => { const n = keyBase() + i; if (live.on) { live.down.set(ptr, n); liveNote(true, n) } else { k.classList.add("down"); play(n) } }
  k.onpointerup = k.onpointerleave = () => { if (live.on) { const n = live.down.get(ptr); if (n !== undefined) { live.down.delete(ptr); liveNote(false, n) } } else k.classList.remove("down") }
  keysEl.append(k)
}
keysEl.style.width = x + "px"
function paintOctave() {
  const base = keyBase()
  keysEl.querySelectorAll(".key").forEach((k, i) => {
    k.dataset.note = base + i
    k.classList.toggle("down", lit.has(base + i))
    if (!isBlack(i) && i % 12 === 0) k.textContent = noteName(base + i)
  })
  $("octread").textContent = noteName(base) + " - " + noteName(base + 24)
  $("octdown").disabled = kbOct.n <= OCT_MIN; $("octup").disabled = kbOct.n >= OCT_MAX
}
function shiftOctave(d) {
  const n = Math.min(OCT_MAX, Math.max(OCT_MIN, kbOct.n + d)); if (n === kbOct.n) return
  kbOct.n = n
  try { localStorage.setItem("poly-editor.octave", String(n)) } catch {}
  paintOctave()
}
$("octdown").onclick = () => shiftOctave(-1)
$("octup").onclick = () => shiftOctave(1)
paintOctave()

// ---- on-screen keyboard visibility. Auto: hidden while a MIDI input is listening, shown when MIDI is off or the device is gone.
// The toggle is a manual choice that wins until the MIDI state (some input listening or none) next changes, then auto takes over
// again. The choice is kept in localStorage, so a reload starts with it (MIDI is off after a reload, the first change clears it).
const kbBar = document.querySelector(".keybed")
const kbStore = (() => { try { return JSON.parse(localStorage.getItem("poly-editor.keyboard") ?? "{}") } catch { return {} } })()
const kb = { midiOn: false, manual: kbStore.manual === "shown" || kbStore.manual === "hidden" ? kbStore.manual : null }
function paintKeyboard() {
  const show = kb.manual ? kb.manual === "shown" : !kb.midiOn
  kbBar.classList.toggle("off", !show)
  const b = $("kbtoggle"); b.classList.toggle("on", show); b.setAttribute("aria-pressed", String(show)); b.textContent = "Keyboard: " + (show ? "on" : "off")
  if (!show) for (const k of [...live.down.keys()]) if (k.startsWith("ptr")) { const n = live.down.get(k); live.down.delete(k); liveNote(false, n) } // a key held with the mouse when it vanishes
}
function saveKeyboard() { try { kb.manual ? localStorage.setItem("poly-editor.keyboard", JSON.stringify({ manual: kb.manual })) : localStorage.removeItem("poly-editor.keyboard") } catch {} }
$("kbtoggle").onclick = () => { kb.manual = kbBar.classList.contains("off") ? "shown" : "hidden"; saveKeyboard(); paintKeyboard() }
function setKeyboardMidi(on) { // called with the MIDI state after every device change, only a change of state counts
  if (on === kb.midiOn) return
  kb.midiOn = on; kb.manual = null; saveKeyboard(); paintKeyboard()
}
paintKeyboard()
// The computer keys play whenever the focus is not in a field where characters are typed: a focused slider, select, checkbox, button or readout does not mute them.
// A handled key is consumed, so a focused select does not also jump to the option that starts with the letter.
window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(document.activeElement) || $("discard").open) return
  const lower = e.key.toLowerCase()
  const i = lower === "z" || lower === "x" ? -1 : KEYMAP.indexOf(e.key)
  if (i < 0 && lower !== "z" && lower !== "x") return
  e.preventDefault()
  if (e.repeat) return
  if (i < 0) { shiftOctave(lower === "z" ? -1 : 1); return }
  const n = keyBase() + 12 + i
  if (live.on) { if (!live.down.has(e.key)) { live.down.set(e.key, n); liveNote(true, n) }; return }
  const el = keysEl.querySelector(`[data-note="${n}"]`); play(n); el?.classList.add("down"); setTimeout(() => el?.classList.remove("down"), 120)
})
window.addEventListener("keyup", (e) => { const n = live.down.get(e.key); if (n !== undefined) { live.down.delete(e.key); liveNote(false, n) } })

// ---- polyphony: voices per engine, remembered in this browser. The shim voice allocator takes a free voice, then the quietest
// released one, then steals the oldest. 1 voice is mono legato (the held voice changes pitch, glide as in the firmware).
const voicesStore = (() => { try { return JSON.parse(localStorage.getItem("poly-editor.voices") ?? "{}") } catch { return {} } })()
// The firmware plays up to e.maxVoices voices per instrument (4, PERC and T-Type 1: the kit lives in the slot scratch, the host holds a one
// voice engine to 1). 5 to 8 voices are an editor-only preview. Strict (match my Tracker) caps the setting at the firmware's number.
const engineOf = (name) => st.engines.find((x) => x.name === name)
const fwVoices = (name) => engineOf(name)?.maxVoices ?? 4
const maxVoicesOf = (name) => { const e = engineOf(name); return !e ? 8 : e.maxVoices <= 1 ? 1 : st.strict ? e.maxVoices : e.editorMaxVoices }
function voicesOf(engine) { const cap = maxVoicesOf(engine); if (cap === 1) return 1; const v = Number(voicesStore[engine]); return Math.min(cap, v >= 1 && v <= 8 ? v : 2) }
function paintPoly() {
  const sel = $("poly")
  const cap = maxVoicesOf(st.engine)
  sel.innerHTML = ""
  for (let n = 1; n <= cap; n++) { const o = document.createElement("option"); o.value = String(n); o.textContent = n === 1 && cap > 1 ? "1 (mono legato)" : String(n); if (n > fwVoices(st.engine)) o.textContent += " (editor only)"; sel.append(o) }
  const n = voicesOf(st.engine); sel.value = String(n)
  sel.disabled = cap === 1
}
if ($("strict")) $("strict").onchange = async () => {
  st.strict = $("strict").checked
  try { localStorage.setItem("poly-editor.strict", st.strict ? "1" : "0") } catch {}
  paintStrictEngines(); paintMon()
  if (st.strict && !engineOf(st.engine).onTracker) { await selectEngine(st.engines.find((x) => x.onTracker).name); return }
  paintPoly(); paintInfo(); cache.clear()
  liveSend({ cmd: "live.voices", voices: voicesOf(st.engine), strict: st.strict })
  if (!st.strict) status("Strict off")
}
$("poly").onchange = () => {
  const n = Number($("poly").value); voicesStore[st.engine] = n
  try { localStorage.setItem("poly-editor.voices", JSON.stringify(voicesStore)) } catch {}
  paintPoly(); liveSend({ cmd: "live.voices", voices: n, strict: st.strict })
}
let voicePaint = false
function paintVoices() {
  if (voicePaint) return
  voicePaint = true
  requestAnimationFrame(() => { voicePaint = false; $("voices").textContent = live.on ? `sounding ${live.voiceNow ?? 0}${live.heldNow ? `, ${live.heldNow} held` : ""}` : "" })
}

// ---- MIDI input (public/midi.js, Web MIDI): note on / off with velocity, sustain CC64, pitch bend, mod wheel CC1 (the firmware
// ignores it, it is forwarded and shown), CC 102..107 = macros M1..M6 as in the firmware shim, CC120 / 123 all notes off.
// Live audio is what makes held notes, the pedal and the bend audible, so enabling MIDI also turns it on.
const mon = { mod: null, bend: null, pedal: false }
function paintMon() {
  const t = []
  if (mon.mod !== null) t.push(`mod ${mon.mod}`)
  if (mon.bend !== null) t.push(`bend ${mon.bend >= 0 ? "+" : ""}${(mon.bend / 8192).toFixed(2)} st`)
  if (mon.pedal && !st.release) t.push(st.strict ? "sustain (ignored: Strict)" : "sustain (editor only)")
  $("midimon").textContent = t.join(" · ")
}
function onMidiEvent(ev) {
  if (ev.kind === "cc") {
    if (ev.cc === 1) mon.mod = ev.value
    else if (ev.cc === 64) mon.pedal = ev.value >= 64
    else if (ev.cc === 120 || ev.cc === 123) {
      mon.pedal = false
      const mine = new Set(live.down.values()) // notes off lets go of the MIDI keys: their highlight goes, mouse and computer keys keep theirs
      for (const n of [...lit]) if (!mine.has(n)) lit.delete(n)
      for (const k of keysEl.querySelectorAll(".down")) if (!mine.has(Number(k.dataset.note))) k.classList.remove("down")
    }
    const m = macroOfCC(ev.cc)
    if (m >= 0 && els.macros[m]) { st.macroValues[m] = (ev.value * 100) / 127; els.macros[m].input.value = st.macroValues[m]; fill(els.macros[m].input); els.macros[m].show(); scheduleDescribe() } // the host applies the CC itself
  } else if (ev.kind === "bend") mon.bend = ev.value
  paintMon()
  if (live.on) {
    if (ev.kind === "on") liveNote(true, ev.note, ev.velocity)
    else if (ev.kind === "off") liveNote(false, ev.note)
    else { const msg = toLive(ev); if (msg) liveSend(msg) }
  } else if (ev.kind === "on") play(ev.note, ev.velocity) // live audio is off: a render per note on, about 100 ms
}
const midiPrefs = (() => { try { return JSON.parse(localStorage.getItem("poly-editor.midi") ?? "{}") } catch { return {} } })()
const saveMidiPrefs = () => { try { localStorage.setItem("poly-editor.midi", JSON.stringify(midiPrefs)) } catch {} }
const midiNames = new Map() // port id -> name, to show a selected device that is unplugged
function paintMidi({ devices, selected, channel, notice, listening }) {
  const sel = $("mididev"); sel.innerHTML = ""
  const add = (v, t) => { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.append(o) }
  add("all", "All inputs")
  for (const d of devices) { midiNames.set(d.id, d.name); add(d.id, d.name) }
  if (selected !== "all" && !devices.some((d) => d.id === selected)) add(selected, `${midiNames.get(selected) ?? "device"} (unplugged)`)
  sel.value = selected
  $("midich").value = channel === "omni" ? "omni" : String(channel)
  setKeyboardMidi(listening > 0)
  $("midistate").textContent = (devices.length ? `${listening} of ${devices.length} input(s) listening` : "no MIDI inputs found, plug one in") + (notice ? `. ${notice}` : "")
}
const midi = createMidiInput({ onEvent: onMidiEvent, onDevices: paintMidi })
{
  const ch = $("midich"); const o = document.createElement("option"); o.value = "omni"; o.textContent = "Omni"; ch.append(o)
  for (let n = 1; n <= 16; n++) { const x = document.createElement("option"); x.value = String(n - 1); x.textContent = String(n); ch.append(x) }
}
$("mididev").onchange = () => { midiPrefs.device = $("mididev").value; saveMidiPrefs(); midi.select($("mididev").value) }
$("midich").onchange = () => { midiPrefs.channel = $("midich").value; saveMidiPrefs(); midi.setChannel($("midich").value) }
$("midi").onclick = async () => {
  if (!navigator.requestMIDIAccess) { $("midistate").textContent = "Web MIDI is not available in this browser (use Chrome)"; return }
  try {
    await midi.enable()
    $("mididev").disabled = false; $("midich").disabled = false
    $("midi").textContent = "MIDI input on"; $("midi").disabled = true
    if (midiPrefs.channel !== undefined) midi.setChannel(midiPrefs.channel)
    if (midiPrefs.device) midi.select(midiPrefs.device)
    if (!live.on) { try { await startLive() } catch (e) { stopLive("Live audio failed: " + e.message + ". MIDI notes use the per-note render.", "err") } }
  } catch (e) { $("midistate").textContent = "MIDI access refused: " + e.message }
}

init().catch((e) => status("Start failed: " + e.message, "err"))
