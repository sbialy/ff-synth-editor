// Star ratings (0 to 5) for the patches of a folder. They live in ONE sidecar file next to the patches, `ratings.json` in the engine folder,
// keyed by patch file name: {"version":1,"ratings":{"Acid Glide.patch":4}}. The .patch files are never touched (the device format stays as it is).
// A missing or malformed file reads as all unrated and never blocks anything. Entries whose .patch is gone are dropped on the next write.
import { access, constants, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const RATINGS_FILE = "ratings.json"
export const MAX_STARS = 5

export type RatingsFile = { version: 1; ratings: Record<string, number> }

const isStars = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_STARS

/** The ratings of a sidecar text, keyed by patch file name. Anything that is not the expected shape is left out (a bad file gives {}). */
export function parseRatings(text: string): Record<string, number> {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return {} }
  if (!raw || typeof raw !== "object" || (raw as { version?: unknown }).version !== 1) return {}
  const r = (raw as { ratings?: unknown }).ratings
  if (!r || typeof r !== "object" || Array.isArray(r)) return {}
  const out: Record<string, number> = {}
  for (const [file, v] of Object.entries(r)) if (file.toLowerCase().endsWith(".patch") && isStars(v)) out[file] = v
  return out
}

async function readSidecar(folder: string): Promise<Record<string, number>> {
  try { return parseRatings(await readFile(join(folder, RATINGS_FILE), "utf8")) } catch { return {} }
}

/** A folder takes ratings when the sidecar can be written there (a read-only card, a locked folder: shown, not changed). */
export async function folderWritable(folder: string): Promise<boolean> {
  try { await access(folder, constants.W_OK); return true } catch { return false }
}

/** The ratings of a folder by patch name (no .patch), only for patches that are there, plus whether they can be changed. */
export async function readRatings(folder: string): Promise<{ ratings: Record<string, number>; readOnly: boolean }> {
  const [stored, names] = await Promise.all([readSidecar(folder), readdir(folder).catch(() => [] as string[])])
  const have = new Set(names)
  const ratings: Record<string, number> = {}
  for (const [file, v] of Object.entries(stored)) if (have.has(file)) ratings[file.slice(0, -6)] = v
  return { ratings, readOnly: !(await folderWritable(folder)) }
}

export class RatingError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

let queue: Promise<unknown> = Promise.resolve() // writes one after the other, so two quick clicks cannot lose each other's change

/**
 * Sets the rating of `name` (0 clears it) and writes the sidecar atomically (temp file, then rename). Entries for patches that no longer exist are
 * dropped with this write. Throws RatingError 404 for a patch that is not in the folder and 403 for a folder that cannot be written.
 */
export function writeRating(folder: string, name: string, stars: number): Promise<Record<string, number>> {
  const run = async () => {
    if (!Number.isInteger(stars) || stars < 0 || stars > MAX_STARS) throw new RatingError(400, `stars must be a whole number 0 to ${MAX_STARS}`)
    const file = name + ".patch"
    const names = await readdir(folder).catch(() => [] as string[])
    if (!names.includes(file)) throw new RatingError(404, "no such patch in the folder")
    if (!(await folderWritable(folder))) throw new RatingError(403, "this folder is read-only")
    const have = new Set(names)
    const next: Record<string, number> = {}
    for (const [f, v] of Object.entries(await readSidecar(folder))) if (have.has(f) && f !== file) next[f] = v
    if (stars > 0) next[file] = stars
    const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)))
    const out = () => Object.fromEntries(Object.entries(sorted).map(([f, v]) => [f.slice(0, -6), v]))
    if (!stars && !names.includes(RATINGS_FILE) && !Object.keys(sorted).length) return out() // clearing what was never rated: no file for that
    const tmp = join(folder, `.${RATINGS_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
    try {
      await writeFile(tmp, JSON.stringify({ version: 1, ratings: sorted } satisfies RatingsFile, null, 1) + "\n")
      await rename(tmp, join(folder, RATINGS_FILE))
    } catch (e) {
      await rm(tmp, { force: true })
      throw e
    }
    return out()
  }
  const p = queue.then(run, run)
  queue = p.catch(() => {})
  return p
}
