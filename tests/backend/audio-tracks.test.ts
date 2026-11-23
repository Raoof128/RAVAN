import { afterEach, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../apps/worker/src/process.js";
import { probeMedia } from "../../apps/worker/src/probe.js";
import {
  prepareBrowser,
  trackName,
  trackLanguage,
} from "../../apps/worker/src/browser-prepare.js";
import {
  HLS_FILE,
  parseMaster,
  parsePlaylist,
  playableNow,
  servePlaylist,
  validateEdition,
  writeMaster,
} from "../../apps/worker/src/hls.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const idle = () => new AbortController().signal;
const renditions = [
  { name: "English", language: "eng", default: false },
  { name: "Persian (dub)", language: "fas", default: true },
];

it("writes and accepts only its own top-level playlist", () => {
  const text = writeMaster(renditions, 2_400_000);
  expect(text).toBe(
    [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="eng",DEFAULT=NO,AUTOSELECT=YES,URI="audio-0.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Persian (dub)",LANGUAGE="fas",DEFAULT=YES,AUTOSELECT=YES,URI="audio-1.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=2400000,AUDIO="audio"',
      "video.m3u8",
      "",
    ].join("\n"),
  );
  expect(parseMaster(text).renditions).toEqual(renditions);
  expect(servePlaylist("index.m3u8", text)).toBe(text);
  const change = (from: string, to: string) => text.replace(from, to);
  for (const tampered of [
    // Somewhere else to fetch from.
    change("video.m3u8", "https://evil.example/video.m3u8"),
    change('URI="audio-1.m3u8"', 'URI="../audio-1.m3u8"'),
    change('URI="audio-1.m3u8"', 'URI="audio-0.m3u8"'),
    // A name that would break out of its attribute, or an odd language.
    change('NAME="English"', 'NAME="En",URI="x.m3u8"'),
    change('LANGUAGE="eng"', 'LANGUAGE="e n"'),
    // Two defaults, or none.
    change("DEFAULT=NO", "DEFAULT=YES"),
    change("DEFAULT=YES", "DEFAULT=NO"),
    // Anything added.
    text + '#EXT-X-SESSION-DATA:DATA-ID="x"\n',
    change("#EXT-X-VERSION:7", "#EXT-X-VERSION:7\n#EXT-X-START:TIME-OFFSET=9"),
  ])
    expect(() => servePlaylist("index.m3u8", tampered)).toThrow();
  // Labels from the film are checked before they are written.
  expect(() =>
    writeMaster([{ name: 'a"b', language: "eng", default: true }], 1),
  ).toThrow();
  expect(() =>
    writeMaster([{ name: "x", language: "en;g", default: true }], 1),
  ).toThrow();
});

it("accepts each stream's playlist only with its own files", () => {
  const audio = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-TARGETDURATION:6",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    '#EXT-X-MAP:URI="a1-init.mp4"',
    "#EXTINF:6.016000,",
    "a1-seg-00000.m4s",
  ].join("\n");
  expect(servePlaylist("audio-1.m3u8", audio)).toContain("a1-seg-00000.m4s");
  expect(parsePlaylist(audio, "a1-").segments).toHaveLength(1);
  // The same playlist served under another stream's name is refused.
  expect(() => servePlaylist("audio-0.m3u8", audio)).toThrow();
  expect(() => servePlaylist("video.m3u8", audio)).toThrow();
  expect(() => servePlaylist("index.m3u8", audio)).toThrow();
  expect(() =>
    servePlaylist("audio-1.m3u8", audio.replace("a1-seg", "a0-seg")),
  ).toThrow();
  expect(() => servePlaylist("other.m3u8", audio)).toThrow();
  for (const name of [
    "video.m3u8",
    "audio-12.m3u8",
    "v-init.mp4",
    "a3-seg-00042.m4s",
  ])
    expect(HLS_FILE.test(name), name).toBe(true);
  for (const name of [
    "audio-123.m3u8",
    "a-seg-00001.m4s",
    "v-seg-1.m4s",
    "video.m3u8.tmp",
    "../video.m3u8",
  ])
    expect(HLS_FILE.test(name), name).toBe(false);
});

it("names tracks from the film, in words, and keeps labels safe", () => {
  expect(trackName({ language: "fas" }, 1)).toBe("Persian");
  expect(
    trackName({ language: "eng", title: "Director's commentary" }, 0),
  ).toBe("Director's commentary");
  expect(trackName({ title: 'Evil" ,URI="x' }, 0)).toBe("Evil ,URI x");
  expect(trackName({}, 2)).toBe("Audio 3");
  // Cut by character: no half of a pair is left to break the label.
  const long = trackName({ title: "𝔄".repeat(60) }, 0);
  expect(Array.from(long)).toHaveLength(48);
  expect(() =>
    writeMaster([{ name: long, language: "eng", default: true }], 1),
  ).not.toThrow();
  expect(trackName({ language: "und" }, 0)).toBe("Audio 1");
  expect(trackLanguage("fas")).toBe("fas");
  expect(trackLanguage("pt-BR")).toBe("pt-BR");
  const traditional = trackLanguage("zh-Hant-TW");
  expect(traditional).toBe("zh-Hant-TW");
  expect(
    parseMaster(
      writeMaster(
        [{ name: "Chinese", language: traditional, default: true }],
        3500000,
      ),
    ).renditions[0]?.language,
  ).toBe(traditional);
  expect(trackLanguage('en",x')).toBe("und");
  expect(trackLanguage(undefined)).toBe("und");
});

it("prepares one edition carrying every audio track, playable while it grows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ravan-audio-"));
  dirs.push(dir);
  await writeFile(
    join(dir, "text.srt"),
    "1\n00:00:00,100 --> 00:00:01,500\nسلام\n",
  );
  const input = join(dir, "source.mkv");
  await runProcess(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880",
      "-i",
      join(dir, "text.srt"),
      "-t",
      "20",
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-map",
      "2:a",
      "-map",
      "3:s",
      "-c:v",
      "libx264",
      "-g",
      "48",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "ac3",
      "-metadata:s:a:0",
      "language=eng",
      "-metadata:s:a:1",
      "language=fas",
      "-metadata:s:a:1",
      "title=Persian (dub)",
      "-c:s",
      "srt",
      input,
    ],
    idle(),
    30000,
  );
  const probe = await probeMedia(input, idle());
  expect(probe.audio).toHaveLength(2);
  const output = join(dir, "edition");
  let playable = 0;
  const result = await prepareBrowser(input, output, probe, "auto", 1, idle(), {
    maxBytes: 64 * 1024 ** 2,
    format: "hls",
    allAudio: true,
    playable: () => playable++,
    verify: async () => {},
  });
  expect(playable).toBe(1);
  expect(result.format).toBe("hls");
  expect(result.captions.map((c) => c.file)).toEqual(["subtitle-0.vtt"]);
  const files = (await readdir(output)).sort();
  expect(files).toContain("index.m3u8");
  expect(files).toContain("video.m3u8");
  expect(files).toContain("audio-0.m3u8");
  expect(files).toContain("audio-1.m3u8");
  expect(files).toContain("a1-init.mp4");
  // Every file is one the server will serve, and nothing else was left.
  expect(
    files.filter((f) => !HLS_FILE.test(f) && !/^subtitle-\d+\.vtt$/.test(f)),
  ).toEqual([]);
  const top = parseMaster(await readFile(join(output, "index.m3u8"), "utf8"));
  // The track asked for is the default; names are words, not codes.
  expect(top.renditions).toEqual([
    { name: "English", language: "eng", default: false },
    { name: "Persian (dub)", language: "fas", default: true },
  ]);
  const picture = await validateEdition(output);
  expect(picture.seconds).toBeCloseTo(20, 0);
  expect(await playableNow(output)).toBe(true);
  // Read back as a whole, it is one picture and both languages as AAC.
  const back = await probeMedia(
    join(output, "index.m3u8"),
    idle(),
    undefined,
    "hls,mov",
  );
  expect(back.video?.codec).toBe("h264");
  expect(back.audio.map((a) => a.codec)).toEqual(["aac", "aac"]);
});

it("keeps a single-track film in the layout it always had", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ravan-audio-"));
  dirs.push(dir);
  const input = join(dir, "source.mkv");
  await runProcess(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440",
      "-t",
      "8",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "ac3",
      input,
    ],
    idle(),
    30000,
  );
  const probe = await probeMedia(input, idle());
  const output = join(dir, "edition");
  await prepareBrowser(input, output, probe, "auto", 0, idle(), {
    maxBytes: 64 * 1024 ** 2,
    format: "hls",
    // Asked for, but there is only one track to carry.
    allAudio: true,
    verify: async () => {},
  });
  const files = await readdir(output);
  expect(files).toContain("init.mp4");
  expect(files).not.toContain("video.m3u8");
  expect(
    parsePlaylist(await readFile(join(output, "index.m3u8"), "utf8")).ended,
  ).toBe(true);
});

it("makes every language as long as the picture, copying a picture it can", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ravan-audio-"));
  dirs.push(dir);
  const input = join(dir, "source.mkv");
  // A 30 s film with a commentary that stops after 12 s and a dub that runs on.
  await runProcess(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=24:duration=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=660:duration=12",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880:duration=40",
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-map",
      "2:a",
      "-map",
      "3:a",
      "-c:v",
      "libx264",
      "-g",
      "48",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-metadata:s:a:0",
      "language=eng",
      "-metadata:s:a:1",
      "language=eng",
      "-metadata:s:a:2",
      "language=eng",
      "-t",
      "30",
      input,
    ],
    idle(),
    30000,
  );
  const probe = await probeMedia(input, idle());
  const output = join(dir, "edition");
  const result = await prepareBrowser(input, output, probe, "auto", 0, idle(), {
    maxBytes: 64 * 1024 ** 2,
    format: "hls",
    allAudio: true,
    // This browser plays H.264: the picture is copied, not re-encoded.
    videoCaps: ["h264"],
    verify: async () => {},
  });
  expect(result.label).toMatch(/Original picture/);
  const layout = parseMaster(
    await readFile(join(output, "index.m3u8"), "utf8"),
  );
  // Three tracks called English: each name distinct.
  expect(layout.renditions.map((r) => r.name)).toEqual([
    "English",
    "English 2",
    "English 3",
  ]);
  const picture = await validateEdition(output);
  for (const i of [0, 1, 2]) {
    const audio = parsePlaylist(
      await readFile(join(output, `audio-${i}.m3u8`), "utf8"),
      `a${i}-`,
    );
    expect(
      Math.abs(audio.seconds - picture.seconds),
      `track ${i}`,
    ).toBeLessThan(1);
  }
});

it("waits for every stream before saying a growing edition can be played", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ravan-audio-"));
  dirs.push(dir);
  await writeFile(join(dir, "index.m3u8"), writeMaster(renditions, 1_000_000));
  const media = (prefix: string, count: number) =>
    [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-TARGETDURATION:6",
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:EVENT",
      `#EXT-X-MAP:URI="${prefix}init.mp4"`,
      ...Array.from({ length: count }, (_, i) => [
        "#EXTINF:6.000000,",
        `${prefix}seg-${String(i).padStart(5, "0")}.m4s`,
      ]).flat(),
    ].join("\n") + "\n";
  // Nothing yet, then the picture alone, then one language: not enough.
  expect(await playableNow(dir)).toBe(false);
  await writeFile(join(dir, "video.m3u8"), media("v-", 3));
  await writeFile(join(dir, "audio-0.m3u8"), media("a0-", 3));
  expect(await playableNow(dir)).toBe(false);
  await writeFile(join(dir, "audio-1.m3u8"), media("a1-", 2));
  expect(await playableNow(dir)).toBe(false);
  await writeFile(join(dir, "audio-1.m3u8"), media("a1-", 3));
  expect(await playableNow(dir)).toBe(true);
  // Not finished: an edition still growing does not pass as complete.
  await expect(validateEdition(dir)).rejects.toThrow();
});
