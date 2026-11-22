/**
 * Season and episode numbers as series files are named: "Show - S03E01",
 * "Show S1 E12", "Show 2x05", "Show - Episode 10", "Show Ep. 3". A name with
 * none of these (a film: "Her (2013)", "Movie.1080p.x264") has no episode.
 * Each pattern must start at a word boundary and end before another digit,
 * so years, resolutions ("1920x1080") and codecs ("x264") never match.
 */
export type EpisodeNumber = { season?: number; episode: number };

const SEASON_EPISODE = /(?:^|[^a-z0-9])s(\d{1,2})[ ._-]*e(\d{1,3})(?!\d)/i;
const CROSS = /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?![\d])/i;
const EPISODE_ONLY = /(?:^|[^a-z0-9])(?:episode|ep)[ ._-]*(\d{1,3})(?!\d)/i;

export function parseEpisode(name: string): EpisodeNumber | undefined {
  const stem = name.replace(/\.[a-z0-9]{2,4}$/i, "");
  const full = SEASON_EPISODE.exec(stem) ?? CROSS.exec(stem);
  if (full) return { season: Number(full[1]), episode: Number(full[2]) };
  const only = EPISODE_ONLY.exec(stem);
  return only ? { episode: Number(only[1]) } : undefined;
}

/** Episode order: season, then episode; a name without a season comes first. */
export function compareEpisodes(
  a: EpisodeNumber & { name: string },
  b: EpisodeNumber & { name: string },
) {
  return (
    (a.season ?? 0) - (b.season ?? 0) ||
    a.episode - b.episode ||
    a.name.localeCompare(b.name, "en", { numeric: true })
  );
}
