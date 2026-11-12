// Runtime plugin modules (.wasm twins of the device .plg, host/sdk/plug_wasm.h) for the wasm host: check a module against its
// manifest, load it into the host's own memory and function table, and attach it as a synth engine or a master insert.
// No DOM, no fetch: the page, the AudioWorklet and the tests all use it. The checks that need crypto.subtle (sha256) are async and
// run where it exists (the page, node), the load itself is synchronous (the AudioWorklet has no async compile and no crypto).
//
// Refused, with a reason: a manifest of another format, a module ABI (wasm_abi) or plugin ABI (abi) major that is not the host's,
// min_host above the host level, size or sha256 not the manifest's, another kind than asked for, any import outside the five of
// plug_wasm.h, plug_wasm_abi() of another major, plug_entry() returning NULL, and whatever the host refuses on attach (layout,
// numbers, formats: ATTACH_ERRORS).

export const ATTACH_ERRORS = {
  1: "the engine list is in use (attach engines before the first request)",
  2: "not a synth engine descriptor",
  3: "no synth extension (PLUG_EXT_SYNTH)",
  4: "built against other SynthVoice / SynthParams / SynthNote / SynthSlotScratch layouts",
  5: "its numbers (stored, .patch engine, type id) are not this engine's",
  6: "too many parameters, sections or macros, or a voice count outside 1..4",
  7: "a value format this host does not have",
  8: "this host has no slot for this engine",
  9: "this engine is attached already",
}
export const INSERT_ERRORS = { 1: "no such slot", 2: "not a master insert", 3: "init() failed", 4: "too many parameters" }
const ALLOWED = new Set(["env.memory", "env.__indirect_function_table", "env.__memory_base", "env.__table_base", "env.__stack_pointer"])
const KINDS = { synth: 4, master: 1 }
const STACK = 64 * 1024

export class ModuleError extends Error {}
const refuse = (why) => { throw new ModuleError(why) }
const major = (s) => Number(String(s).split(".")[0])

/** What the host build supports: read from the host itself, never typed in here. */
export function hostAbi(M) {
  const abi = M._ffm_abi() >>> 0, wasm = M._ffm_wasm_abi() >>> 0
  return { abi: `${abi >>> 16}.${abi & 0xffff}`, wasmAbi: `${wasm >>> 16}.${wasm & 0xffff}`, level: M._ffm_host_level() >>> 0 }
}

/** The manifest checks that need no code to run. */
export function checkManifest(man, host, kind) {
  if (!man || man.format !== "ffmod" || man.format_version !== 1) refuse("not an ffmod manifest (format, format_version)")
  if (kind && man.kind !== kind) refuse(`a ${man.kind} module, not a ${kind}`)
  if (major(man.wasm_abi) !== major(host.wasmAbi)) refuse(`module ABI ${man.wasm_abi}, this host loads ${host.wasmAbi}`)
  if (major(man.abi) !== major(host.abi)) refuse(`plugin ABI ${man.abi}, this host has ${host.abi}`)
  if (!(Number(man.min_host) <= host.level)) refuse(`needs host level ${man.min_host}, this host is ${host.level}`)
  if (!man.files?.wasm?.sha256) refuse("the manifest has no wasm sha256")
}

export async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** Manifest and bytes: refuses or returns. Run where crypto.subtle exists, before handing the bytes to loadModule. */
export async function verify(bytes, man, host, kind) {
  checkManifest(man, host, kind)
  if (bytes.byteLength !== man.files.wasm.size) refuse(`size ${bytes.byteLength}, the manifest says ${man.files.wasm.size}`)
  const h = await sha256Hex(bytes)
  if (h !== man.files.wasm.sha256) refuse(`sha256 ${h.slice(0, 12)}.., the manifest says ${man.files.wasm.sha256.slice(0, 12)}..`)
}

function leb(b, o) {
  let r = 0, s = 0, x
  do { x = b[o.i++]; r |= (x & 0x7f) << s; s += 7 } while (x & 0x80)
  return r >>> 0
}

/** The dylink.0 memory info of a module: data and bss size and alignment, function table slots. */
export function dylinkInfo(mod) {
  const secs = WebAssembly.Module.customSections(mod, "dylink.0")
  if (secs.length !== 1) refuse("not a position independent module (no dylink.0 section)")
  const b = new Uint8Array(secs[0]), o = { i: 0 }
  while (o.i < b.length) {
    const type = b[o.i++], len = leb(b, o), end = o.i + len
    if (type === 1) return { memSize: leb(b, o), memAlign: leb(b, o), tableSize: leb(b, o), tableAlign: leb(b, o) }
    o.i = end
  }
  refuse("dylink.0 has no memory info")
}

/**
 * Loads a module into the host (synchronous). bytes: ArrayBuffer / Uint8Array or an already compiled WebAssembly.Module.
 * Returns { desc, exports, man }. Run verify() first where it can run.
 */
export function loadModule(M, bytes, man) {
  const mod = bytes instanceof WebAssembly.Module ? bytes : new WebAssembly.Module(bytes)
  for (const i of WebAssembly.Module.imports(mod)) if (!ALLOWED.has(`${i.module}.${i.name}`)) refuse(`imports ${i.module}.${i.name}, outside the module ABI`)
  const ex = new Set(WebAssembly.Module.exports(mod).map((e) => e.name))
  for (const n of ["plug_entry", "plug_wasm_abi"]) if (!ex.has(n)) refuse(`no ${n} export`)
  const info = dylinkInfo(mod)
  const align = Math.max(1 << info.memAlign, 16)
  const raw = M._malloc(info.memSize + align + STACK + 16)
  if (!raw) refuse("out of memory")
  const memBase = (raw + align - 1) & ~(align - 1)
  M.HEAPU8.fill(0, memBase, memBase + info.memSize)
  const stackTop = (memBase + info.memSize + STACK) & ~15
  const table = M.wasmTable
  const tableBase = table.length
  if (info.tableSize) table.grow(info.tableSize)
  const g = (v, mutable = false) => new WebAssembly.Global({ value: "i32", mutable }, v)
  const inst = new WebAssembly.Instance(mod, {
    env: { memory: M.wasmMemory, __indirect_function_table: table, __memory_base: g(memBase), __table_base: g(tableBase), __stack_pointer: g(stackTop, true) },
  })
  const e = inst.exports
  const wabi = e.plug_wasm_abi() >>> 0, hostW = M._ffm_wasm_abi() >>> 0
  if (wabi >>> 16 !== hostW >>> 16) refuse(`plug_wasm_abi() says ${wabi >>> 16}.${wabi & 0xffff}, this host loads ${hostW >>> 16}.${hostW & 0xffff}`)
  if (man && `${wabi >>> 16}.${wabi & 0xffff}` !== man.wasm_abi) refuse(`plug_wasm_abi() ${wabi >>> 16}.${wabi & 0xffff} is not the manifest's ${man.wasm_abi}`)
  e.__wasm_apply_data_relocs?.()
  e.__wasm_call_ctors?.()
  const desc = e.plug_entry(M._ffm_host(), M._ffm_abi()) >>> 0
  if (!desc) refuse("plug_entry() refused this host (NULL)")
  const u32 = new Uint32Array(M.wasmMemory.buffer, desc, 7)
  const kind = u32[1]
  if (man && KINDS[man.kind] !== kind) refuse(`the descriptor's kind ${kind} is not the manifest's ${man.kind}`)
  if (man?.kind === "master" && man.params && u32[4] !== man.params.length) refuse(`${u32[4]} parameters, the manifest lists ${man.params.length}`)
  return { desc, exports: e, man, memBase, tableBase }
}

export function attachSynth(M, loaded) {
  const r = M._ffm_attach_synth(loaded.desc)
  if (r !== 0) refuse(ATTACH_ERRORS[r] ?? `attach error ${r}`)
}

/** Like attachSynth, but an engine the host has no slot for (8) is not an error: returns false and leaves it out. Any other refusal throws. */
export function attachSynthIfSlot(M, loaded) {
  const r = M._ffm_attach_synth(loaded.desc)
  if (r === 8) return false
  if (r !== 0) refuse(ATTACH_ERRORS[r] ?? `attach error ${r}`)
  return true
}

/** slot 0 or 1. loaded = null empties the slot. Parameters start at their defaults. */
export function setInsert(M, slot, loaded) {
  const r = M._ffm_insert_set(slot, loaded ? loaded.desc : 0)
  if (r !== 0) refuse(INSERT_ERRORS[r] ?? `insert error ${r}`)
}
