// The file name a downloaded patch gets (the static Pages build has no patch folder, Save is a browser download). Browsers on Windows rewrite
// or refuse some names on their own, so the page cleans the name first and shows the name it really saved, the same on every system.
// The server has its own stricter rule (safeName in server/index.ts) because it writes into the card folder itself.
export const MAX_NAME = 64
export const FALLBACK_NAME = "Untitled"
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i // Windows device names, also with an extension

/** The name (without ".patch") a patch is saved under: forbidden characters become _, no trailing dots or spaces, no leading dot, at most 64 characters. */
export function saveName(raw, fallback = FALLBACK_NAME) {
  let n = String(raw ?? "").replace(/\.patch$/i, "")
  n = n.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, "_")
  n = n.replace(/^[.\s]+/, "").slice(0, MAX_NAME).replace(/[.\s]+$/, "")
  if (!n) return fallback
  return RESERVED.test(n) ? "_" + n : n
}
