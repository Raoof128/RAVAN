export type Quality =
  "auto" | "original" | "480p" | "720p" | "1080p" | "1440p" | "2160p";
/**
 * What this client says it can decode, in ffprobe's codec names. `hevc10` is
 * 10-bit HEVC, which also covers HDR10: a capable browser maps it to the screen.
 */
export type ClientCapabilities = {
  video: Array<"h264" | "hevc" | "hevc10" | "av1" | "vp9" | "vp8">;
  audio: Array<"aac" | "mp3" | "ac3" | "eac3" | "flac" | "opus" | "vorbis">;
  containers: Array<"mp4" | "webm" | "matroska">;
};
/**
 * What choosing a picture would do: play a copy that is ready, prepare one in
 * free space, prepare one by removing `films` other films' prepared copies,
 * or nothing, because the space it needs is being watched.
 */
export type PictureChoice = {
  quality: Quality;
  state: "ready" | "fits" | "removes" | "too-large" | "unavailable";
  films?: number;
};
export type PlaybackOptions = {
  quality?: Quality;
  audioTrack?: number;
  forceCompatible?: boolean;
  capabilities?: ClientCapabilities;
};
export const SOURCE_BLOCK_BYTES = 4 * 1024 * 1024;
export type SourceRef = {
  fileId: string;
  generation: string;
  sizeBytes: string;
};
export type RangeDecision =
  | { kind: "full" }
  | { kind: "partial"; start: bigint; end: bigint }
  | { kind: "invalid" }
  | { kind: "unsatisfiable" };
export type DeviceProfile = {
  id: string;
  platform: "web" | "tizen" | "webos";
  verified: boolean;
};
export type PlaybackPlan = {
  mode: "direct" | "prepared" | "prepare" | "unsupported";
  assetId: string;
  reason?: string;
  progress?: number;
  /** Set with mode "prepare": the step the preparation is at. */
  phase?: PreparationPhase;
  label?: string;
  /** The edition is still being prepared and is watched as it grows. */
  live?: boolean;
};
export type PlaybackSession = {
  id: string;
  epoch: number;
  mediaUrl: string;
  expiresAt: string;
  startMs: number;
  label?: string;
  subtitles?: Array<{ url: string; language: string; label: string }>;
};
export type ProgressEvent = {
  sessionId: string;
  epoch: number;
  sequence: number;
  positionMs: number;
  ended: boolean;
};
export type MovieCard = {
  id: string;
  title: string;
  year?: number;
  posterUrl?: string;
  /** The poster is a frame of the film, with no title on it. */
  posterTitled?: boolean;
  /** A wide picture from the film, for backgrounds. */
  stillUrl?: string;
  resumeMs: number;
  available: boolean;
};
/** A folder of the library, shown as one card that opens to its films. */
export type FolderCard = {
  id: string;
  name: string;
  /** Films in the folder and the folders inside it. */
  films: number;
  posterUrl?: string;
  posterTitled?: boolean;
};
/** One page of the library, or of a folder in it. */
export type MovieList = {
  items: MovieCard[];
  nextCursor: string | null;
  /** Set when a folder is browsed. The top of the library has id "root". */
  folder?: {
    id: string;
    name: string;
    /** The folder this one is in: "root" for the top, null at the top itself. */
    parentId: string | null;
    parentName?: string;
  };
  /** The folders inside it, with the first page. */
  folders?: FolderCard[];
  /** Films in progress anywhere in the library, with the top's first page. */
  resume?: MovieCard[];
};
export type PlaybackState =
  "idle" | "loading" | "playing" | "paused" | "ended" | "error";
export interface PlayerAdapter {
  load(session: PlaybackSession): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(positionMs: number): Promise<void>;
  getPositionMs(): number;
  selectAudio(trackId: string): Promise<void>;
  selectSubtitle(trackId: string | null): Promise<void>;
  /** Replace the caption tracks without reloading the picture. */
  setSubtitles?(subtitles: NonNullable<PlaybackSession["subtitles"]>): void;
  /** Audio tracks carried by the stream itself, switchable without reloading. */
  audioOptions?(): TrackOption[];
  subtitleOptions?(): TrackOption[];
  /** Called when either list, or the active choice, changes. */
  onTracks?(listener: () => void): () => void;
  onState(listener: (state: PlaybackState) => void): () => void;
  destroy(): Promise<void>;
}

export type SessionState = {
  authenticated: boolean;
  configured: boolean;
  csrfToken?: string;
  mfa?: "enroll" | "verify";
  challengeExpiresAt?: number;
};
export type LibraryStatus = {
  folderId: string | null;
  state: "idle" | "running" | "succeeded" | "failed";
  counts: { upserts?: number; unavailable?: number };
  error?: string;
};
/** A track the player can switch to, as the player itself reports it. */
export type TrackOption = {
  id: string;
  label: string;
  language: string;
  active: boolean;
};
/**
 * Where an episode stands in its series folder, read from the Drive file
 * names ("Show - S03E01"). Only films named as episodes have one.
 */
export type EpisodeInfo = {
  season?: number;
  episode: number;
  /** Its place among the folder's episodes, counting from 1. */
  index: number;
  count: number;
  folder: { id: string; name: string };
  /** The episode after it in the folder, if there is one in Drive. */
  next?: MovieCard & { season?: number; episode: number };
};
export type MovieDetail = MovieCard & {
  episode?: EpisodeInfo;
  audioTracks?: Array<{ index: number; language: string; label: string }>;
  /**
   * The film's subtitle tracks. Text subtitles are shown in the player once
   * an edition with them is ready; picture-based ones (Blu-ray, DVD) cannot be.
   */
  subtitleTracks?: Array<{ language: string; label: string; text: boolean }>;
  description: string;
  saved: boolean;
  editions: Array<{
    id: string;
    label: string;
    state: string;
    sourceId: string;
    available: boolean;
  }>;
  tracks: Array<{
    id: string;
    kind: string;
    codec: string;
    language: string | null;
  }>;
};
export type Preferences = {
  audioLanguage: string;
  subtitleLanguage: string;
  quality: "original" | "720p" | "1080p";
  reducedMotion: boolean;
  /** When an episode ends, play the next one after a short count. */
  autoplayNext: boolean;
};
/**
 * The step a film is at before it can play. Every value is a state the server
 * holds: a probe job, a queued or running conversion, or a streamed edition
 * that has started but has too little written to play without stopping.
 */
export type PreparationPhase =
  | "inspecting"
  | "queued"
  | "repackaging"
  | "converting"
  | "buffering"
  | "retrying";
export type PlaybackResult =
  | { kind: "ready"; session: PlaybackSession }
  | {
      kind: "preparing";
      jobId: string;
      /** Percent of the film converted so far, as reported by the worker. */
      progress?: number;
      reason?: string;
      /** What the server is doing; absent when it cannot say. */
      phase?: PreparationPhase;
    }
  | { kind: "conflict"; sessionId: string }
  | { kind: "unsupported"; reason: string };
export type Device = { id: string; name: string };
