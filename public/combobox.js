// A searchable list for the patch folder of the current engine: type to filter by name, Arrow Up / Down move, Enter picks, Escape closes.
// The page keeps a hidden <select> as the list's model (the loader and the tests work on it), this is the control the user sees.
// Keys: while the field is focused the page's global shortcuts and the note keys do not see them (it is a text field). Picking and closing both let go of the
// focus, so the computer keys play notes again at once.

/**
 * The names that contain every word of `query` (any case), the ones that start with the first word first, else in list order.
 * An empty query keeps the whole list.
 */
export function filterNames(names, query) {
  const terms = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return names.slice()
  const hits = names.filter((n) => { const l = n.toLowerCase(); return terms.every((t) => l.includes(t)) })
  return [...hits.filter((n) => n.toLowerCase().startsWith(terms[0])), ...hits.filter((n) => !n.toLowerCase().startsWith(terms[0]))]
}

export const STARS = 5

/** `names` with at least `min` stars, and by rating (best first, then by name) when `byRating`. The input order is the name order. */
export function rateNames(names, getRating, { min = 0, byRating = false } = {}) {
  const r = (n) => getRating(n) || 0
  const kept = min > 0 ? names.filter((n) => r(n) >= min) : names.slice()
  return byRating ? kept.map((n, i) => [n, i]).sort((a, b) => r(b[0]) - r(a[0]) || a[1] - b[1]).map((x) => x[0]) : kept
}

function starsEl(n) {
  const s = document.createElement("span"); s.className = "rs"; s.title = `${n} of ${STARS}`
  s.setAttribute("aria-label", `${n} of ${STARS} stars`)
  const on = document.createElement("span"); on.textContent = "★".repeat(n)
  const off = document.createElement("span"); off.className = "off"; off.textContent = "★".repeat(STARS - n)
  s.append(on, off)
  return s
}

/**
 * Wires `input` (a text field) and `list` (an empty <ul>) as an ARIA combobox.
 *   getNames()    every name of the folder, sorted
 *   getCurrent()  the name that is loaded (shown in the field while it is closed), or null
 *   getEmpty()    what to say when there are no names at all (optional)
 *   onPick(name)  the user chose a name
 *   getRating(name)  optional, 0 to 5 stars of a name: shown at the end of each entry, and the list gets a filter by minimum rating and a sort by rating
 *   hasRatings()     optional, false while the list has no ratings at all (the default set): no stars, no filter or sort tools. Default true
 *   onSync()         optional, called after every sync() (the page repaints what depends on the loaded patch)
 * Returns { open, close, sync, isOpen }. sync() repaints the closed field after the loaded patch or the list changed.
 */
export function attachCombobox({ input, list, getNames, getCurrent, getEmpty, getRating, hasRatings, onSync, onPick, max = 300 }) {
  let isOpen = false, matches = [], active = -1, query = "", minStars = 0, byRating = false
  input.setAttribute("role", "combobox")
  input.setAttribute("aria-autocomplete", "list")
  input.setAttribute("aria-expanded", "false")
  input.setAttribute("aria-controls", list.id)
  input.autocomplete = "off"; input.spellcheck = false
  list.setAttribute("role", "listbox")
  list.hidden = true

  const rated = () => !!getRating && (hasRatings?.() ?? true)
  const shown = () => getCurrent() ?? ""
  function toolsEl() {
    const li = document.createElement("li"); li.className = "tools"; li.setAttribute("role", "presentation")
    const g = document.createElement("span"); g.className = "rmin"; g.setAttribute("role", "group"); g.setAttribute("aria-label", "Minimum rating")
    for (let n = 1; n <= STARS; n++) {
      const b = document.createElement("button"); b.type = "button"; b.tabIndex = -1; b.dataset.min = String(n); b.textContent = "★"
      b.setAttribute("aria-label", `${n} stars or more`); b.setAttribute("aria-pressed", String(n <= minStars)); b.title = `${n}+`
      if (n <= minStars) b.className = "on"
      g.append(b)
    }
    const s = document.createElement("button"); s.type = "button"; s.tabIndex = -1; s.dataset.sort = "1"; s.className = "rsort" + (byRating ? " on" : "")
    s.textContent = byRating ? "★ first" : "A-Z"; s.setAttribute("aria-pressed", String(byRating)); s.title = "Sort"
    li.append(g, s)
    return li
  }
  function paint() {
    const items = matches.slice(0, max).map((name, i) => {
      const li = document.createElement("li")
      li.setAttribute("role", "option"); li.id = `${list.id}-${i}`; li.dataset.name = name
      const label = document.createElement("span"); label.className = "nm"; label.textContent = name
      li.append(label)
      const stars = rated() ? getRating(name) || 0 : 0
      if (stars) li.append(starsEl(stars))
      li.setAttribute("aria-selected", String(i === active))
      if (i === active) li.className = "active"
      if (name === getCurrent()) li.classList.add("loaded")
      return li
    })
    if (!matches.length) {
      const li = document.createElement("li"); li.className = "none"; li.setAttribute("role", "presentation")
      li.textContent = getNames().length ? "No match" : (getEmpty?.() ?? "No patches")
      items.push(li)
    } else if (matches.length > max) {
      const li = document.createElement("li"); li.className = "none"; li.setAttribute("role", "presentation")
      li.textContent = `${matches.length - max} more, keep typing`
      items.push(li)
    }
    if (rated() && getNames().length) items.unshift(toolsEl())
    list.replaceChildren(...items)
    if (active >= 0) input.setAttribute("aria-activedescendant", `${list.id}-${active}`); else input.removeAttribute("aria-activedescendant")
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" })
  }
  function compute() {
    const named = filterNames(getNames(), query)
    return rated() ? rateNames(named, getRating, { min: minStars, byRating }) : named
  }
  function show(q) {
    query = q
    matches = compute()
    // the loaded patch is the starting point of an unfiltered list, else the best match
    const cur = query ? -1 : matches.indexOf(getCurrent())
    active = matches.length ? Math.max(0, cur) : -1
    isOpen = true; list.hidden = false; input.setAttribute("aria-expanded", "true")
    paint()
  }
  function close() {
    if (isOpen) { isOpen = false; list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); list.replaceChildren() }
    input.value = shown()
  }
  function refilter() { // the rating filter or sort changed: same query, the entry under the cursor stays when it is still there
    const was = matches[active]
    matches = compute()
    active = matches.length ? Math.max(0, matches.indexOf(was)) : -1
    paint()
  }
  function move(by) {
    if (!matches.length) return
    const n = Math.min(matches.length, max) - 1
    active = Math.min(n, Math.max(0, active + by))
    paint()
  }
  function pick(name) {
    close()
    input.blur()
    onPick(name)
  }

  input.addEventListener("focus", () => input.select())
  input.addEventListener("pointerdown", () => { if (!isOpen) show("") })
  input.addEventListener("input", () => show(input.value))
  input.addEventListener("blur", () => close())
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return
    e.stopPropagation() // a text field: no note key, no roll, no undo of the page
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      if (!isOpen) show(""); else move(e.key === "ArrowDown" ? 1 : -1)
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (!isOpen) show("")
      else if (active >= 0) pick(matches[active])
    } else if (e.key === "Escape") {
      e.preventDefault()
      close()
      input.blur()
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault()
      if (isOpen) move(e.key === "PageDown" ? 8 : -8)
    }
  })
  document.addEventListener("pointerdown", (e) => { if (isOpen && e.target !== input && !list.contains(e.target)) close() }, true) // a press anywhere else closes it
  // a pointer on an entry must not take the focus away from the field before the click lands
  for (const type of ["pointerdown", "mousedown"]) list.addEventListener(type, (e) => e.preventDefault())
  list.addEventListener("click", (e) => {
    const min = e.target.closest?.("button[data-min]")
    if (min) { const n = Number(min.dataset.min); minStars = n === minStars ? 0 : n; refilter(); return }
    if (e.target.closest?.("button[data-sort]")) { byRating = !byRating; refilter(); return }
    const li = e.target.closest?.("li[data-name]")
    if (li) pick(li.dataset.name)
  })
  input.value = shown()
  return { open: () => show(""), close, sync() { if (!isOpen) input.value = shown(); onSync?.() }, isOpen: () => isOpen }
}
