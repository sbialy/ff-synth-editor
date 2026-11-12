// Auto-load of the patch list: choosing an entry loads it at once. The DOM wiring stays in app.js, this is the logic
// (tested in test/loader.test.ts and, in a real browser, test/page.test.ts).
//
//   select(name)  the list changed: ask before replacing unsaved edits, then fetch and apply the patch
//   reload()      load the current entry again (the Reload button), same confirm
//
// - A newer selection wins: arrow-key browsing fires `change` faster than the host answers, an older answer is dropped.
// - Declined confirm or failed load: `revert(name)` puts the list back on the patch that is still loaded.
// - "don't ask again" lives for this page session only (this object).
export function createPatchLoader({ getDirty, ask, fetchPatch, apply, revert, onError }) {
  let current = null // the patch that is loaded (null: none from the list yet)
  let seq = 0
  let quiet = false // user chose "don't ask again this session"

  async function select(name, { force = false } = {}) {
    if (!name) return false
    if (name === current && !force && !getDirty()) return false
    const mine = ++seq
    if (getDirty() && !quiet) {
      const a = await ask(name)
      if (mine !== seq) return false
      if (!a?.ok) { revert(current); return false }
      if (a.dontAsk) quiet = true
    }
    let result
    try {
      result = await fetchPatch(name)
    } catch (e) {
      if (mine === seq) { revert(current); onError?.(e, name) }
      return false
    }
    if (mine !== seq) return false // a newer selection is already on its way
    current = name
    apply(name, result)
    return true
  }

  return {
    select,
    reload: (name) => select(name ?? current, { force: true }),
    /** The loaded patch changed by other means (saved under a name, engine switched, init): forget or set the name. */
    setCurrent(name) { current = name ?? null },
    get current() { return current },
    get quiet() { return quiet },
  }
}
