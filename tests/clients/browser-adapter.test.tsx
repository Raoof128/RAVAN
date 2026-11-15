// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const created: FakeHls[] = [];
let mseAvailable = true;
class FakeHls {
  static Events = { ERROR: "hlsError" };
  static ErrorTypes = {
    MEDIA_ERROR: "mediaError",
    NETWORK_ERROR: "networkError",
  };
  static isSupported = () => mseAvailable;
  handlers = new Map<string, (event: string, data: unknown) => void>();
  source?: string;
  media?: HTMLVideoElement;
  recoverMediaError = vi.fn();
  destroy = vi.fn();
  constructor(public config: { startPosition: number }) {
    created.push(this);
  }
  on(event: string, handler: (event: string, data: unknown) => void) {
    this.handlers.set(event, handler);
  }
  loadSource(url: string) {
    this.source = url;
  }
  attachMedia(media: HTMLVideoElement) {
    this.media = media;
    queueMicrotask(() => media.dispatchEvent(new Event("loadedmetadata")));
  }
  fail(data: { fatal: boolean; type: string }) {
    this.handlers.get("hlsError")?.("hlsError", data);
  }
}
vi.mock("hls.js", () => ({ default: FakeHls }));
const { BrowserAdapter } =
  await import("../../apps/web/src/player/BrowserAdapter.js");

const origin = "https://ravan.example";
const session = (startMs = 0, file = "index.m3u8") => ({
  id: "s",
  epoch: 1,
  mediaUrl: `/media/s/ticket/${file}`,
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  startMs,
  subtitles: [],
});
function video(native: string) {
  const element = document.createElement("video");
  element.canPlayType = () => native as CanPlayTypeResult;
  element.load = () =>
    queueMicrotask(() => element.dispatchEvent(new Event("loadedmetadata")));
  element.pause = () => {};
  return element;
}
beforeEach(() => {
  created.length = 0;
  mseAvailable = true;
});
afterEach(() => vi.restoreAllMocks());

it("plays a streamed edition through HLS.js even where the browser claims native HLS", async () => {
  // Chromium 142 and later answer "maybe" here but do not play every stream.
  const element = video("maybe");
  const adapter = new BrowserAdapter(element, origin);
  await adapter.load(session());
  expect(created).toHaveLength(1);
  expect(created[0]!.source).toBe(`${origin}/media/s/ticket/index.m3u8`);
  expect(created[0]!.media).toBe(element);
  expect(element.getAttribute("src")).toBeNull();
  // From the beginning, not from the newest segment of a growing playlist.
  expect(created[0]!.config.startPosition).toBe(0);
  await adapter.destroy();
  expect(created[0]!.destroy).toHaveBeenCalled();
});

it("starts a resumed film at its saved position", async () => {
  const adapter = new BrowserAdapter(video(""), origin);
  await adapter.load(session(754000));
  expect(created[0]!.config.startPosition).toBe(754);
  await adapter.destroy();
});

it("falls back to native HLS only without Media Source Extensions, and on the TV", async () => {
  mseAvailable = false;
  const phone = video("probably");
  const adapter = new BrowserAdapter(phone, origin);
  await adapter.load(session());
  expect(phone.src).toBe(`${origin}/media/s/ticket/index.m3u8`);
  await adapter.destroy();
  mseAvailable = true;
  created.length = 0;
  const tv = video("probably");
  const native = new BrowserAdapter(tv, origin, true);
  await native.load(session());
  expect(created).toHaveLength(0);
  expect(tv.src).toContain("index.m3u8");
  await native.destroy();
  mseAvailable = false;
  await expect(
    new BrowserAdapter(video(""), origin).load(session()),
  ).rejects.toThrow(/unavailable/);
});

it("tries to recover from a decode error, but reports one that returns at once", async () => {
  vi.spyOn(Date, "now").mockReturnValue(100000);
  const adapter = new BrowserAdapter(video(""), origin);
  const states: string[] = [];
  adapter.onState((state) => states.push(state));
  await adapter.load(session());
  const hls = created[0]!;
  hls.fail({ fatal: false, type: "mediaError" });
  expect(hls.recoverMediaError).not.toHaveBeenCalled();
  hls.fail({ fatal: true, type: "mediaError" });
  expect(hls.recoverMediaError).toHaveBeenCalledTimes(1);
  // Again at once: too soon to be a new problem.
  hls.fail({ fatal: true, type: "mediaError" });
  expect(states).toEqual(["error"]);
  await adapter.destroy();
});

it("reports a fatal network error instead of retrying forever", async () => {
  const adapter = new BrowserAdapter(video(""), origin);
  const states: string[] = [];
  adapter.onState((state) => states.push(state));
  await adapter.load(session());
  created[0]!.fail({ fatal: true, type: "networkError" });
  expect(created[0]!.recoverMediaError).not.toHaveBeenCalled();
  expect(states).toEqual(["error"]);
  // It stops fetching once it has given up, rather than polling until unmount.
  expect(created[0]!.destroy).toHaveBeenCalledTimes(1);
  await adapter.destroy();
});

it("plays a single-file edition or an original without HLS.js", async () => {
  const element = video("");
  const adapter = new BrowserAdapter(element, origin);
  await adapter.load(session(0, "video.mp4"));
  expect(created).toHaveLength(0);
  expect(element.src).toBe(`${origin}/media/s/ticket/video.mp4`);
  await adapter.destroy();
});

it("replaces caption tracks in place and refuses a caption from anywhere else", async () => {
  const element = video("");
  const adapter = new BrowserAdapter(element, origin);
  await adapter.load(session());
  expect(element.querySelectorAll("track")).toHaveLength(0);
  adapter.setSubtitles([
    { url: "/media/s/ticket/subtitle-0.vtt", language: "en", label: "English" },
    { url: "/media/s/ticket/subtitle-3.vtt", language: "fa", label: "فارسی" },
  ]);
  const tracks = [...element.querySelectorAll("track")];
  expect(tracks.map((t) => [t.srclang, t.label])).toEqual([
    ["en", "English"],
    ["fa", "فارسی"],
  ]);
  adapter.setSubtitles([
    { url: "/media/s/ticket/subtitle-0.vtt", language: "en", label: "English" },
  ]);
  expect(element.querySelectorAll("track")).toHaveLength(1);
  for (const url of [
    "https://evil.example/media/s/ticket/subtitle-0.vtt",
    "/media/s/ticket/../../api/movies",
    "/media/s/ticket/video.mp4",
  ])
    expect(() =>
      adapter.setSubtitles([{ url, language: "en", label: "x" }]),
    ).toThrow();
  // A refused list leaves the existing tracks alone.
  expect(element.querySelectorAll("track")).toHaveLength(1);
  await adapter.destroy();
});
