// POLY_FPCONTRACT=fast|off: the arm64 A/B build of the engine library (scripts/build.ts) and the badge that says which one a page plays.
// Unset (the default) nothing changes: the x86_64 host in build/. The server side only runs when the variable is set, for example
// `POLY_FPCONTRACT=off bun test test/fpcontract.test.ts`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fpContract, fpContractOf, hostBinary, math, root } from "../scripts/build"
import { startServer } from "../server/index"

describe("POLY_FPCONTRACT", () => {
  test("accepts fast and off, nothing else", () => {
    expect(fpContractOf(undefined)).toBeUndefined()
    expect(fpContractOf("")).toBeUndefined()
    expect(fpContractOf("fast")).toBe("fast")
    expect(fpContractOf("off")).toBe("off")
    for (const bad of ["on", "FAST", "1", "contract"]) expect(() => fpContractOf(bad)).toThrow(/fast or off/)
  })

  test("each variant has its own binary and label, the default keeps build/poly_host", () => {
    expect(hostBinary).toBe(join(root, "build", ...(fpContract ? [`fpc-${fpContract}`] : []), "poly_host"))
    expect(math.arch).toBe(fpContract ? "arm64" : "x86_64")
    expect(math.label).toBe(fpContract === "fast" ? "fp-contract fast (AUTO)" : fpContract === "off" ? "fp-contract off (AUTO-F)" : "fp-contract default")
  })

  test("the page carries no math badge", () => {
    expect(readFileSync(join(root, "public/index.html"), "utf8")).not.toMatch(/mathbadge|fused/i)
    expect(readFileSync(join(root, "public/app.js"), "utf8")).not.toMatch(/mathbadge/)
  })

  describe.skipIf(!fpContract)("server of an A/B build", () => {
    let s: Awaited<ReturnType<typeof startServer>>
    beforeAll(async () => { s = await startServer({ port: 0, dir: "" }) }, 300_000)
    afterAll(() => s?.stop())
    test("/api/engines names the build", async () => {
      const j = await (await fetch(s.url + "/api/engines")).json()
      expect(j.math).toEqual({ fpContract, arch: "arm64", label: math.label })
    })
    test("a release server of the same build does not", async () => {
      const r = await startServer({ port: 0, dir: "", release: true })
      try {
        const j = await (await fetch(r.url + "/api/engines")).json()
        expect(j.release).toBe(true)
        expect(j.math).toBeUndefined()
        expect(JSON.stringify(j)).not.toMatch(/fused|AUTO-F|fpContract/)
      } finally { r.stop() }
    }, 300_000)
  })
})
