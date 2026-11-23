import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { safeTrackLanguage } from "./tracks.js";

/**
 * A prepared edition written as HLS: a playlist, one initialization segment and
 * numbered media segments. Unlike a single MP4, it can be played from the first
 * segments while FFmpeg is still producing the rest.
 */
export const HLS_PLAYLIST = "index.m3u8";
export const HLS_INIT = "init.mp4";
export const HLS_SEGMENT = /^seg-\d{5}\.m4s$/;
/**
 * Every file name an edition may have. A film with several audio tracks is
 * written as one picture stream (video.m3u8, v-*) and one stream per track
 * (audio-N.m3u8, aN-*), joined by a top-level index.m3u8, so the player can
 * change language without the film being prepared again.
 */
export const HLS_FILE =
  /^(index\.m3u8|init\.mp4|seg-\d{5}\.m4s|video\.m3u8|v-init\.mp4|v-seg-\d{5}\.m4s|audio-\d{1,2}\.m3u8|a\d{1,2}-init\.mp4|a\d{1,2}-seg-\d{5}\.m4s)$/;
/** Most audio tracks one edition carries. */
export const HLS_MAX_AUDIO = 16;
/** The file-name prefix of a media playlist's own init and segments. */
export function playlistPrefix(name: string): string | undefined {
  if (name === HLS_PLAYLIST) return "";
  if (name === "video.m3u8") return "v-";
  const audio = /^audio-(\d{1,2})\.m3u8$/.exec(name);
  return audio ? `a${Number(audio[1])}-` : undefined;
}
/** Seconds of media per segment, and so the granularity of early playback. */
export const HLS_SEGMENT_SECONDS = 6;
/** Segments that must exist before playback is offered at all. */
export const HLS_PLAYABLE_SEGMENTS = 3;

const tags = [
  /^#EXTM3U$/,
  /^#EXT-X-VERSION:\d{1,2}$/,
  /^#EXT-X-TARGETDURATION:\d{1,4}$/,
  /^#EXT-X-MEDIA-SEQUENCE:0$/,
  /^#EXT-X-PLAYLIST-TYPE:(EVENT|VOD)$/,
  /^#EXT-X-INDEPENDENT-SEGMENTS$/,
  /^#EXT-X-DISCONTINUITY$/,
];
export type Playlist = {
  /** Exactly the lines that passed, ready to serve. */
  text: string;
  segments: Array<{ file: string; seconds: number }>;
  seconds: number;
  ended: boolean;
};

/**
 * Accept only the playlist this server's own FFmpeg command writes: known tags,
 * the fixed initialization segment, and numbered local segments. The playlist
 * is derived from untrusted media, and a player follows every URI in it, so
 * nothing else is ever served.
 */
export function parsePlaylist(input: string, prefix = ""): Playlist {
  if (!/^(|v-|a\d{1,2}-)$/.test(prefix)) throw new Error("Unknown playlist");
  if (input.length > 2 * 1024 * 1024) throw new Error("Playlist too large");
  const map = `#EXT-X-MAP:URI="${prefix}init.mp4"`;
  const lines = input.split(/\r?\n/).filter((line) => line !== "");
  if (lines[0] !== "#EXTM3U") throw new Error("Not a playlist");
  const segments: Playlist["segments"] = [];
  let pending: number | undefined,
    ended = false,
    mapped = false;
  for (const line of lines) {
    if (ended) throw new Error("Content after the end of the playlist");
    const duration = /^#EXTINF:(\d{1,5}(?:\.\d{1,9})?),$/.exec(line);
    if (duration) {
      if (pending !== undefined) throw new Error("Segment without a file");
      pending = Number(duration[1]);
    } else if (line === "#EXT-X-ENDLIST") ended = true;
    else if (line === map) mapped = true;
    else if (line.startsWith("#")) {
      if (!tags.some((tag) => tag.test(line)))
        throw new Error("Unexpected playlist tag");
    } else {
      if (
        !line.startsWith(prefix) ||
        !HLS_SEGMENT.test(line.slice(prefix.length)) ||
        pending === undefined ||
        !mapped
      )
        throw new Error("Unexpected playlist entry");
      segments.push({ file: line, seconds: pending });
      pending = undefined;
    }
  }
  if (pending !== undefined) throw new Error("Segment without a file");
  return {
    text: lines.join("\n") + "\n",
    segments,
    seconds: segments.reduce((total, s) => total + s.seconds, 0),
    ended,
  };
}

export type AudioRendition = {
  /** Shown in the player's audio menu. */
  name: string;
  /** A language code from the source, or "und". */
  language: string;
  default: boolean;
};
// Names come from the film's own metadata: letters, digits and a little
// punctuation only, so they cannot break out of the quoted attribute.
const safeName = /^[\p{L}\p{M}\p{N} .,()'&+-]{1,48}$/u;
const master = {
  head: ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"],
  media:
    /^#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="([^"]+)",LANGUAGE="([^"]+)",DEFAULT=(YES|NO),AUTOSELECT=YES,URI="audio-(\d{1,2})\.m3u8"$/,
  stream: /^#EXT-X-STREAM-INF:BANDWIDTH=\d{1,10},AUDIO="audio"$/,
};
/** The top-level playlist of an edition with several audio tracks. */
export function writeMaster(
  renditions: AudioRendition[],
  bandwidth: number,
): string {
  if (!renditions.length || renditions.length > HLS_MAX_AUDIO)
    throw new Error("Unsupported audio layout");
  const lines = [
    ...master.head,
    ...renditions.map((r, i) => {
      if (!safeName.test(r.name) || !safeTrackLanguage.test(r.language))
        throw new Error("Unsafe audio label");
      return `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${r.name}",LANGUAGE="${r.language}",DEFAULT=${r.default ? "YES" : "NO"},AUTOSELECT=YES,URI="audio-${i}.m3u8"`;
    }),
    `#EXT-X-STREAM-INF:BANDWIDTH=${Math.max(1, Math.min(9_999_999_999, Math.round(bandwidth)))},AUDIO="audio"`,
    "video.m3u8",
  ];
  return parseMaster(lines.join("\n") + "\n").text;
}
/** Accept only the top-level playlist writeMaster produces. */
export function parseMaster(input: string): {
  text: string;
  renditions: AudioRendition[];
} {
  if (input.length > 64 * 1024) throw new Error("Playlist too large");
  const lines = input.split(/\r?\n/).filter((line) => line !== "");
  const head = lines.slice(0, master.head.length);
  if (head.join("\n") !== master.head.join("\n"))
    throw new Error("Not a top-level playlist");
  const rest = lines.slice(master.head.length);
  const renditions: AudioRendition[] = [];
  while (rest.length && rest[0]!.startsWith("#EXT-X-MEDIA:")) {
    const m = master.media.exec(rest.shift()!);
    if (
      !m ||
      Number(m[4]) !== renditions.length ||
      !safeName.test(m[1]!) ||
      !safeTrackLanguage.test(m[2]!)
    )
      throw new Error("Unexpected audio rendition");
    renditions.push({ name: m[1]!, language: m[2]!, default: m[3] === "YES" });
  }
  if (
    !renditions.length ||
    renditions.length > HLS_MAX_AUDIO ||
    renditions.filter((r) => r.default).length !== 1 ||
    rest.length !== 2 ||
    !master.stream.test(rest[0]!) ||
    rest[1] !== "video.m3u8"
  )
    throw new Error("Unexpected top-level playlist");
  return { text: lines.join("\n") + "\n", renditions };
}
/** Pass on any playlist of an edition in the strict form this server writes. */
export function servePlaylist(name: string, input: string): string {
  const prefix = playlistPrefix(name);
  if (prefix === undefined) throw new Error("Unknown playlist");
  if (name === HLS_PLAYLIST && input.includes("#EXT-X-STREAM-INF"))
    return parseMaster(input).text;
  return parsePlaylist(input, prefix).text;
}
async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
export async function readPlaylist(
  directory: string,
  name = HLS_PLAYLIST,
): Promise<Playlist | undefined> {
  const text = await readText(join(directory, name));
  if (text === undefined) return;
  const prefix = playlistPrefix(name);
  if (prefix === undefined) throw new Error("Unknown playlist");
  return parsePlaylist(text, prefix);
}
/**
 * The media playlists of an edition in either layout, each with the prefix of
 * its own files. Missing playlists (not written yet) are undefined.
 */
export async function readLayout(directory: string): Promise<
  | {
      renditions?: AudioRendition[];
      media: Array<{ prefix: string; playlist?: Playlist }>;
    }
  | undefined
> {
  const top = await readText(join(directory, HLS_PLAYLIST));
  if (top === undefined) return;
  if (!top.includes("#EXT-X-STREAM-INF"))
    return { media: [{ prefix: "", playlist: parsePlaylist(top) }] };
  const { renditions } = parseMaster(top);
  const names = ["video.m3u8", ...renditions.map((_, i) => `audio-${i}.m3u8`)];
  return {
    renditions,
    media: await Promise.all(
      names.map(async (name) => ({
        prefix: playlistPrefix(name)!,
        playlist: await readPlaylist(directory, name),
      })),
    ),
  };
}
/** Enough of every stream exists to start watching without stopping. */
export async function playableNow(directory: string): Promise<boolean> {
  const layout = await readLayout(directory);
  return Boolean(
    layout?.media.every(
      ({ playlist }) =>
        playlist &&
        (playlist.ended || playlist.segments.length >= HLS_PLAYABLE_SEGMENTS),
    ),
  );
}

/** Bytes used by an edition's directory. */
export async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(directory)) {
    try {
      total += (await lstat(join(directory, name))).size;
    } catch (error) {
      // FFmpeg renames temporary files as it goes.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return total;
}

/**
 * A finished edition: every playlist complete, every file it names present,
 * and all streams the same length to within a segment. Returns the picture's.
 */
export async function validateEdition(directory: string): Promise<Playlist> {
  const layout = await readLayout(directory);
  if (!layout) throw new Error("Incomplete playlist");
  for (const { prefix, playlist } of layout.media) {
    if (!playlist?.ended || !playlist.segments.length)
      throw new Error("Incomplete playlist");
    for (const file of [
      `${prefix}${HLS_INIT}`,
      ...playlist.segments.map((s) => s.file),
    ]) {
      const info = await lstat(join(directory, file));
      if (!info.isFile() || info.isSymbolicLink() || info.size === 0)
        throw new Error("Missing media segment");
    }
  }
  const picture = layout.media[0]!.playlist!;
  if (
    layout.media.some(
      ({ playlist }) =>
        Math.abs(playlist!.seconds - picture.seconds) > HLS_SEGMENT_SECONDS,
    )
  )
    throw new Error("Streams differ in length");
  return picture;
}
