// The save-as name of the static Pages build (public/filename.js) and the case-insensitive engine folder of the server (patchRoot).
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
// @ts-ignore plain browser module
import { saveName, MAX_NAME, FALLBACK_NAME } from "../public/filename.js"
import { patchRoot } from "../server/index"

describe("saveName (static Save)", () => {
  test("a plain name stays, .patch is not doubled", () => {
    expect(saveName("Acid Slur")).toBe("Acid Slur")
    expect(saveName("Lead.PATCH")).toBe("Lead")
  })
  test("every Windows forbidden character becomes _", () => {
    expect(saveName('a\\b/c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j")
    expect(saveName("tab\there\x00x")).toBe("tab_here_x")
    expect(saveName("E:\\Patches\\ACD\\foo.patch")).toBe("E__Patches_ACD_foo")
  })
  test("no trailing dots or spaces, no leading dot", () => {
    expect(saveName("name. . ")).toBe("name")
    expect(saveName(".hidden")).toBe("hidden")
    expect(saveName("  padded  ")).toBe("padded")
  })
  test("empty or only dots and spaces falls back", () => {
    for (const v of ["", "   ", "...", ". .", undefined, null]) expect(saveName(v)).toBe(FALLBACK_NAME)
    expect(saveName("", "x")).toBe("x")
  })
  test("Windows device names get a prefix, other names with the same start do not", () => {
    expect(saveName("CON")).toBe("_CON")
    expect(saveName("nul.")).toBe("_nul")
    expect(saveName("COM1")).toBe("_COM1")
    expect(saveName("console")).toBe("console")
  })
  test("at most 64 characters, cut before the trailing trim", () => {
    expect(saveName("a".repeat(100))).toHaveLength(MAX_NAME)
    expect(saveName("a".repeat(63) + " b")).toBe("a".repeat(63))
  })
  test("the result is idempotent and never needs a rewrite by the browser", () => {
    for (const v of ['Lead: soft?', "CON", "x".repeat(80), "a/b\\c", "..", "ok"]) {
      const n = saveName(v)
      expect(saveName(n)).toBe(n)
      expect(n).not.toMatch(/[\\/:*?"<>|\x00-\x1f]/)
      expect(n).not.toMatch(/[. ]$/)
    }
  })
})

describe("patchRoot", () => {
  const base = join("/", "tmp", "card", "Patches")
  test("a path ending in an engine folder gives its parent, in any letter case", () => {
    for (const e of ["ACD", "acd", "Acd", "wtfm", "PHZ"]) expect(patchRoot(join(base, e))).toBe(base)
  })
  test("a trailing separator and a non engine folder", () => {
    expect(patchRoot(join(base, "acd") + "/")).toBe(base)
    expect(patchRoot(base)).toBe(base)
    expect(patchRoot(join(base, "acdx"))).toBe(join(base, "acdx"))
  })
})
