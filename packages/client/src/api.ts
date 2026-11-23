import { ReadingRanges } from "./reading-ranges.js";
import { createContext, useContext } from "react";
import {
  MAX_READING_BYTES,
  type ReadingItem,
  type ReadingList,
  type ReadingPreparation,
  type ReadingPosition,
} from "../../contracts/src/reading.js";
import type {
  MovieList,
  MovieDetail,
  PictureChoice,
  SessionState,
  LibraryStatus,
  Preferences,
  Device,
  PlaybackResult,
  PlaybackSession,
  ProgressEvent,
  PlaybackOptions,
} from "../../contracts/src/index.js";
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export function createApiClient(baseUrl: string) {
  let csrf: string | undefined;
  let credential: string | undefined;
  // Chromium before 81 (an LG C1 runs 79) refuses, unsent, a keepalive
  // request that needs a preflight: a JSON body or the CSRF header.
  let keepaliveRefused = false;
  async function request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    accepted: number[] = [],
    keepalive = false,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const send = (alive: boolean) =>
      fetch(`${baseUrl}${path}`, {
        method,
        credentials: "same-origin",
        keepalive: alive,
        signal: controller.signal,
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
          ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    try {
      let response: Response;
      if (keepalive && !keepaliveRefused) {
        try {
          response = await send(true);
        } catch (error) {
          if (!(error instanceof TypeError) || controller.signal.aborted)
            throw error;
          // Only idempotent saves ask for keepalive, so sending again is safe.
          // If the plain request goes through, keepalive was the refusal (not
          // the network), so later saves skip it.
          response = await send(false);
          keepaliveRefused = true;
        }
      } else response = await send(false);
      if (response.status === 204) return undefined as T;
      let data: T & { error?: string };
      try {
        data = (await response.json()) as T & { error?: string };
      } catch {
        // A proxy error page is not JSON. Report the status, not a parse failure.
        throw new ApiError(response.status, "request_failed");
      }
      if (!response.ok && !accepted.includes(response.status))
        throw new ApiError(response.status, data.error ?? "request_failed");
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    reading(q = "", offset = 0, folder?: string) {
      return request<ReadingList>(
        `/api/reading?${new URLSearchParams({ q, offset: String(offset), ...(folder ? { folder } : {}) })}`,
      );
    },
    readingPreparation(item: ReadingItem, enqueue = false) {
      return request<ReadingPreparation>(
        `/api/reading/${encodeURIComponent(item.id)}/preparation?generation=${encodeURIComponent(item.generation)}`,
        enqueue ? "POST" : "GET",
      );
    },
    readingRanges(item: ReadingItem, signal: AbortSignal) {
      return new ReadingRanges(
        Number(item.sizeBytes),
        `${baseUrl}/api/reading/${encodeURIComponent(item.id)}/content?generation=${encodeURIComponent(item.generation)}`,
        signal,
      );
    },
    saveReading(item: ReadingItem, position: ReadingPosition) {
      return request<void>(
        `/api/reading/${encodeURIComponent(item.id)}/progress`,
        "PUT",
        { generation: item.generation, ...position },
        [],
        true,
      );
    },
    async readingFile(item: ReadingItem, signal: AbortSignal): Promise<Blob> {
      const response = await fetch(
        `${baseUrl}/api/reading/${encodeURIComponent(item.id)}/content?generation=${encodeURIComponent(item.generation)}`,
        {
          credentials: "same-origin",
          signal,
          headers: credential ? { Authorization: `Bearer ${credential}` } : {},
        },
      );
      if (!response.ok)
        throw new ApiError(response.status, "reading_unavailable");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Empty book");
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_READING_BYTES) throw new Error("Book too large");
          chunks.push(new Uint8Array(chunk.value));
        }
      } finally {
        await reader.cancel();
      }
      if (String(size) !== item.sizeBytes) throw new Error("Incomplete book");
      return new Blob(chunks);
    },
    setDeviceCredential(value: string | undefined) {
      credential = value;
    },
    async session() {
      const value = await request<SessionState>("/api/session");
      csrf = value.csrfToken;
      return value;
    },
    enrollMfa() {
      return request<{ secret: string; uri: string }>(
        "/auth/mfa/enroll",
        "POST",
        {},
      );
    },
    verifyMfa(code: string, recovery = false) {
      return request<{
        authenticated?: boolean;
        recoveryRequired?: boolean;
        recoveryCodes?: string[];
      }>("/auth/mfa/verify", "POST", { code, recovery });
    },
    cancelMfa() {
      return request<void>("/auth/mfa/cancel", "POST", {});
    },
    /** `folder` browses one folder ("root" is the top); without it, the whole library. */
    listMovies(cursor?: string, q = "", saved = false, folder?: string) {
      const params = new URLSearchParams({
        q,
        ...(cursor ? { cursor } : {}),
        ...(saved ? { saved: "true" } : {}),
        ...(folder ? { folder } : {}),
      });
      return request<MovieList>(`/api/movies?${params}`);
    },
    /** A picture from /api/artwork, fetched with this client's credential. */
    async artwork(url: string, signal?: AbortSignal): Promise<Blob> {
      if (!/^\/api\/artwork\/[a-f0-9]{32}$/.test(url))
        throw new ApiError(400, "invalid_artwork");
      const response = await fetch(`${baseUrl}${url}`, {
        credentials: "same-origin",
        signal,
        headers: credential ? { Authorization: `Bearer ${credential}` } : {},
      });
      if (!response.ok)
        throw new ApiError(response.status, "artwork_unavailable");
      const type = response.headers.get("content-type") ?? "";
      if (!/^image\/(jpeg|png)$/.test(type))
        throw new ApiError(415, "artwork_unavailable");
      return response.blob();
    },
    /** Credits owed to picture sources, such as TMDB when it is enabled. */
    artworkCredits() {
      return request<{ tmdb?: string }>("/api/artwork-credits");
    },
    detail(id: string) {
      return request<MovieDetail>(`/api/movies/${encodeURIComponent(id)}`);
    },
    /** What choosing each picture would do to the prepared films (owner only). */
    pictures(id: string) {
      return request<{ items: PictureChoice[] }>(
        `/api/movies/${encodeURIComponent(id)}/pictures`,
      );
    },
    library() {
      return request<LibraryStatus>("/api/library");
    },
    setFolder(folderId: string) {
      return request<{ scanId: string }>("/api/library", "POST", { folderId });
    },
    sync() {
      return request<{ scanId: string }>("/api/library/sync", "POST", {});
    },
    preferences() {
      return request<Preferences>("/api/preferences");
    },
    savePreferences(value: Preferences) {
      return request<Preferences>("/api/preferences", "PUT", value);
    },
    devices() {
      return request<Device[]>("/api/devices");
    },
    revokeDevice(id: string) {
      return request<void>(`/api/devices/${encodeURIComponent(id)}`, "DELETE");
    },
    saveMovie(id: string, saved: boolean) {
      return request<void>(`/api/watchlist/${encodeURIComponent(id)}`, "PUT", {
        saved,
      });
    },
    editMovie(
      id: string,
      value: { title: string; description: string; year?: number },
    ) {
      return request<MovieDetail>(
        `/api/movies/${encodeURIComponent(id)}`,
        "PATCH",
        value,
      );
    },
    logout() {
      return request<void>("/api/logout", "POST", {});
    },
    playback(
      movieId: string,
      profileId: string,
      startMs: number,
      replaceSessionId?: string,
      options: PlaybackOptions = {},
    ) {
      return request<PlaybackResult>(
        "/api/playback",
        "POST",
        {
          movieId,
          profileId,
          startMs,
          ...options,
          ...(replaceSessionId ? { replaceSessionId } : {}),
        },
        [202, 409, 422],
      );
    },
    heartbeat(id: string) {
      return request<PlaybackSession>(
        `/api/playback/${encodeURIComponent(id)}/heartbeat`,
        "POST",
        {},
      );
    },
    progress(event: ProgressEvent) {
      return request<{ status: "accepted" | "stale" }>(
        "/api/progress",
        "POST",
        event,
      );
    },
    stop(id: string) {
      return request<void>(`/api/playback/${encodeURIComponent(id)}`, "DELETE");
    },
    /** A paired screen gives up its own credential. */
    forgetDevice() {
      return request<void>("/api/pairing/forget", "POST", {});
    },
    approvePairing(code: string, watchlistWrite = false, reading = false) {
      return request<void>("/api/pairing/approve", "POST", {
        code,
        ...(watchlistWrite ? { watchlistWrite } : {}),
        ...(reading ? { reading } : {}),
      });
    },
  };
}
export type ApiClient = ReturnType<typeof createApiClient>;
export const ApiContext = createContext<ApiClient | null>(null);
export function useApi() {
  const api = useContext(ApiContext);
  if (!api) throw new Error("API provider missing");
  return api;
}
