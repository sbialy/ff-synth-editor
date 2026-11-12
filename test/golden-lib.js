// Shared by test/randomize-golden.test.ts, scripts/golden-gen.ts and scripts/verify-golden.mjs (plain JS on purpose: the last one runs
// under node or any other JS engine, so the vectors can be checked on an engine other than bun's).
// A golden case = a list of rolls applied one after the other to the engine's Init patch, the result written as hex: every parameter
// value as the 8 hex digits of its float32 bits ("--------" for a value that is not a number), then "|" and every macro target amount
// the same way (targets of one macro joined, macros joined by ","). Nothing here touches the host: the engine metadata the vectors
// were made on is stored inside the fixture, so the vectors test the ALGORITHM, not the firmware.
import { applyRoll, rollSettings } from "../public/recipe.js"
import { ALGORITHMS } from "../public/randomize.js"
import { formatSeed, fnv1a64, parseSeedCode } from "../public/seed.js"

const dv = new DataView(new ArrayBuffer(4))
export const bits = (v) => {
  if (typeof v !== "number" || !Number.isFinite(v)) return "--------"
  dv.setFloat32(0, v)
  return dv.getUint32(0).toString(16).padStart(8, "0")
}
export const hexOfPatch = (patch) => patch.values.map(bits).join("") + "|" + (patch.macros ?? []).map((m) => m.targets.map((t) => bits(t.amount)).join("")).join(",")

/** The fields of /api/meta that an algorithm reads, so a fixture does not depend on anything else of the host. */
export function relevantMeta(meta) {
  return {
    engineId: meta.engineId,
    volumeParam: meta.volumeParam,
    params: meta.params.map((p) => ({ id: p.id, name: p.name, min: p.min, max: p.max, def: p.def, curve: p.curve, stepped: p.stepped, ...(p.names ? { names: p.names } : {}) })),
    sections: meta.sections.map((s) => ({ name: s.name, params: s.params })),
    macros: meta.macros.map((m) => ({ name: m.name, system: m.system })),
  }
}
export const relevantInit = (meta) => ({ values: meta.init.values, macros: meta.init.macros })

/** Run the steps of a case from `init` (steps: [{ seed (versioned seed code), amount (percent), sections, locks, macros }]). */
export function runCase(meta, init, steps) {
  let patch = structuredClone(init)
  for (const s of steps) {
    const { seed, algo } = parseSeedCode(s.seed)
    if (!(algo in ALGORITHMS)) throw new Error("no such algorithm " + algo)
    patch = applyRoll(meta, patch, rollSettings(meta, { seed, algo, amount: s.amount, sections: s.sections, locks: s.locks, macros: s.macros })).patch
  }
  return patch
}

/** The case list of one engine (names and settings only: the expected hex is what the generator records once, for algorithm 2). */
export function casesFor(meta) {
  const seed = (v) => formatSeed(v, 2)
  const A = seed(1n), B = seed(fnv1a64("poly-editor")), C = seed(0xdeadbeefcafef00dn), D = seed(0xffffffffffffffffn)
  const allowed = meta.params.map((_, i) => i).filter((i) => i !== meta.volumeParam && meta.params[i].max > meta.params[i].min)
  const secs = meta.sections.slice(0, 2).map((s) => s.name)
  const step = (s, amount, o = {}) => ({ seed: s, amount, sections: null, locks: [], macros: false, ...o })
  return [
    { name: "A@100", steps: [step(A, 100)] },
    { name: "A@50", steps: [step(A, 50)] },
    { name: "B@100", steps: [step(B, 100)] },
    { name: "B@17", steps: [step(B, 17)] },
    { name: "C@100+macros", steps: [step(C, 100, { macros: true })] },
    { name: "D@100 locks+sections", steps: [step(D, 100, { locks: allowed.slice(0, 3), sections: secs })] },
    { name: "A@100 then B@35+macros", steps: [step(A, 100), step(B, 35, { macros: true })] },
    { name: "D@5+macros", steps: [step(D, 5, { macros: true })] },
  ]
}
