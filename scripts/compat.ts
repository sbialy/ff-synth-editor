// Firmware codec compatibility check on the Polyend factory patches:
// every file is loaded with the synth-open PatchStore and saved again in memory, the bytes are compared.
// Usage: bun scripts/compat.ts [factory-dir] [--list]   (default: the folder POLY_FACTORY_DIR names)
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { build } from "./build"
import { HostClient } from "../server/host"

export const defaultFactoryDir = process.env.POLY_FACTORY_DIR ?? ""
export const engines = ["ACD", "FAT", "VAP", "WTFM"]

export type FileResult = {
  engine: string
  file: string
  size: number
  loaded: boolean
  identical: boolean
  codecIdentical?: boolean
  savedSize?: number
  firstDiff?: number
  reason?: string
  hints?: string[]
}

export async function runCompat(dir = defaultFactoryDir, host?: HostClient): Promise<FileResult[]> {
  const own = !host
  host ??= new HostClient()
  const out: FileResult[] = []
  try {
    for (const engine of engines) {
      const files = readdirSync(join(dir, engine)).filter((f) => f.endsWith(".patch")).sort()
      for (const file of files) {
        const r = await host.tryRequest({ cmd: "roundtrip", path: join(dir, engine, file) })
        out.push({ engine, file, size: r.size, loaded: !!r.loaded, identical: !!r.identical, codecIdentical: r.codecIdentical, savedSize: r.savedSize, firstDiff: r.firstDiff, reason: r.reason, hints: r.hints })
      }
    }
  } finally {
    if (own) host.close()
  }
  return out
}

export function summarize(results: FileResult[]): string {
  const lines: string[] = []
  const row = (name: string, rs: FileResult[]) =>
    `${name.padEnd(6)} files ${String(rs.length).padStart(3)}  load ${String(rs.filter((r) => r.loaded).length).padStart(3)}  byte-identical re-save ${String(rs.filter((r) => r.identical).length).padStart(3)}`
  for (const e of engines) lines.push(row(e, results.filter((r) => r.engine === e)))
  lines.push(row("TOTAL", results))
  return lines.join("\n")
}

if (import.meta.main) {
  await build()
  const dir = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? defaultFactoryDir
  if (!dir) throw new Error("pass the folder of .patch files (one subfolder per engine) or set POLY_FACTORY_DIR")
  const results = await runCompat(dir)
  console.log(summarize(results))
  const bad = results.filter((r) => !r.identical)
  // group failures by cause
  const groups = new Map<string, FileResult[]>()
  for (const r of bad) {
    const key = !r.loaded ? `load refused: ${r.reason}` : [...new Set((r.hints ?? []).map((h) => h.split(":")[0]))].sort().join(" + ") || "bytes differ, model unchanged"
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  console.log(`\n${bad.length} failing file(s) in ${groups.size} group(s):`)
  for (const [k, rs] of groups) {
    console.log(`\n[${rs.length}] ${k}`)
    if (process.argv.includes("--list")) for (const r of rs) console.log(`    ${r.engine}/${r.file}  ${r.size} -> ${r.savedSize ?? "-"} B  firstDiff ${r.firstDiff ?? "-"}  codecOnlyIdentical=${r.codecIdentical}`)
  }
}
