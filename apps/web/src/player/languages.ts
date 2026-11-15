import type { TrackOption } from "../../../../packages/contracts/src/index.js";
const names = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" });
  } catch {
    return undefined;
  }
})();
/** "fa", "fas" and "per" are all Persian: compare languages by name. */
function key(code: unknown) {
  if (typeof code !== "string") return "";
  const plain = code.trim().toLowerCase();
  if (!plain || plain === "und" || plain === "off" || plain === "original")
    return "";
  try {
    return (names?.of(plain) ?? plain).toLowerCase();
  } catch {
    return plain;
  }
}
export function sameLanguage(a: unknown, b: unknown) {
  const left = key(a);
  return left !== "" && left === key(b);
}
/**
 * The track to show for a saved preference: one in that language, preferring a
 * full track over one marked "forced" or "SDH" only when both exist.
 */
export function preferredTrack(options: TrackOption[], language: unknown) {
  const matching = options.filter((o) => sameLanguage(o.language, language));
  return (
    matching.find((o) => !/forced|sdh|commentary/i.test(o.label)) ?? matching[0]
  );
}
