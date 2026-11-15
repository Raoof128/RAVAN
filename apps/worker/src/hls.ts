import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A prepared edition written as HLS: a playlist, one initialization segment and
 * numbered media segments. Unlike a single MP4, it can be played from the first
 * segments while FFmpeg is still producing the rest.
 */
export const HLS_PLAYLIST = "index.m3u8";
export const HLS_INIT = "init.mp4";
export const HLS_SEGMENT = /^seg-\d{5}\.m4s$/;
export const HLS_FILE = /^(index\.m3u8|init\.mp4|seg-\d{5}\.m4s)$/;
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
  /^#EXT-X-MAP:URI="init\.mp4"$/,
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
export function parsePlaylist(input: string): Playlist {
  if (input.length > 2 * 1024 * 1024) throw new Error("Playlist too large");
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
    else if (line.startsWith("#")) {
      if (!tags.some((tag) => tag.test(line)))
        throw new Error("Unexpected playlist tag");
      mapped ||= line.startsWith("#EXT-X-MAP");
    } else {
      if (!HLS_SEGMENT.test(line) || pending === undefined || !mapped)
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

export async function readPlaylist(
  directory: string,
): Promise<Playlist | undefined> {
  let text: string;
  try {
    text = await readFile(join(directory, HLS_PLAYLIST), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  return parsePlaylist(text);
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

/** A finished edition: complete playlist, and every file it names present. */
export async function validateEdition(directory: string): Promise<Playlist> {
  const playlist = await readPlaylist(directory);
  if (!playlist?.ended || !playlist.segments.length)
    throw new Error("Incomplete playlist");
  for (const file of [HLS_INIT, ...playlist.segments.map((s) => s.file)]) {
    const info = await lstat(join(directory, file));
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0)
      throw new Error("Missing media segment");
  }
  return playlist;
}
