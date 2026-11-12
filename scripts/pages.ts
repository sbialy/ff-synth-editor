// The static site for GitHub Pages: plain files in dist/pages (default), served by any static file server, no bun server and no API. Release mode only
// (Strict, the engines of the firmware release image).
//  - the page files of public/ (minus the server-only and dev-only ones), index.html with the release markup (the Strict box cut out, as the release
//    server serves it) and marked data-static="1": public/app.js then answers its /api requests in the page (pages/static-api.ts, bundled here) and
//    plays live audio with the wasm host inside the AudioWorklet (pages/worklet-static.js)
//  - the wasm host, wasm/runtime/poly.{mjs,wasm} (scripts/build-wasm.ts runtime, built here when missing)
//  - the runtime modules: the sets of a directory scripts/modules.ts filled (--modules dir, layout of build/modules: index.json and <set>/), each file
//    checked against modules.lock.json again. Only the modules this host uses go in: the master inserts and the synth engines the host has a runtime
//    slot for (PHZ, PLK, JU6), plus every set's NOTICE.md and licence files. Without --modules the site has the linked-in engines only.
//  - static-config.json (the firmware info and the served engine list the server would compute) and the bundled default patches (public/defaults)
// Every root-absolute URL of the page files ("/app.js", "/wasm/...") is made relative, so the site works under a project path (/ff-synth-editor/).
// Usage: bun scripts/pages.ts [outDir] [--modules dir] [--require-modules]     --require-modules: fail unless every set of modules.lock.json is in dir
import { createHash } from "node:crypto"
import { copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { buildWasm, outDir as wasmOut, RUNTIME_ENGINES } from "./build-wasm"
import { firmware, firmwareInfo } from "../server/firmware"
import { ENGINES, FIRMWARE_ENGINES, HIDDEN_ENGINES } from "../server/engines"

const root = join(import.meta.dir, "..")
const publicDir = join(root, "public")
/** page files that need the server or are dev tools: the WebSocket worklets, the runtime module test page */
const SERVER_ONLY = new Set(["worklet.js", "worklet-inserts.js", "modules.html", "modules.js", "modules-worklet.js"])
const lock = JSON.parse(readFileSync(join(root, "modules.lock.json"), "utf8"))
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")

/** "/app.js" -> "./app.js" in a quoted string or import of a page file: every path that names a file of the site, never /api/. */
export function relativeUrls(text: string): string {
  return text.replace(/(["'`(])\/(?=(?:wasm\/|modules\/|defaults\/|[\w.-]+\.(?:js|mjs|wasm|json|html)\b))/g, "$1./")
}

async function copyModules(src: string, out: string, requireAll: boolean): Promise<string[]> {
  const idx = JSON.parse(await readFile(join(src, "index.json"), "utf8"))
  const sets = Object.keys(idx.sets)
  const missing = Object.keys(lock.sets).filter((s) => !sets.includes(s))
  if (requireAll && missing.length) throw new Error(`module set(s) ${missing.join(", ")} missing in ${src}`)
  const keep = idx.modules.filter((m: any) => m.kind === "master" || (m.kind === "synth" && m.name in RUNTIME_ENGINES))
  const files = new Set<string>()
  for (const m of keep) files.add(m.manifest).add(m.wasm)
  for (const s of sets) for (const f of Object.keys(lock.sets[s].files)) if (f === "NOTICE.md" || f === "LICENSE.md" || /^LICENSE.*\.txt$/.test(f)) files.add(`${s}/${f}`)
  for (const f of files) {
    const [set, name] = f.split("/")
    const want = lock.sets[set]?.files[name]
    const bytes = new Uint8Array(await readFile(join(src, f)))
    if (!want || sha(bytes) !== want) throw new Error(`${f}: not the file modules.lock.json pins`)
    await mkdir(join(out, "modules", set), { recursive: true })
    await writeFile(join(out, "modules", f), bytes)
  }
  await writeFile(join(out, "modules/index.json"), JSON.stringify({ ...idx, modules: keep }, null, 1) + "\n")
  return keep.map((m: any) => `${m.name} (${m.set})`)
}

export async function buildPages(out = join(root, "dist/pages"), opts: { modules?: string; requireModules?: boolean } = {}): Promise<{ out: string; modules: string[] }> {
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
  // page files, URLs made relative
  for (const e of await readdir(publicDir, { withFileTypes: true })) {
    if (SERVER_ONLY.has(e.name)) continue
    const from = join(publicDir, e.name)
    if (e.isDirectory()) { await cp(from, join(out, e.name), { recursive: true }); continue }
    if (/\.(js|html)$/.test(e.name)) await writeFile(join(out, e.name), relativeUrls(await readFile(from, "utf8")))
    else await copyFile(from, join(out, e.name))
  }
  const html = relativeUrls((await readFile(join(publicDir, "index.html"), "utf8")).replace(/<!--strict-->[\s\S]*?<!--\/strict-->\s*/, "")).replace(/<html\b/, '<html data-static="1"')
  if (!html.includes('data-static="1"')) throw new Error("index.html has no <html> tag to mark")
  await writeFile(join(out, "index.html"), html)
  await writeFile(join(out, "worklet-static.js"), relativeUrls(await readFile(join(root, "pages/worklet-static.js"), "utf8")))
  const b = await Bun.build({ entrypoints: [join(root, "pages/static-api.ts")], target: "browser", format: "esm", minify: false })
  if (!b.success) throw new Error("static-api.ts: " + b.logs.join("\n"))
  await writeFile(join(out, "static-api.js"), await b.outputs[0].text())
  // the wasm host
  if (!existsSync(join(wasmOut("runtime"), "poly.wasm"))) await buildWasm("runtime")
  await mkdir(join(out, "wasm/runtime"), { recursive: true })
  for (const f of ["poly.mjs", "poly.wasm"]) await copyFile(join(wasmOut("runtime"), f), join(out, "wasm/runtime", f))
  // what the server computes for /api/engines in release mode
  const served = ENGINES.filter((e) => FIRMWARE_ENGINES.includes(e) && !HIDDEN_ENGINES.includes(e))
  await writeFile(join(out, "static-config.json"), JSON.stringify({ firmware: firmwareInfo(true), served, privateEngines: firmware.private.engines, runtimeEngines: Object.keys(RUNTIME_ENGINES) }, null, 1) + "\n")
  const modules = opts.modules ? await copyModules(opts.modules, out, !!opts.requireModules) : []
  await writeFile(join(out, ".nojekyll"), "")
  // nothing may still point at the site root: the site lives under a project path
  for (const f of [...(await readdir(out)).filter((n) => /\.(js|html)$/.test(n))]) {
    const t = await readFile(join(out, f), "utf8")
    const bad = t.match(/["'`(]\/(?!api\/|\/)[\w.-]+\.(?:js|mjs|wasm|json|html)\b|["'`(]\/(?:wasm|modules|defaults)\//)
    if (bad) throw new Error(`${f} still names a root path: ${bad[0]}`)
  }
  return { out, modules }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const mi = args.indexOf("--modules")
  const modules = mi >= 0 ? resolve(args[mi + 1]!) : undefined
  const outArg = args.find((a, i) => !a.startsWith("--") && (mi < 0 || i !== mi + 1))
  const r = await buildPages(outArg ? resolve(outArg) : undefined, { modules, requireModules: args.includes("--require-modules") })
  console.log("static site ->", r.out)
  console.log(r.modules.length ? `runtime modules: ${r.modules.join(", ")}` : "no runtime modules (--modules dir): the linked-in engines only")
}
