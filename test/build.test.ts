import { expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { build, hostBinary } from "../scripts/build"

test("host binary builds with clang++ and runs, without the private engines PHZ and PLK (they come from runtime modules)", async () => {
  await build()
  expect(existsSync(hostBinary)).toBe(true)
  expect(statSync(hostBinary).size).toBeGreaterThan(100_000)
  const p = Bun.spawn([hostBinary, "engines"], { stdout: "pipe" })
  const out = JSON.parse(await new Response(p.stdout).text())
  expect(await p.exited).toBe(0)
  expect(out.engines.map((e: any) => e.name)).toEqual(["ACD", "FAT", "VAP", "WTFM", "PERC", "CHIP", "FM4", "JU6", "DTYPE", "CSTYPE", "ATYPE", "TTYPE", "8TYPE", "HANDTYPE", "BTYPE", "ARCTYPE"])
}, 300_000)

test("a second build is incremental (nothing recompiled)", async () => {
  await build()
  expect((await build()).rebuilt).toBe(0)
}, 300_000)

test("the native host is built without the private source: no PHZ or PLK file in its sources, and none of their code in the binary", async () => {
  const { privateEngines } = await import("../scripts/build")
  expect(privateEngines).toEqual(["PHZ", "PLK"])
  const p = Bun.spawn([hostBinary, "meta", "PHZ"], { stdout: "pipe" })
  const out = JSON.parse(await new Response(p.stdout).text())
  expect(out.ok).toBe(false)
  const objs = (await Array.fromAsync(new Bun.Glob("**/*.o").scan({ cwd: join(hostBinary, "../obj") }))).join(" ")
  expect(objs).not.toMatch(/phz|pluck/)
})
