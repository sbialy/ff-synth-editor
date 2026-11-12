// A test that installs modules (fetchModules wipes and rewrites the module directory) works in its own temp directory, never in build/modules:
// the release server and the other tests read the installed modules there. Point POLY_MODULES_DIR (server/modules-dir.ts) at a fresh
// directory in beforeAll and call the returned function in afterAll, it puts the variable back and deletes the directory.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export function useTempModules(): () => void {
  const before = process.env.POLY_MODULES_DIR
  const dir = mkdtempSync(join(tmpdir(), "poly-editor-modules-"))
  process.env.POLY_MODULES_DIR = dir
  return () => {
    if (before === undefined) delete process.env.POLY_MODULES_DIR
    else process.env.POLY_MODULES_DIR = before
    rmSync(dir, { recursive: true, force: true })
  }
}
