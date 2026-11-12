// The bundled default patches (public/defaults/index.json): the list the page shows while no patch folder is set. They are plain static files,
// so the same URLs work on the server and in a static build (GitHub Pages) with no API. The URLs are relative to the page, never to the site root.
export const DEFAULTS_BASE = "defaults/"

/** The names of one engine in a manifest, or [] (a manifest of another shape reads as empty). */
export function defaultNames(manifest, engine) {
  const names = manifest?.version === 1 ? manifest.engines?.[engine] : null
  return Array.isArray(names) ? names.filter((n) => typeof n === "string") : []
}

/** The URL of a bundled .patch file. */
export const defaultPatchUrl = (engine, name, base = DEFAULTS_BASE) => `${base}${encodeURIComponent(engine)}/${encodeURIComponent(name)}.patch`

/** Fetches the manifest. A missing or broken one gives null, never an error: the page then shows an empty list. */
export async function fetchManifest(fetchFn = fetch, base = DEFAULTS_BASE) {
  try {
    const r = await fetchFn(base + "index.json")
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}
