// The runtime module files for the page (public/modules.html): the wasm hosts of scripts/build-wasm.ts and the module set scripts/modules.ts
// fetched into build/modules. Only those names are served, nothing else of build/.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { modulesDir } from "./modules-dir"

const root = join(import.meta.dir, "..")
const types: Record<string, string> = { ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".md": "text/markdown", ".txt": "text/plain" }

/** A Response for /wasm/<target>/poly.(mjs|wasm) and /modules/index.json and /modules/<set>/<file of the lock>, or null for any other path. */
export function moduleRoute(pathname: string): Response | null {
  let file: string | null = null
  const w = pathname.match(/^\/wasm\/(linked|runtime)\/(poly\.mjs|poly\.wasm)$/)
  if (w) file = join(root, "build/wasm", w[1], w[2])
  const m = pathname.match(/^\/modules\/((?:[a-z][a-z-]*\/)?[A-Za-z0-9_.-]+)$/)
  if (m) {
    const idx = join(modulesDir(), "index.json")
    if (!existsSync(idx)) return new Response("no module set: run bun scripts/modules.ts", { status: 404 })
    const lock = JSON.parse(readFileSync(join(root, "modules.lock.json"), "utf8"))
    const allowed = new Set<string>(["index.json", ...Object.entries<any>(lock.sets).flatMap(([n, s]) => Object.keys(s.files).map((f) => `${n}/${f}`))])
    if (allowed.has(m[1])) file = join(modulesDir(), m[1])
  }
  if (!file) return null
  if (!existsSync(file)) return new Response("not built: run bun scripts/build-wasm.ts and bun scripts/modules.ts", { status: 404 })
  const ext = file.slice(file.lastIndexOf("."))
  return new Response(Bun.file(file), { headers: { "content-type": types[ext] ?? "application/octet-stream", "cache-control": "no-store" } })
}
