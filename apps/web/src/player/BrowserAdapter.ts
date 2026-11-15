import type {
  PlaybackSession,
  PlaybackState,
  PlayerAdapter,
} from "../../../../packages/contracts/src/index.js";
export class BrowserAdapter implements PlayerAdapter {
  private listeners = new Set<(s: PlaybackState) => void>();
  private removers: Array<() => void> = [];
  private loading?: AbortController;
  private hls?: import("hls.js").default;
  private destroyed = false;
  constructor(
    private video: HTMLVideoElement,
    private baseUrl = location.origin,
    private nativeOnly = false,
  ) {
    for (const [event, state] of Object.entries({
      playing: "playing",
      pause: "paused",
      ended: "ended",
      waiting: "loading",
      error: "error",
    })) {
      const fn = () => {
        if (!this.destroyed)
          for (const listener of this.listeners)
            listener(state as PlaybackState);
      };
      video.addEventListener(event, fn);
      this.removers.push(() => video.removeEventListener(event, fn));
    }
    const seeked = () => {
      if (!this.destroyed && this.video.paused)
        for (const listener of this.listeners)
          listener(this.video.ended ? "ended" : "paused");
    };
    video.addEventListener("seeked", seeked);
    this.removers.push(() => video.removeEventListener("seeked", seeked));
  }
  async load(session: PlaybackSession) {
    if (this.destroyed) throw new Error("Player closed");
    this.loading?.abort();
    this.hls?.destroy();
    this.hls = undefined;
    const controller = new AbortController();
    this.loading = controller;
    for (const track of this.video.querySelectorAll("track")) track.remove();
    this.video.crossOrigin = "anonymous";
    for (const caption of session.subtitles ?? []) {
      const captionUrl = new URL(caption.url, this.baseUrl);
      if (
        captionUrl.origin !== new URL(this.baseUrl).origin ||
        !/^\/media\/s\/[A-Za-z0-9_-]+\/subtitle-\d+\.vtt$/.test(
          captionUrl.pathname,
        )
      )
        throw Error("Untrusted caption");
      const track = document.createElement("track");
      track.kind = "subtitles";
      track.label = caption.label;
      track.srclang = caption.language;
      track.src = captionUrl.href;
      this.video.append(track);
    }
    const url = new URL(session.mediaUrl, this.baseUrl);
    if (
      url.origin !== new URL(this.baseUrl).origin ||
      !url.pathname.startsWith("/media/s/")
    )
      throw new Error("Untrusted media origin");
    const ready = new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        this.video.removeEventListener("loadedmetadata", loaded);
        this.video.removeEventListener("error", failed);
        controller.signal.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve();
      };
      const loaded = () => finish(),
        failed = () => finish(new Error("The source could not be played.")),
        cancel = () => finish(new Error("Player closed"));
      const timeout = setTimeout(
        () => finish(new Error("The source took too long to respond.")),
        20000,
      );
      this.video.addEventListener("loadedmetadata", loaded, { once: true });
      this.video.addEventListener("error", failed, { once: true });
      controller.signal.addEventListener("abort", cancel, { once: true });
    });
    // Attach a rejection handler immediately: module loading can finish after an
    // unmount aborts the pending media operation.
    void ready.catch(() => {});
    try {
      if (
        url.pathname.endsWith(".m3u8") &&
        !this.video.canPlayType("application/vnd.apple.mpegurl")
      ) {
        if (this.nativeOnly)
          throw new Error("Native HLS is unavailable on this TV.");
        const { default: Hls } = await import("hls.js");
        if (controller.signal.aborted || this.destroyed)
          throw new Error("Player closed");
        if (!Hls.isSupported())
          throw new Error("HLS playback is unavailable on this browser.");
        this.hls = new Hls({
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          backBufferLength: 30,
        });
        this.hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            controller.abort();
            for (const listener of this.listeners) listener("error");
          }
        });
        this.hls.loadSource(url.href);
        this.hls.attachMedia(this.video);
      } else {
        this.video.src = url.href;
        this.video.load();
      }
      await ready;
      if (controller.signal.aborted || this.destroyed)
        throw new Error("Player closed");
      if (session.startMs > 0) await this.seek(session.startMs);
    } catch (error) {
      controller.abort();
      throw error;
    }
  }
  async play() {
    if (this.destroyed) throw new Error("Player closed");
    await this.video.play();
  }
  pause() {
    if (this.destroyed) return;
    this.video.pause();
  }
  async seek(positionMs: number) {
    if (!Number.isFinite(positionMs) || positionMs < 0)
      throw new Error("Invalid playback position");
    this.video.currentTime = Math.min(
      positionMs / 1000,
      Number.isFinite(this.video.duration)
        ? Math.max(0, this.video.duration - 0.05)
        : positionMs / 1000,
    );
  }
  getPositionMs() {
    const value = this.video.currentTime * 1000;
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  }
  async selectAudio(trackId: string) {
    if (!this.hls)
      throw new Error("Audio selection is unavailable for this original file.");
    const index = Number(trackId);
    if (!Number.isInteger(index) || !this.hls.audioTracks[index])
      throw new Error("Audio track unavailable");
    this.hls.audioTrack = index;
  }
  async selectSubtitle(trackId: string | null) {
    if (this.hls) {
      const index = trackId === null ? -1 : Number(trackId);
      if (
        index !== -1 &&
        (!Number.isInteger(index) || !this.hls.subtitleTracks[index])
      )
        throw new Error("Subtitle track unavailable");
      this.hls.subtitleTrack = index;
      return;
    }
    for (let i = 0; i < this.video.textTracks.length; i++)
      this.video.textTracks[i]!.mode =
        String(i) === trackId ? "showing" : "disabled";
  }
  onState(listener: (state: PlaybackState) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loading?.abort();
    for (const remove of this.removers.splice(0)) remove();
    this.listeners.clear();
    this.hls?.destroy();
    this.hls = undefined;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }
}
