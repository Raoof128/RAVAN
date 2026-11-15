import { afterEach, expect, it, vi } from "vitest";
import { PlayerController } from "../../apps/web/src/player/PlayerController.js";
import { createApiClient } from "../../packages/client/src/api.js";
import type {
  PlayerAdapter,
  PlaybackState,
} from "../../packages/contracts/src/index.js";
afterEach(() => vi.useRealTimers());
function fixture() {
  const api = createApiClient("");
  const session = {
    id: "s",
    epoch: 1,
    mediaUrl: "/media/s/t/raw",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    startMs: 5000,
  };
  api.playback = vi.fn().mockResolvedValue({ kind: "ready", session });
  api.heartbeat = vi.fn().mockResolvedValue(session);
  api.progress = vi.fn().mockResolvedValue({ status: "accepted" });
  api.stop = vi.fn().mockResolvedValue(undefined);
  let listener: ((state: PlaybackState) => void) | undefined;
  const remove = vi.fn();
  const adapter: PlayerAdapter = {
    load: vi.fn().mockResolvedValue(undefined),
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    seek: vi.fn().mockResolvedValue(undefined),
    getPositionMs: () => 5000,
    selectAudio: vi.fn(),
    selectSubtitle: vi.fn(),
    onState: (f) => {
      listener = f;
      return remove;
    },
    destroy: vi.fn().mockResolvedValue(undefined),
  };
  return { api, adapter, remove, emit: (s: PlaybackState) => listener?.(s) };
}
it("starts at resume, orders progress and removes heartbeat and listeners on destroy", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const c = new PlayerController(f.api, f.adapter, () => {});
  await c.start("movie", "web", 5000);
  expect(f.adapter.load).toHaveBeenCalledWith(
    expect.objectContaining({ startMs: 5000 }),
  );
  f.emit("playing");
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.api.heartbeat).toHaveBeenCalledTimes(1);
  f.emit("paused");
  await c.destroy();
  expect(f.remove).toHaveBeenCalledTimes(1);
  expect(f.adapter.destroy).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  const sequences = vi
    .mocked(f.api.progress)
    .mock.calls.map(([event]) => event.sequence);
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
});
it("does not replace a conflicting session without an explicit matching id", async () => {
  const f = fixture();
  f.api.playback = vi
    .fn()
    .mockResolvedValue({ kind: "conflict", sessionId: "other" });
  const states: unknown[] = [];
  const c = new PlayerController(f.api, f.adapter, (s) => states.push(s));
  await c.start("movie", "web", 0);
  expect(f.api.playback).toHaveBeenCalledTimes(1);
  expect(vi.mocked(f.api.playback).mock.calls[0]?.[3]).toBeUndefined();
  expect(states).toContainEqual({ kind: "conflict", sessionId: "other" });
  await c.destroy();
});
it("cleans up a session created after the component was destroyed", async () => {
  const f = fixture();
  let resolve!: (v: Awaited<ReturnType<typeof f.api.playback>>) => void;
  f.api.playback = () =>
    new Promise((r) => {
      resolve = r;
    });
  const c = new PlayerController(f.api, f.adapter, () => {});
  const pending = c.start("movie", "web", 0);
  await c.destroy();
  resolve({
    kind: "ready",
    session: { id: "late", epoch: 1, mediaUrl: "", expiresAt: "", startMs: 0 },
  });
  await pending;
  expect(f.api.stop).toHaveBeenCalledWith("late");
  expect(f.adapter.load).not.toHaveBeenCalled();
});
it("stops preparation polling after destruction and recovers an expired heartbeat visibly", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.api.playback = vi
    .fn()
    .mockResolvedValue({ kind: "preparing", jobId: "probe" });
  const c = new PlayerController(f.api, f.adapter, () => {});
  await c.start("movie", "web", 0);
  expect(vi.getTimerCount()).toBe(1);
  await c.destroy();
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.api.playback).toHaveBeenCalledTimes(1);
  const next = fixture();
  next.api.heartbeat = vi.fn().mockRejectedValue(new Error("revoked"));
  const states: unknown[] = [];
  const second = new PlayerController(next.api, next.adapter, (s) =>
    states.push(s),
  );
  await second.start("movie", "web", 0);
  await vi.advanceTimersByTimeAsync(30000);
  expect(next.adapter.pause).toHaveBeenCalled();
  expect(states.at(-1)).toEqual(expect.objectContaining({ kind: "error" }));
  await second.destroy();
});

it("tears down old media before awaiting the final network progress flush", async () => {
  const f = fixture();
  let release!: () => void;
  f.api.progress = () =>
    new Promise((resolve) => {
      release = () => resolve({ status: "accepted" });
    });
  const c = new PlayerController(f.api, f.adapter, () => {});
  await c.start("movie", "web", 0);
  const closing = c.destroy();
  expect(f.adapter.destroy).toHaveBeenCalledTimes(1);
  release();
  await closing;
});
it("preserves the completed flag across subsequent heartbeats", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const c = new PlayerController(f.api, f.adapter, () => {});
  await c.start("movie", "web", 0);
  f.emit("ended");
  await vi.advanceTimersByTimeAsync(30000);
  expect(
    vi.mocked(f.api.progress).mock.calls.map(([event]) => event.ended),
  ).toEqual([true, true]);
  await c.destroy();
});
it("retains completion while an ended session rotates its media ticket", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const session = {
    id: "s",
    epoch: 1,
    mediaUrl: "/media/s/rotated/raw",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    startMs: 0,
  };
  f.api.heartbeat = vi.fn().mockResolvedValue(session);
  f.adapter.load = vi.fn(async () => {
    f.emit("loading");
  });
  const c = new PlayerController(f.api, f.adapter, () => {});
  await c.start("movie", "web", 0);
  f.emit("ended");
  await vi.advanceTimersByTimeAsync(60000);
  expect(
    vi.mocked(f.api.progress).mock.calls.every(([event]) => event.ended),
  ).toBe(true);
  await c.destroy();
});
it("leaves completion when the viewer deliberately seeks backwards", async () => {
  const f = fixture();
  const c = new PlayerController(f.api, f.adapter, () => {});
  await c.start("movie", "web", 0);
  f.emit("ended");
  f.adapter.getPositionMs = () => 1000;
  f.emit("paused");
  expect(vi.mocked(f.api.progress).mock.calls.at(-1)?.[0].ended).toBe(false);
  await c.destroy();
});
it("keeps waiting for a long CPU conversion and forwards quality and audio", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.api.playback = vi
    .fn()
    .mockResolvedValue({ kind: "preparing", jobId: "long", progress: 35 });
  const c = new PlayerController(f.api, f.adapter, () => {}, {
    quality: "720p",
    audioTrack: 1,
  });
  await c.start("movie", "web", 1234);
  await vi.advanceTimersByTimeAsync(15 * 60000);
  expect(f.api.playback).toHaveBeenCalledTimes(181);
  expect(f.api.playback).toHaveBeenLastCalledWith(
    "movie",
    "web",
    1234,
    undefined,
    { quality: "720p", audioTrack: 1 },
  );
  await c.destroy();
  expect(vi.getTimerCount()).toBe(0);
});
it("automatically requests a forced encode once when the browser rejects a stream", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.adapter.load = vi
    .fn()
    .mockRejectedValueOnce(Error("codec"))
    .mockResolvedValue(undefined);
  const c = new PlayerController(f.api, f.adapter, () => {});
  await c.start("movie", "web", 5000);
  expect(f.api.stop).toHaveBeenCalledWith("s");
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.api.playback).toHaveBeenLastCalledWith("movie", "web", 5000, "s", {
    forceCompatible: true,
  });
  expect(f.adapter.play).toHaveBeenCalledTimes(1);
  await c.destroy();
});

it("falls back after metadata decoder errors but leaves autoplay denials paused", async () => {
  vi.useFakeTimers();
  const f = fixture(),
    states: unknown[] = [];
  const c = new PlayerController(f.api, f.adapter, (s) => states.push(s));
  await c.start("movie", "web", 0);
  f.emit("error");
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.api.playback).toHaveBeenLastCalledWith("movie", "web", 5000, "s", {
    forceCompatible: true,
  });
  f.emit("error");
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.api.playback).toHaveBeenCalledTimes(2);
  await c.destroy();
  const g = fixture();
  g.adapter.play = vi
    .fn()
    .mockRejectedValue(new DOMException("gesture", "NotAllowedError"));
  const d = new PlayerController(g.api, g.adapter, (s) => states.push(s));
  await d.start("movie", "web", 0);
  expect(states.at(-1)).toEqual({ kind: "paused" });
  expect(g.api.stop).not.toHaveBeenCalled();
  await d.destroy();
});
