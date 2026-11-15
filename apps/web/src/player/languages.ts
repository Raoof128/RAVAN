import type { TrackOption } from "../../../../packages/contracts/src/index.js";
import { sameLanguage } from "../../../../packages/contracts/src/languages.js";
const names = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" });
  } catch {
    return undefined;
  }
})();
// "fa", "fas" and "per" are all Persian. The server plans by the same rule.
export { sameLanguage };
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
/** "cze" → "Czech"; undefined for "und" or anything not a language. */
export function languageName(code: unknown) {
  if (typeof code !== "string") return undefined;
  const plain = code.trim();
  if (!plain || /^(und|zxx|mis|mul)$/i.test(plain)) return undefined;
  try {
    const name = names?.of(plain);
    return name && name.toLowerCase() !== plain.toLowerCase()
      ? name
      : undefined;
  } catch {
    return undefined;
  }
}
