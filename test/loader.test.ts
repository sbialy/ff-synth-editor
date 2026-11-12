// Auto-load of the patch list (public/loader.js): load on selection, confirm before dropping edits, newest selection wins.
import { describe, expect, test } from "bun:test"
// @ts-ignore plain browser module
import { createPatchLoader } from "../public/loader.js"

function rig(opts: { dirty?: boolean; answers?: { ok: boolean; dontAsk?: boolean }[]; delay?: (name: string) => number } = {}) {
  const log: string[] = []
  const state = { dirty: opts.dirty ?? false, list: "A", asked: 0 }
  const answers = [...(opts.answers ?? [])]
  const loader = createPatchLoader({
    getDirty: () => state.dirty,
    ask: async (name: string) => { state.asked++; log.push("ask " + name); return answers.shift() ?? { ok: true } },
    fetchPatch: async (name: string) => { await new Promise((r) => setTimeout(r, opts.delay?.(name) ?? 0)); if (name === "bad") throw new Error("boom"); return { name } },
    apply: (name: string) => { state.dirty = false; log.push("apply " + name) },
    revert: (name: string | null) => { log.push("revert " + name); if (name) state.list = name },
    onError: (e: Error, name: string) => log.push(`error ${name} ${e.message}`),
  })
  return { loader, log, state }
}

describe("patch loader", () => {
  test("choosing a patch loads it at once, with no Load button", async () => {
    const { loader, log } = rig()
    expect(await loader.select("A")).toBe(true)
    expect(log).toEqual(["apply A"])
    expect(loader.current).toBe("A")
  })

  test("the same entry again does nothing, Reload loads it again", async () => {
    const { loader, log } = rig()
    await loader.select("A")
    expect(await loader.select("A")).toBe(false)
    expect(await loader.reload()).toBe(true)
    expect(log).toEqual(["apply A", "apply A"])
  })

  test("browsing with the arrow keys: every entry loads in turn, the last wins when answers come late", async () => {
    const { loader, log } = rig({ delay: (n) => (n === "B" ? 40 : 5) })
    const all = [loader.select("A"), loader.select("B"), loader.select("C")]
    await Promise.all(all)
    expect(log).toEqual(["apply C"]) // B answered after C was already chosen and was dropped, A likewise
    expect(loader.current).toBe("C")
  })

  test("unsaved edits: one confirm, declining keeps the old patch, the list goes back to it", async () => {
    const { loader, log, state } = rig({ answers: [{ ok: false }] })
    await loader.select("A")
    state.dirty = true
    expect(await loader.select("B")).toBe(false)
    expect(log).toEqual(["apply A", "ask B", "revert A"])
    expect(state.list).toBe("A")
    expect(state.dirty).toBe(true) // the edits are still there
    expect(loader.current).toBe("A")
  })

  test("accepting replaces the patch", async () => {
    const { loader, log, state } = rig({ answers: [{ ok: true }] })
    await loader.select("A")
    state.dirty = true
    expect(await loader.select("B")).toBe(true)
    expect(log).toEqual(["apply A", "ask B", "apply B"])
    expect(state.dirty).toBe(false)
  })

  test("'don't ask again' holds for the rest of the session, a later edit replaces without a question", async () => {
    const { loader, log, state } = rig({ answers: [{ ok: true, dontAsk: true }] })
    await loader.select("A")
    state.dirty = true
    await loader.select("B")
    state.dirty = true
    await loader.select("C")
    expect(state.asked).toBe(1)
    expect(loader.quiet).toBe(true)
    expect(log).toEqual(["apply A", "ask B", "apply B", "apply C"])
    // declining never sets it
    const r = rig({ answers: [{ ok: false, dontAsk: true }, { ok: true }] })
    await r.loader.select("A"); r.state.dirty = true
    await r.loader.select("B")
    expect(r.loader.quiet).toBe(false)
    await r.loader.select("C")
    expect(r.state.asked).toBe(2)
  })

  test("a failed load reverts the list and reports, the old patch stays", async () => {
    const { loader, log } = rig()
    await loader.select("A")
    expect(await loader.select("bad")).toBe(false)
    expect(log).toEqual(["apply A", "revert A", "error bad boom"])
    expect(loader.current).toBe("A")
  })

  test("Reload with edits asks too", async () => {
    const { loader, state } = rig({ answers: [{ ok: false }] })
    await loader.select("A")
    state.dirty = true
    expect(await loader.reload()).toBe(false)
    expect(state.asked).toBe(1)
  })

  test("setCurrent after a save or an engine switch", async () => {
    const { loader } = rig()
    await loader.select("A")
    loader.setCurrent(null)
    expect(await loader.select("A")).toBe(true)
  })
})
