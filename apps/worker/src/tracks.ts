/**
 * Names for a film's audio and subtitle tracks, in words a viewer reads, from
 * the film's own metadata. Shared by the worker (which writes them into an
 * edition) and the API (which lists them on the film's page).
 */
const names = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" });
  } catch {
    return undefined;
  }
})();
/** "fas" becomes "Persian"; a title the film gives its track is kept. */
export function trackName(
  track: { language?: string; title?: string },
  position: number,
) {
  const clean = (text: string) =>
    text
      .normalize("NFC")
      .replace(/[^\p{L}\p{M}\p{N} .,()'&+-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  // Cut by characters, not UTF-16 units, so no half of a pair is left.
  const short = (text: string) => Array.from(text).slice(0, 48).join("").trim();
  const title = track.title ? short(clean(track.title)) : "";
  if (title) return title;
  const code = track.language && track.language !== "und" ? track.language : "";
  let language = "";
  try {
    language = code ? short(clean(names?.of(code) ?? "")) : "";
  } catch {
    language = "";
  }
  return language && language.toLowerCase() !== code.toLowerCase()
    ? language
    : `Audio ${position + 1}`;
}
// Both the catalogue and HLS writer accept the same bounded, plain tags.
// A film may give both a script and region (for example "zh-Hant-TW").
export const safeTrackLanguage =
  /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}|-[A-Za-z]{4}-(?:[A-Za-z]{2}|[0-9]{3}))?$/;
/** A language code the player can use, or "und". */
export function trackLanguage(language?: string) {
  return language && safeTrackLanguage.test(language) ? language : "und";
}
const channelNames: Record<number, string> = {
  1: "mono",
  2: "stereo",
  6: "5.1",
  8: "7.1",
};
/** "Persian · 5.1": a track's name, and its channels when there are more than two. */
export function audioLabel(
  track: { language?: string; title?: string; channels?: number },
  position: number,
) {
  const name = trackName(track, position);
  const channels = track.channels ?? 2;
  return channels > 2
    ? `${name} · ${channelNames[channels] ?? `${channels} channels`}`
    : name;
}
