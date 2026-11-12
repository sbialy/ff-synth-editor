// The sync test: the editor against the firmware it is pinned to (vendor/FIRMWARE.json, a tracker-ff release tag).
//
// What it compares, and with what:
//   - the engine list (engines.mk: the six built in plus the plugin engines of SYNTH_ENGINES_EXT, engines/engines.json at the tag), every id (engine_list.h: stored number, InstrumentTypeId, .patch engine id) and the release set against
//     what the host, the server and the page's engine list expose. engine_list.h and engines.mk are parsed here as text, so a table the host
//     was built from cannot agree with itself by accident
//   - every parameter slot of every engine (name, default, range, curve, value format, enum names, sections, default macros, volume
//     parameter, voice cap) from the firmware's own EngineDef tables (host command "firmware", no Patch::Metadata in between) against the
//     metadata the editor serves (host command "meta", what the page and the randomizer read), and for the engines whose tables are plain
//     rows also against the source text of engine_<name>.cpp (the six from the tag, the OpenTracker ones from the public module repository)
//   - the frozen randomizer: algorithm 2 keys its PRNG by engine id and parameter slot, and the vectors in test/fixtures/golden-algo2.json
//     carry the metadata they were made on. Slot numbers and ids must still be the ones in that fixture
//   - the overlay (scripts/shim.patch) touches only the files it says it does, and when the firmware repository is next to us the vendored
//     tree is byte for byte the tag except for those files, and the OpenTracker engine files are byte for byte the public module repository at the commit
//     the tag pins in engines/external.lock.json
//   - the plugin engines: the module pins (the public module repository, the engines repository) are the ones of the tag's engines/external.lock.json, and Pluck (PLK,
//     a release engine since 1.2.0) has the metadata of the engines release the tag pins
// A mismatch fails with one readable line per difference ("engine ACD param 12 'Cutoff' max: firmware 20000, editor 22050"). The cure is
// never to edit the expectation: re-vendor (scripts/vendor.sh <tag>), or fix the editor side.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { newHost, ALL_ENGINES, PLK_PARAM_COUNT, PARAM_COUNTS, OT3_PARAM_COUNTS, OT3_DISPLAY, available, havePrivate, privateEngines } from "./helpers"
import { ENGINES, EXPERIMENTAL_ENGINES, FIRMWARE_ENGINES, HIDDEN_ENGINES, NOT_IN_RELEASE, POLYEND_ENGINES, OT3_MODULES } from "../server/engines"
import { firmware, firmwareInfo } from "../server/firmware"
import type { HostClient } from "../server/host"

const root = join(import.meta.dir, "..")
const vendor = join(root, "vendor/poly")
const read = (p: string) => readFileSync(join(vendor, p), "utf8")
// PHZ and PLK are closed source and run as runtime modules: a build without the modules (the public build) has neither in the host, and their source is only
// there with POLY_PRIVATE_SOURCE=1 scripts/vendor.sh. The checks that need them are skipped, everything else is the same.
const haveSource = firmware.private.files.every((f) => existsSync(join(vendor, f)))
const noPrivateEngines = firmware.private.engines.filter((e) => !privateEngines.includes(e))
const without = (names: string[]) => names.filter((n) => !noPrivateEngines.includes(n))

let host: HostClient
let raw: any[] // the firmware's own tables, host command "firmware"
let editorEngines: any[] // host command "engines"
const metas: Record<string, any> = {}
beforeAll(async () => {
  host = await newHost()
  raw = (await host.request({ cmd: "firmware" })).engines
  editorEngines = (await host.request({ cmd: "engines" })).engines
  for (const e of raw) metas[e.name] = await host.request({ cmd: "meta", engine: e.name })
}, 300_000)
afterAll(() => host.close())

// ---- text parsers of the vendored firmware sources
/** engines.mk: SYNTH_ENGINES_ALL / SYNTH_ENGINES_DEFAULT */
function makeList(name: string, text = read("synth-open/engines.mk")): string[] {
  const m = text.match(new RegExp(`^${name}\\s*:=\\s*(.+)$`, "m"))
  if (!m) throw new Error(`${name} not found in engines.mk`)
  return m[1]!.trim().split(/\s+/)
}
/** InstrumentTypeId from PolySynth/config.h: enumerators count up from 0, an explicit "= n" resets the counter */
function typeIds(): Record<string, number> {
  const body = read("synth/include/PolySynth/config.h").match(/enum class InstrumentTypeId\s*\{([^}]*)\}/)![1]!
  const out: Record<string, number> = {}
  let n = 0
  for (const item of body.split(",").map((x) => x.replace(/\/\/.*$/gm, "").trim()).filter(Boolean)) {
    const [k, v] = item.split("=").map((x) => x.trim())
    if (v !== undefined) n = /^\d+$/.test(v) ? Number(v) : (out[v] ?? n)
    out[k!] = n++
  }
  return out
}
type ListEntry = { name: string; stored: number; typeId: number; def: string; patchId: number }
/** engine_list.h: the SYNTH_ENGINE(NAME, STORED, TYPE_ID, FACTORY, DEF, PATCH_ENGINE, ...) rows */
function engineList(source = read("synth-open/engine_list.h")): ListEntry[] {
  const ids = typeIds()
  const text = source.replace(/\/\/.*$/gm, "")
  const out: ListEntry[] = []
  for (const m of text.matchAll(/SYNTH_ENGINE\(\s*(\w+)\s*,\s*(\d+)\s*,\s*([^,]+(?:\([^)]*\))?[^,]*?)\s*,\s*(\w+)\s*,\s*(\w+)\s*,\s*(0x[0-9A-Fa-f]+|\d+)\s*,/g)) {
    const expr = m[3]!.trim()
    const cast = expr.match(/static_cast<[^>]+>\((0x[0-9A-Fa-f]+|\d+)\)/)
    const typeId = cast ? Number(cast[1]) : ids[expr.replace(/^polysynth::InstrumentTypeId::/, "")]
    if (typeId === undefined) throw new Error(`engine_list.h: cannot read the type id '${expr}' of ${m[1]}`)
    out.push({ name: m[1]!, stored: Number(m[2]), typeId, def: m[5]!, patchId: Number(m[6]) })
  }
  return out
}
/** the engines of the TAG in the order of engine_list.h: the ones built in (SYNTH_ENGINES_ALL) and the plugin engines (SYNTH_ENGINES_EXT) */
const tagEngines = () => { const s = [...makeList("SYNTH_ENGINES_ALL"), ...makeList("SYNTH_ENGINES_EXT")]; return engineList().map((e) => e.name).filter((n) => s.includes(n)) }
const num = (s: string) => Math.fround(Number(s.replace(/f$/, "")))

describe("the pinned firmware", () => {
  test("vendor/FIRMWARE.json is a tracker-ff release tag and the vendored files say the same", () => {
    expect(firmware.tag).toMatch(/^tracker-ff-v\d+\.\d+\.\d+$/)
    expect(firmware.version).toBe(firmware.tag.replace("tracker-ff-v", ""))
    expect(firmware.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(firmware.label).toBe(`tracker-ff ${firmware.version}`)
    const prov = readFileSync(join(root, "vendor/PROVENANCE.md"), "utf8")
    expect(prov).toContain(`- tag: ${firmware.tag}`)
    expect(prov).toContain(`- commit: ${firmware.commit}`)
    expect(firmwareInfo().matches).toBe(`matches tracker-ff ${firmware.version}`)
    expect(read("synth-open/engines.mk")).toContain("SYNTH_ENGINES_ALL")
    // no experimental source any more: Pluck is a release engine of the tag, and every engine of the tag is in the release image
    expect((firmware as any).experimental).toBeUndefined()
    expect(firmware.engines).toContain("PLK")
    expect(firmware.releaseEngines).toEqual(firmware.engines)
    expect(firmware.releaseEngines.length).toBe(18)
    expect(firmware.notInRelease).toEqual([])
    expect(firmware.builtinEngines).toEqual(makeList("SYNTH_ENGINES_ALL"))
    expect(firmware.modules.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(prov).toContain(`from ${firmware.modules.repo} ${firmware.modules.tag} (commit ${firmware.modules.commit})`)
  })

  test("scripts/vendor.sh takes release tags only: a raw commit or a branch is refused before anything is touched", () => {
    for (const ref of ["88789f0", "synth-dev", "tracker-ff-v1.1", "v1.1.0"]) {
      const r = Bun.spawnSync(["sh", join(root, "scripts/vendor.sh"), ref], { stdout: "pipe", stderr: "pipe" })
      expect(r.exitCode).toBe(2)
      expect(r.stderr.toString()).toContain("not a tracker-ff release tag")
    }
  })

  test("the firmware's engine set (engines.mk) is the editor's: host, server, tests and the release set", () => {
    const diffs: string[] = []
    const all = tagEngines() // the tag's 18: six built in, twelve plugin engines
    expect(makeList("SYNTH_ENGINES_ALL")).toEqual(["ACD", "FAT", "VAP", "WTFM", "PERC", "CHIP"])
    expect(makeList("SYNTH_ENGINES_STOCK")).toEqual(makeList("SYNTH_ENGINES_ALL"))
    expect(all.length).toBe(18)
    const same = (what: string, a: string[], b: string[]) => {
      for (const x of a) if (!b.includes(x)) diffs.push(`${what}: ${x} is in the firmware but not in the editor`)
      for (const x of b) if (!a.includes(x)) diffs.push(`${what}: ${x} is in the editor but not in the firmware`)
    }
    same("vendor/FIRMWARE.json engines", all, firmware.engines)
    same("default set", makeList("SYNTH_ENGINES_DEFAULT"), firmware.defaultEngines)
    same("host engine list", without([...all, ...EXPERIMENTAL_ENGINES]), editorEngines.map((e) => e.name))
    same("server ENGINES", [...all, ...EXPERIMENTAL_ENGINES], ENGINES) // (the static list, whatever modules are installed)
    same("server experimental engines", [], [...EXPERIMENTAL_ENGINES])
    same("server POLYEND_ENGINES + OT3_MODULES + PLK", all, [...POLYEND_ENGINES, ...Object.keys(OT3_MODULES), "PLK"])
    same("test helper ALL_ENGINES + PHZ + PLK", all, [...ALL_ENGINES, "PHZ", "PLK"]) // the helpers keep PHZ and PLK apart (private)
    same("server OT3_MODULES = the tracker-engines-os engines", firmware.modules.engines, Object.keys(OT3_MODULES))
    same("release set", all.filter((e) => !NOT_IN_RELEASE.includes(e)), [...FIRMWARE_ENGINES])
    same("release set in FIRMWARE.json", all.filter((e) => !firmware.notInRelease.includes(e)), firmware.releaseEngines)
    // the engines the release leaves out are real engines of the tree, and the editor marks every other one as on the Tracker
    for (const e of NOT_IN_RELEASE) diffs.push(`notInRelease: ${e}, the 1.2.0 release image has every engine`)
    for (const e of HIDDEN_ENGINES) diffs.push(`hidden: ${e}, every engine of the release image is on the page`)
    // the order of the firmware list is kept inside each of the editor's two groups
    const order = (names: string[]) => names.map((n) => all.indexOf(n)).filter((i) => i >= 0)
    const sortedAsc = (a: number[]) => a.every((v, i) => i === 0 || a[i - 1]! < v)
    const poly = editorEngines.filter((e) => e.group === "polyend").map((e) => e.name)
    if (!sortedAsc(order(poly))) diffs.push(`OpenTracker 2.x group is not in the firmware's list order: ${poly.join(" ")}`)
    const groupNames = (g: string) => editorEngines.filter((e) => e.group === g).map((e) => e.name)
    same("group polyend-oss", without(["CHIP"]), groupNames("polyend-oss"))
    same("group phz", without(["PHZ"]), groupNames("phz"))
    same("group plk", without(["PLK"]), groupNames("plk"))
    same("group experimental", [], groupNames("experimental"))
    expect(diffs).toEqual([])
  })

  test("every id: stored number, InstrumentTypeId, .patch engine id (engine_list.h text vs the host vs the editor)", async () => {
    const diffs: string[] = []
    const list = engineList()
    expect(list.map((e) => e.name)).toEqual(firmware.engines) // engine_list.h lists every engine of the tag, built in or plugin, in the list order
    const seen = { stored: new Map<number, string>(), typeId: new Map<number, string>(), patchId: new Map<number, string>() }
    for (const e of list) {
      for (const k of ["stored", "typeId", "patchId"] as const) {
        if (seen[k].has(e[k])) diffs.push(`${k} ${e[k]} is used by ${seen[k].get(e[k])} and ${e.name}`)
        seen[k].set(e[k], e.name)
      }
      if (noPrivateEngines.includes(e.name)) continue // (its numbers are checked as text above, the host has no such engine here)
      const r = raw.find((x) => x.name === e.name)
      const ed = editorEngines.find((x) => x.name === e.name)
      const m = metas[e.name]
      const check = (what: string, got: unknown, want: unknown) => { if (got !== want) diffs.push(`engine ${e.name} ${what}: firmware ${want}, editor ${got}`) }
      check("stored number (host raw)", r?.stored, e.stored)
      check("InstrumentTypeId (host raw)", r?.typeId, e.typeId)
      check(".patch engine id (host raw)", r?.patchId, e.patchId)
      check("stored number (engines)", ed?.stored, e.stored)
      check("InstrumentTypeId (engines)", ed?.typeId, e.typeId)
      check(".patch engine id (engines)", ed?.engineId, e.patchId)
      check("typeId (meta)", m?.typeId, e.typeId)
      check(".patch engine id (meta)", m?.engineId, e.patchId)
      check("the EngineDef name", r?.defName, e.name)
    }
    expect(diffs).toEqual([])
    // the numbers the firmware documents for its project files: PERC 4 and CHIP 6 as in the stock list, then JU6 7 PHZ 8 and the OpenTracker engines 9..17
    expect(list.map((e) => e.stored)).toEqual([0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18])
    // ... and Pluck, our own, 18 / 0x8A, after Arc-Type
    expect(list.at(-1)).toEqual({ name: "PLK", stored: 18, typeId: 0x8a, def: "kPlkDef", patchId: 0x8a })
  })

  test("every parameter slot, range, default, curve, value format, enum name, section and default macro (firmware tables vs what the editor serves)", () => {
    const diffs: string[] = []
    const eq = (what: string, firmwareV: unknown, editorV: unknown) => {
      if (JSON.stringify(firmwareV) !== JSON.stringify(editorV)) diffs.push(`${what}: firmware ${JSON.stringify(firmwareV)}, editor ${JSON.stringify(editorV)}`)
    }
    const f32 = (v: number) => Math.fround(v)
    const stepped = new Set(["enum", "onOff", "semi", "int", "ratio", "cents", "note", "bodyWave"]) // the editor's rule (host/poly_host.cpp cmdMeta)
    for (const r of raw) {
      const m = metas[r.name]
      const at = (i: number) => `engine ${r.name} param ${i} '${r.params[i]?.name}'`
      eq(`engine ${r.name} parameter count`, r.params.length, m.params.length)
      eq(`engine ${r.name} volume parameter`, r.volumeParam, m.volumeParam)
      eq(`engine ${r.name} voice cap`, r.maxVoices, m.maxVoices)
      for (let i = 0; i < Math.min(r.params.length, m.params.length); i++) {
        const f = r.params[i], e = m.params[i]
        eq(`${at(i)} id`, i, e.id)
        eq(`${at(i)} name`, f.name, e.name)
        eq(`${at(i)} min`, f32(f.min), f32(e.min))
        eq(`${at(i)} max`, f32(f.max), f32(e.max))
        eq(`${at(i)} default`, f32(f.def), f32(e.def))
        eq(`${at(i)} curve`, f.curve, e.curve)
        eq(`${at(i)} stepped`, stepped.has(f.fmt), e.stepped)
        if (f.fmt === "enum") eq(`${at(i)} enum names`, f.names, e.names)
      }
      eq(`engine ${r.name} sections`, r.sections.map((s: any) => [s.name, s.shortName, s.params]), m.sections.map((s: any) => [s.name, s.shortName, s.params]))
      // the default macros: the firmware's list, then the two system macros (Velocity, Pressure) the shim always adds
      const user = m.init.macros.slice(0, r.macros.length)
      eq(`engine ${r.name} default macros`, r.macros.map((x: any) => [x.name, x.bipolar, x.targets.map((t: any) => [t.param, f32(t.amount)])]),
        user.map((x: any) => [x.name, x.bipolar, x.targets.map((t: any) => [t.param, f32(t.amount)])]))
      eq(`engine ${r.name} macro names in meta`, r.macros.map((x: any) => x.name), m.macros.slice(0, r.macros.length).map((x: any) => x.name))
    }
    expect(diffs).toEqual([])
  })

  test("the parameter rows of engine_<name>.cpp, read as text, are the firmware tables the host dumped", () => {
    const diffs: string[] = []
    const files: Record<string, string> = {
      ACD: "engine_acd", FAT: "engine_fat", CHIP: "engine_chip", JU6: "engine_ju6", FM4: "engine_fm4",
      DTYPE: "engine_dtype", CSTYPE: "engine_cstype", ATYPE: "engine_atype", TTYPE: "engine_ttype", "8TYPE": "engine_eight", HANDTYPE: "engine_hand",
      BTYPE: "engine_btype", ARCTYPE: "engine_arc", PLK: "engine_pluck",
    }
    // PERC, VAP, WTFM and PHZ build part of their tables with macros (token pasting, row generators): their rows are not all literal text, the dump above covers them
    const rowRe = /\{\s*"((?:[^"\\]|\\.)*)"\s*,\s*([-+]?[0-9.]+f?)\s*,\s*([-+]?[0-9.]+f?)\s*,\s*([-+]?[0-9.]+f?)\s*,\s*F::(k\w+)\s*,\s*C::(k\w+)\s*,/g
    const fmtOf = (k: string) => k.replace(/^k/, "").replace(/^./, (c) => c.toLowerCase())
    for (const [engine, file] of Object.entries(files)) {
      if (noPrivateEngines.includes(engine) || !existsSync(join(vendor, `synth-open/${file}.cpp`))) continue // (private source: only with POLY_PRIVATE_SOURCE=1)
      const r = raw.find((x) => x.name === engine)
      const rows = [...read(`synth-open/${file}.cpp`).matchAll(rowRe)]
      if (rows.length !== r.params.length) { diffs.push(`engine ${engine}: ${rows.length} literal rows in ${file}.cpp, ${r.params.length} parameters in the firmware table`); continue }
      rows.forEach((m, i) => {
        const f = r.params[i]
        const row = { name: m[1], def: num(m[2]!), min: num(m[3]!), max: num(m[4]!), fmt: fmtOf(m[5]!), curve: m[6] }
        const curve = { kLinear: "linear", kExp: "exp", kSteep: "expSteep", kPower: "power" }[m[6]!]
        const want = { name: f.name, def: Math.fround(f.def), min: Math.fround(f.min), max: Math.fround(f.max), fmt: f.fmt, curve: f.curve }
        if (JSON.stringify({ ...row, curve }) !== JSON.stringify(want)) diffs.push(`engine ${engine} param ${i} '${f.name}': ${file}.cpp says ${JSON.stringify({ ...row, curve })}, the host dumped ${JSON.stringify(want)}`)
      })
    }
    expect(diffs).toEqual([])
  })

  test("voices: the firmware cap (kMaxVoicesPerInstrument, 1 for the kit engines) is what the editor reports, anything above it is editor only", () => {
    const cap = Number(read("synth-open/open_engine.h").match(/constexpr int kMaxVoicesPerInstrument\s*=\s*(\d+)/)![1])
    const diffs: string[] = []
    for (const e of editorEngines) {
      const r = raw.find((x) => x.name === e.name)
      const kit = r.maxVoices === 1
      if (e.maxVoices !== r.maxVoices) diffs.push(`engine ${e.name} voice cap: firmware ${r.maxVoices}, editor ${e.maxVoices}`)
      if (!kit && r.maxVoices !== cap) diffs.push(`engine ${e.name}: EngineDef::maxVoices ${r.maxVoices} is neither kMaxVoicesPerInstrument ${cap} nor 1`)
      if (e.editorMaxVoices !== (kit ? 1 : 8)) diffs.push(`engine ${e.name} editor voices: ${e.editorMaxVoices}`)
    }
    expect(diffs).toEqual([])
    expect(editorEngines.filter((e) => e.maxVoices === 1).map((e) => e.name)).toEqual(["PERC", "TTYPE"])
    expect(cap).toBe(4)
  })

  test("the editor's own expectations (test helpers, display names, UI groups) follow the firmware", () => {
    const diffs: string[] = []
    for (const e of editorEngines) {
      const want = PARAM_COUNTS[e.name] ?? OT3_PARAM_COUNTS[e.name] ?? (e.name === "PHZ" ? 62 : e.name === "PLK" ? PLK_PARAM_COUNT : undefined)
      if (want !== e.params) diffs.push(`engine ${e.name}: the test helpers expect ${want} parameters, the firmware has ${e.params}`)
      const ot3 = Object.keys(OT3_DISPLAY).includes(e.name)
      if ((e.group === "ot3") !== ot3) diffs.push(`engine ${e.name}: group ${e.group}`)
      const group = ot3 ? "ot3" : e.name === "PHZ" ? "phz" : e.name === "PLK" ? "plk" : e.name === "CHIP" ? "polyend-oss" : "polyend"
      if (e.group !== group) diffs.push(`engine ${e.name}: group ${e.group}, expected ${group}`)
      if (ot3 && e.display !== OT3_DISPLAY[e.name]) diffs.push(`engine ${e.name}: display name '${e.display}', expected '${OT3_DISPLAY[e.name]}'`)
    }
    expect(diffs).toEqual([])
  })

  test("algorithm 2 keeps its key: engine ids and parameter slots equal those in the frozen golden fixture", () => {
    // golden-algo2.json carries the metadata its vectors were made on and is never regenerated. algo 2 keys its PRNG by engine id and by the
    // parameter's .patch slot (= its id here): if the firmware moved either, replaying an old recipe would roll other numbers. Reported, never "fixed" by editing a frozen file.
    const golden = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/golden-algo2.json"), "utf8"))
    const diffs: string[] = []
    for (const [name, g] of Object.entries<any>(golden.engines)) {
      const m = metas[name]
      if (!m && noPrivateEngines.includes(name)) continue
      if (!m) { diffs.push(`engine ${name}: in the golden fixture, not in the editor`); continue }
      if (g.meta.engineId !== m.engineId) diffs.push(`engine ${name} id: golden ${g.meta.engineId}, now ${m.engineId}`)
      if (g.meta.params.length !== m.params.length) diffs.push(`engine ${name} parameter count: golden ${g.meta.params.length}, now ${m.params.length}`)
      g.meta.params.forEach((p: any, i: number) => {
        const n = m.params[i]
        if (!n) return
        if (p.id !== n.id || p.name !== n.name) diffs.push(`engine ${name} slot ${i}: golden '${p.name}' (id ${p.id}), now '${n.name}' (id ${n.id})`)
      })
    }
    expect(diffs).toEqual([])
  })
})

describe("the vendored tree", () => {
  test("the overlay (scripts/shim.patch) touches exactly the files it documents, and no codec file", () => {
    const patch = readFileSync(join(root, "scripts/shim.patch"), "utf8")
    const files = [...patch.matchAll(/^\+\+\+ b\/(\S+)/gm)].map((m) => m[1]!).sort()
    expect(files).toEqual(["synth-open/engine_atype.cpp", "synth-open/open_engine.h", "synth-open/open_load.h", "synth-open/open_synth.cpp"])
    expect(files.some((f) => /patchio|patchdata|open_patch\.h|open_cold/.test(f))).toBe(false) // the .patch codec is the firmware's, byte for byte
  })

  const poly = process.env.POLY_REPO ?? "/nonexistent"
  const haveTag = existsSync(join(poly, ".git")) && (() => {
    try { return execFileSync("git", ["-C", poly, "rev-parse", "--verify", "-q", `refs/tags/${firmware.tag}^{commit}`]).toString().trim() === firmware.commit } catch { return false }
  })()
  const osRepo = process.env.POLY_ENGINES_OS_REPO ?? "/nonexistent"
  const haveOs = existsSync(join(osRepo, ".git")) && (() => {
    try { return execFileSync("git", ["-C", osRepo, "rev-parse", "--verify", "-q", `${firmware.modules.commit}^{commit}`]).toString().trim() === firmware.modules.commit } catch { return false }
  })()
  test.skipIf(!haveTag || !haveOs)("every vendored file is byte for byte the tag or, for the OpenTracker engines, the public module repository at the pinned commit, except the overlay files and the generated ones", () => {
    const overlay = new Set(["synth-open/engine_atype.cpp", "synth-open/open_engine.h", "synth-open/open_load.h", "synth-open/open_synth.cpp"])
    // the private files (PHZ and PLK) are the engines tag's bytes, checked in the test below, not the firmware tag's
    const experimental = new Set([...firmware.private.files])
    // the engine tables and DSP of the OpenTracker engines (and their headers) come from the module repository
    const fromOs = (f: string) => /^synth-open\/(engine_(ju6|fm4|dtype|cstype|atype|ttype|eight|hand|btype|arc)\.cpp|ot-synths\/)/.test(f)
    const renamed: Record<string, string> = { // licence texts vendor.sh copies under another name
      "LICENSE-fmt-MIT.rst": "util/3rdparty/fmt/LICENSE.rst", "LICENSE-tracker-ce-MIT-clone-restriction": "LICENSE",
      "LICENSE-OpenTracker-Apache-2.0": "licenses/LICENSE-OpenTracker-Apache-2.0.txt",
      "LICENSE-Boost-1.0": "util/3rdparty/tiny/LICENSE",
    }
    const walk = (d: string): string[] => readdirSync(join(vendor, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]))
    const diffs: string[] = []
    let n = 0, os = 0
    for (const f of walk("")) {
      if (overlay.has(f) || experimental.has(f)) continue
      const [repo, rev, upstream] = f === "LICENSE-OpenTracker-synths-MIT" ? [osRepo, firmware.modules.commit, "licenses/LICENSE-OpenTracker-synths-MIT.txt"]
        : fromOs(f) ? [osRepo, firmware.modules.commit, `src/${f}`] : [poly, firmware.commit, renamed[f] ?? f]
      let want: Buffer
      try { want = execFileSync("git", ["-C", repo, "show", `${rev}:${upstream}`], { maxBuffer: 64 << 20 }) } catch { diffs.push(`${f}: not in ${repo === poly ? firmware.tag : firmware.modules.repo}`); continue }
      if (!want.equals(readFileSync(join(vendor, f)))) diffs.push(`${f}: differs from ${repo === poly ? firmware.tag : firmware.modules.repo + " " + firmware.modules.tag}`)
      if (repo === osRepo) os++
      n++
    }
    expect(diffs).toEqual([])
    expect(n).toBeGreaterThan(150)
    // the OpenTracker sources minus engine_atype.cpp (overlay), the ten DSP headers and the licence came from tracker-engines-os
    expect(os).toBe(firmware.modules.files.length - 1 + 10 + 1)
  }, 120_000)
})

// ---- the plugin engines of the tag: the module pins of engines/external.lock.json, and Pluck (PLK), private, a release engine since tracker-ff 1.2.0
const PHZ_JSON_PUBLISHED = "95ea12cc347b5890d173476e6bac0cf4574ee3f4699c6b6d4a43cd5fef1a923d" // sha256 of phz.json in the engines-v1.2.1 release
// engines-v1.2.1 and effects-v1.0.1 re-issue the .json manifests of engines-v1.2.0 and effects-v1.0.0 (they no longer name a private repository), the .wasm files
// are byte identical. The lock pins the re-issues, the firmware tag's external.lock.json still pins the first releases.
const REISSUE = { engines: ["engines-v1.2.1", "0bb42061d4921c2ea2a1c55dd5ec527f32fd24c0"], effects: ["effects-v1.0.1", "5ee21dee1df0c015a1e01b48d320e5637985fa85"] }
describe("the plugin engines (module repositories pinned by the tag's engines/external.lock.json)", () => {
  const poly = process.env.POLY_REPO ?? "/nonexistent"
  const git = (...args: string[]) => execFileSync("git", ["-C", poly, ...args], { maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] })
  const fromTag = (path: string) => git("show", `${firmware.commit}:${path}`).toString("utf8")
  // the engines repository at the release tag the firmware tag pins: PHZ and PLK come from there, never from the firmware repository
  const pe = firmware.private
  const privRepo = process.env.POLY_ENGINES_REPO ?? "/nonexistent"
  const privGit = (...args: string[]) => execFileSync("git", ["-C", privRepo, ...args], { maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] })
  const havePriv = existsSync(join(privRepo, ".git")) && (() => { try { return privGit("rev-parse", "--verify", "-q", `refs/tags/${pe.tag}^{commit}`).toString().trim() === pe.commit } catch { return false } })()
  // PLK comes from the override commit when the lock has one (PLK 1.1, later than the tag), every other file from the tag
  const commitOf = (path: string) => (pe.override && /pluck/.test(path) ? pe.override.commit : pe.commit)
  const fromPriv = (path: string) => privGit("show", `${commitOf(path)}:src/${path}`).toString("utf8")

  test.skipIf(!haveTag())("the module pins are the tag's: the public module repository for the OpenTracker engines, the engines repository for PHZ and PLK, and modules.lock.json agrees", () => {
    const ext = JSON.parse(fromTag("engines/external.lock.json")).sets
    expect([firmware.modules.repo, firmware.modules.tag, firmware.modules.commit]).toEqual([ext["engines-os"].repo, ext["engines-os"].tag, ext["engines-os"].tag_commit])
    expect([pe.tag, pe.commit]).toEqual([ext.engines.tag, ext.engines.tag_commit])
    const all0 = JSON.parse(readFileSync(join(root, "modules.lock.json"), "utf8")).sets
    const lock = all0.engines
    expect([lock.tag, lock.tag_commit]).toEqual(REISSUE.engines)
    expect([all0.effects.tag, all0.effects.tag_commit]).toEqual(REISSUE.effects)
    for (const f of Object.keys(ext.effects.files)) if (f.endsWith(".wasm")) expect([f, all0.effects.files[f]]).toEqual([f, ext.effects.files[f]])
    // the module files the editor loads for PHZ are the ones the tag pins (sha256), PLK is the override (PLK 1.1, the pluck.plg of the release zip)
    expect(["phz.wasm", lock.files["phz.wasm"]]).toEqual(["phz.wasm", ext.engines.files["phz.wasm"]])
    // phz.json is the re-issued manifest of engines-v1.2.1 (the tag's external.lock.json pins the first one): only its "notice" text changed, the wasm is bit identical
    expect(["phz.json", lock.files["phz.json"]]).toEqual(["phz.json", PHZ_JSON_PUBLISHED])
    expect(pe.override).toMatchObject({ engine: "PLK", version: "1.1.0", plg_sha256: "fcabdc0ac8b540f02b3c62b1bc6749a08d1486e899a7629d57411aa018500bc0" })
    expect(lock.files["pluck.wasm"]).toBe(pe.override!.wasm_sha256)
    expect(lock.overrides.pluck).toMatchObject({ commit: pe.override!.commit, wasm_sha256: pe.override!.wasm_sha256, plg_sha256: pe.override!.plg_sha256 })
    // the public module sets are the published releases the tag pins: repository, tag, commit and every file's sha256
    const all = JSON.parse(readFileSync(join(root, "modules.lock.json"), "utf8")).sets
    for (const n of ["engines-os", "effects-os"]) {
      const l = all[n], e = ext[n]
      expect([n, l.repo, l.tag, l.tag_commit, l.tag_status]).toEqual([n, e.repo, e.tag, e.tag_commit, "published"])
      for (const [f, h] of Object.entries({ ...e.files, ...e.notice_files })) if (/\.(wasm|json|md|txt)$/.test(f)) expect([n, f, l.files[f]]).toEqual([n, f, h])
    }
    // every engine row the tag ships (no optional group in 1.2.0) is an engine of the editor, with the same numbers
    const rows = JSON.parse(fromTag("engines/engines.json")).engines.filter((e: any) => !e.optional)
    expect(rows.map((e: any) => e.name).sort()).toEqual(makeList("SYNTH_ENGINES_EXT").sort())
    const list = engineList()
    const diffs: string[] = []
    for (const r of rows) {
      const l = list.find((e) => e.name === r.name)
      if (!l || l.stored !== r.stored || l.patchId !== r.patch || l.typeId !== r.type) diffs.push(`${r.name}: engines.json ${r.stored}/${r.type}/${r.patch}, engine_list.h ${l?.stored}/${l?.typeId}/${l?.patchId}`)
      const ed = editorEngines.find((e) => e.name === r.name)
      if (!ed && !noPrivateEngines.includes(r.name)) diffs.push(`${r.name}: not served by the editor`)
      else if (ed && (ed.stored !== r.stored || ed.engineId !== r.patch || ed.typeId !== r.type)) diffs.push(`${r.name}: engines.json ${r.stored}/${r.type}/${r.patch}, editor ${ed.stored}/${ed.typeId}/${ed.engineId}`)
      if (r.repo === "tracker-engines-os" ? !firmware.modules.engines.includes(r.name) : !pe.engines.includes(r.name)) diffs.push(`${r.name}: from ${r.repo}, FIRMWARE.json says otherwise`)
    }
    expect(diffs).toEqual([])
  })

  test("the PHZ and PLK source is in no tracked file, git ignored where it is on disk, and the engines release tag's bytes", () => {
    expect(pe.repo).toBe("ff-engines")
    expect(pe.engines).toEqual(["PHZ", "PLK"])
    expect(pe.commit).toMatch(/^[0-9a-f]{40}$/)
    const prov = readFileSync(join(root, "vendor/PROVENANCE.md"), "utf8")
    expect(prov).toContain(`ff-engines ${pe.tag} (commit ${pe.commit})`)
    for (const f of pe.files) {
      const tracked = Bun.spawnSync(["git", "-C", root, "ls-files", "--error-unmatch", join("vendor/poly", f)], { stdout: "pipe", stderr: "pipe" })
      expect([f, tracked.exitCode]).toEqual([f, 1])
      if (!existsSync(join(vendor, f))) continue // (public build: the private source is not here, it is only copied with POLY_PRIVATE_SOURCE=1)
      const ignored = Bun.spawnSync(["git", "-C", root, "check-ignore", "-q", join("vendor/poly", f)])
      expect([f, ignored.exitCode]).toEqual([f, 0])
    }
    if (!havePriv) return
    for (const f of pe.files.filter((x) => existsSync(join(vendor, x)))) expect([f, read(f) === fromPriv(f)]).toEqual([f, true])
  })

  test.skipIf(!havePriv || !havePrivate("PLK"))("Pluck's metadata (ids, parameter rows, sections, default macros) is what the tag and the engines release say, in the host and in what the editor serves", async () => {
    const diffs: string[] = []
    const entry = engineList().find((e) => e.name === "PLK")!
    expect([entry.stored, entry.typeId, entry.patchId]).toEqual([18, 0x8a, 0x8a])
    const r = raw.find((x) => x.name === "PLK"), ed = editorEngines.find((x) => x.name === "PLK"), m = metas.PLK
    expect([r.stored, r.typeId, r.patchId, ed.stored, ed.typeId, ed.engineId, m.typeId, m.engineId]).toEqual([18, 0x8a, 0x8a, 18, 0x8a, 0x8a, 0x8a, 0x8a])
    expect(fromPriv("synth-open/pluck/pluck.h")).toMatch(/kEngineId\s*=\s*0x8A/)
    const src = fromPriv("synth-open/engine_pluck.cpp")
    const rowRe = /\{\s*"((?:[^"\\]|\\.)*)"\s*,\s*([-+]?[0-9.]+f?)\s*,\s*([-+]?[0-9.]+f?)\s*,\s*([-+]?[0-9.]+f?)\s*,\s*F::(k\w+)\s*,\s*C::(k\w+)\s*,/g
    const rows = [...src.matchAll(rowRe)]
    const hdr = fromPriv("synth-open/pluck/pluck.h").match(/enum Param : int \{([^}]*)\}/)![1]!
    const paramNames = hdr.replace(/\/\/.*$/gm, "").split(",").map((x) => x.trim().replace(/=.*/, "").trim()).filter(Boolean)
    expect(paramNames.at(-1)).toBe("kParamCount")
    expect(rows.length).toBe(paramNames.length - 1)
    expect(rows.length).toBe(r.params.length)
    expect(m.params.length).toBe(rows.length)
    const curveOf: Record<string, string> = { kLinear: "linear", kExp: "exp", kSteep: "expSteep", kPower: "power" }
    rows.forEach((x, i) => {
      const want = { name: x[1], def: num(x[2]!), min: num(x[3]!), max: num(x[4]!), fmt: x[5]!.replace(/^k/, "").replace(/^./, (c) => c.toLowerCase()), curve: curveOf[x[6]!] }
      const f = r.params[i], e = m.params[i]
      const got = { name: f.name, def: Math.fround(f.def), min: Math.fround(f.min), max: Math.fround(f.max), fmt: f.fmt, curve: f.curve }
      if (JSON.stringify(want) !== JSON.stringify(got)) diffs.push(`PLK param ${i}: the engines release says ${JSON.stringify(want)}, host ${JSON.stringify(got)}`)
      if (e.name !== want.name || Math.fround(e.min) !== want.min || Math.fround(e.max) !== want.max || Math.fround(e.def) !== want.def) diffs.push(`PLK param ${i} '${want.name}': the editor serves ${e.name} ${e.min}..${e.max} def ${e.def}`)
    })
    expect(paramNames.indexOf("kVolume")).toBe(r.volumeParam)
    expect(m.volumeParam).toBe(r.volumeParam)
    const sections = [...src.matchAll(/\{\s*"(\w+)",\s*"(\w+)",\s*k\w+,\s*sizeof/g)].map((x) => [x[1], x[2]])
    expect(m.sections.map((x: any) => [x.name, x.shortName])).toEqual(sections)
    const macros = [...src.matchAll(/\{\s*"([^"]+)",\s*(true|false),\s*1,\s*\{\s*\{\s*Param::(k\w+),/g)].map((x) => [x[1], x[2] === "true", paramNames.indexOf(x[3]!)])
    expect(macros.length).toBe(6)
    expect(m.init.macros.slice(0, 6).map((x: any) => [x.name, x.bipolar, x.targets[0].param])).toEqual(macros)
    expect(diffs).toEqual([])
  })

  test("Pluck's ids are its own: no other engine, the golden fixture or an old-build alias uses stored 18 or 0x8A", () => {
    const others = editorEngines.filter((e) => e.name !== "PLK")
    expect(others.some((e) => e.stored === 18 || e.typeId === 0x8a || e.engineId === 0x8a)).toBe(false)
    const golden = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/golden-algo2.json"), "utf8"))
    expect(Object.keys(golden.engines)).not.toContain("PLK") // the golden vectors cover the engines that existed when they were frozen
    expect(Object.values<any>(golden.engines).some((g) => g.meta.engineId === 0x8a)).toBe(false)
    expect([0x10, 0x82].includes(0x8a)).toBe(false) // the ids an older editor build wrote and the host maps on load: CHIP 0x10, D-Type 0x82
    const list = engineList()
    expect(list.filter((e) => e.stored === 18 || e.typeId === 0x8a || e.patchId === 0x8a).map((e) => e.name)).toEqual(["PLK"])
  })
})
function haveTag(): boolean {
  const poly = process.env.POLY_REPO ?? "/nonexistent"
  try { return execFileSync("git", ["-C", poly, "rev-parse", "--verify", "-q", `refs/tags/${firmware.tag}^{commit}`]).toString().trim() === firmware.commit } catch { return false }
}
