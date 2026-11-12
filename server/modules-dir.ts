// Where the runtime modules are installed (scripts/modules.ts writes them, server/wasm-host.ts and server/modules-routes.ts read them).
// build/modules unless POLY_MODULES_DIR names another directory. Read at every call, not once at import, so a test can point one run at a
// temp directory and put the variable back afterwards.
import { isAbsolute, join, resolve } from "node:path"

const root = join(import.meta.dir, "..")

export const modulesDir = (): string => {
  const d = process.env.POLY_MODULES_DIR
  return d ? (isAbsolute(d) ? d : resolve(d)) : join(root, "build/modules")
}
