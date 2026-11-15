import type { ApiClient } from "../../../../packages/client/src/api.js";
import type {
  PlaybackSession,
  PlayerAdapter,
  PlaybackState,
  PlaybackResult,
  PlaybackOptions,
} from "../../../../packages/contracts/src/index.js";
export type ControllerState =
  | PlaybackResult
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "paused" };
export class PlayerController {
  private session?: PlaybackSession;
  private sequence = 0;
  private timer?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  private destroyed = false;
  private remove: () => void;
  private updating = false;
  private state: PlaybackState = "idle";
  private completedAt: number | undefined;
  private fallbackAttempted = false;
  private context?: { movieId: string; profileId: string; startMs: number };
  get sessionId() {
    return this.session?.id;
  }
  private starting = false;
  constructor(
    private api: ApiClient,
    private adapter: PlayerAdapter,
    private change: (state: ControllerState) => void,
    private options: PlaybackOptions = {},
  ) {
    this.remove = adapter.onState((state) => {
      this.state = state;
      if (state === "ended") this.completedAt = this.adapter.getPositionMs();
      if (
        state === "playing" ||
        (state === "paused" &&
          this.completedAt !== undefined &&
          this.adapter.getPositionMs() + 100 < this.completedAt)
      )
        this.completedAt = undefined;
      if (state === "paused" || state === "ended")
        void this.flush(this.completedAt !== undefined);
      if (
        state === "error" &&
        !this.starting &&
        this.session &&
        !this.fallbackAttempted
      ) {
        void this.compatibilityFallback(this.adapter.getPositionMs());
      } else if (state === "error" && !this.starting)
        this.emit({
          kind: "error",
          reason:
            "Playback was interrupted. Retry to reconnect at your last saved position.",
        });
    });
  }
  private emit(state: ControllerState) {
    if (!this.destroyed) this.change(state);
  }
  async start(
    movieId: string,
    profileId: string,
    startMs: number,
    replaceSessionId?: string,
  ) {
    if (this.destroyed || this.starting) return;
    this.context = { movieId, profileId, startMs };
    this.starting = true;
    clearTimeout(this.retry);
    this.emit({ kind: "loading" });
    try {
      const result = await this.api.playback(
        movieId,
        profileId,
        startMs,
        replaceSessionId,
        this.options,
      );
      if (this.destroyed) {
        if (result.kind === "ready")
          await this.api.stop(result.session.id).catch(() => {});
        return;
      }
      this.emit(result);
      if (result.kind === "preparing") {
        this.retry = setTimeout(
          () => void this.start(movieId, profileId, startMs, replaceSessionId),
          5000,
        );
        return;
      }
      if (result.kind !== "ready") return;
      this.session = result.session;
      try {
        await this.adapter.load(result.session);
      } catch (error) {
        if (this.destroyed || this.fallbackAttempted) throw error;
        await this.compatibilityFallback(startMs);
        return;
      }
      if (this.destroyed) return;
      this.timer = setInterval(() => void this.heartbeat(), 30000);
      try {
        await this.adapter.play();
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "NotSupportedError" &&
          !this.fallbackAttempted
        )
          await this.compatibilityFallback(this.adapter.getPositionMs());
        else this.emit({ kind: "paused" });
      }
    } catch {
      this.emit({
        kind: "error",
        reason:
          "We couldn’t start this film. Check the connection and try again.",
      });
    } finally {
      this.starting = false;
    }
  }
  private async compatibilityFallback(position: number) {
    if (this.destroyed || this.fallbackAttempted || !this.context) return;
    this.fallbackAttempted = true;
    clearInterval(this.timer);
    const previous = this.session?.id;
    this.adapter.pause();
    this.options = { ...this.options, forceCompatible: true };
    this.session = undefined;
    if (previous) await this.api.stop(previous).catch(() => {});
    if (this.destroyed) return;
    this.emit({
      kind: "preparing",
      jobId: "compatibility",
      reason:
        "This browser needs a compatible edition. Preparing it automatically.",
    });
    const { movieId, profileId } = this.context;
    this.retry = setTimeout(
      () => void this.start(movieId, profileId, position, previous),
      1000,
    );
  }
  private async heartbeat() {
    if (!this.session || this.destroyed || this.updating) return;
    this.updating = true;
    try {
      const next = await this.api.heartbeat(this.session.id);
      if (this.destroyed || this.session?.id !== next.id) return;
      if (next.mediaUrl !== this.session.mediaUrl) {
        const playing = this.state === "playing";
        await this.adapter.load({
          ...next,
          startMs: this.adapter.getPositionMs(),
        });
        if (this.destroyed) return;
        if (playing) await this.adapter.play();
      }
      this.session = next;
      await this.flush(this.completedAt !== undefined);
    } catch {
      if (this.destroyed) return;
      this.adapter.pause();
      this.emit({
        kind: "error",
        reason:
          "Your playback session could not be renewed. Reconnect to continue.",
      });
    } finally {
      this.updating = false;
    }
  }
  private async flush(ended: boolean) {
    if (!this.session) return;
    const event = {
      sessionId: this.session.id,
      epoch: this.session.epoch,
      sequence: ++this.sequence,
      positionMs: this.adapter.getPositionMs(),
      ended,
    };
    await this.api.progress(event).catch(() => {});
  }
  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.timer);
    clearTimeout(this.retry);
    this.remove();
    // Capture progress before clearing the media element, but never wait for
    // the network before detaching it. React may reuse it on the next render.
    const finalProgress = this.flush(this.completedAt !== undefined);
    const mediaClosed = this.adapter.destroy();
    await mediaClosed;
    await finalProgress;
    if (this.session) await this.api.stop(this.session.id).catch(() => {});
  }
}
