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
export type PlaybackOptions = {
  quality?: Quality;
  audioTrack?: number;
  forceCompatible?: boolean;
  capabilities?: ClientCapabilities;
};
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
  resumeMs: number;
  available: boolean;
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
export type MovieDetail = MovieCard & {
  audioTracks?: Array<{ index: number; language: string; label: string }>;
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
};
export type PlaybackResult =
  | { kind: "ready"; session: PlaybackSession }
  | { kind: "preparing"; jobId: string; progress?: number; reason?: string }
  | { kind: "conflict"; sessionId: string }
  | { kind: "unsupported"; reason: string };
export type Device = { id: string; name: string };
