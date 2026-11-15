import { expect, it } from "vitest";
import { detectCapabilities } from "../../apps/web/src/player/capabilities.js";
import { capabilitiesSchema } from "../../packages/contracts/src/schemas.js";

const browser = (supported: RegExp) => ({
  canPlayType: (type: string) =>
    (supported.test(type) ? "probably" : "") as CanPlayTypeResult,
});

it("reports only what the browser says it plays, in a shape the server accepts", () => {
  // A browser with H.264, hardware HEVC including 10-bit, AAC, AC-3 and MP3.
  const capable = detectCapabilities(
    browser(
      /^video\/mp4; codecs="(avc1|hvc1)|^audio\/mp4; codecs="(mp4a|ac-3)|^audio\/mpeg/,
    ),
  );
  expect(capable).toEqual({
    video: ["h264", "hevc", "hevc10"],
    audio: ["aac", "mp3", "ac3"],
    containers: ["mp4"],
  });
  expect(capabilitiesSchema.safeParse(capable).success).toBe(true);
  // A browser with open codecs only.
  expect(
    detectCapabilities(browser(/webm|x-matroska|vp09|vp8|opus|vorbis|av01/)),
  ).toEqual({
    video: ["av1", "vp9", "vp8"],
    audio: ["opus", "vorbis"],
    containers: ["webm", "matroska"],
  });
});

it("claims nothing when the browser cannot answer", () => {
  expect(
    detectCapabilities({
      canPlayType: () => {
        throw new Error("unavailable");
      },
    }),
  ).toEqual({ video: [], audio: [], containers: [] });
  expect(detectCapabilities(browser(/^$/))).toEqual({
    video: [],
    audio: [],
    containers: [],
  });
});

import { refineCapabilities } from "../../apps/web/src/player/capabilities.js";

const everything = browser(/./);
const decoder = (
  answer: (
    config: MediaDecodingConfiguration,
  ) => Partial<MediaCapabilitiesDecodingInfo>,
) => ({
  decodingInfo: async (config: MediaDecodingConfiguration) =>
    ({
      supported: true,
      smooth: true,
      powerEfficient: true,
      ...answer(config),
    }) as MediaCapabilitiesDecodingInfo,
});

it("withdraws a codec the device says it cannot play smoothly", async () => {
  // AV1 is decodable here, but only in software that would stutter.
  const refined = await refineCapabilities(
    decoder((config) =>
      config.video?.contentType.includes("av01") ? { smooth: false } : {},
    ),
    everything,
  );
  expect(refined.video).toEqual(["h264", "hevc", "hevc10", "vp9", "vp8"]);
  // Audio and containers are not part of the question.
  expect(refined.audio).toEqual(detectCapabilities(everything).audio);
  expect(capabilitiesSchema.safeParse(refined).success).toBe(true);
});

it("asks about 10-bit HEVC as HDR10, and falls back when the browser rejects that question", async () => {
  const asked: MediaDecodingConfiguration[] = [];
  await refineCapabilities(
    decoder((config) => {
      asked.push(config);
      return {};
    }),
    everything,
  );
  const hdr = asked.find((c) => c.video?.contentType.includes("hvc1.2"));
  expect(hdr?.video).toMatchObject({
    transferFunction: "pq",
    colorGamut: "rec2020",
    hdrMetadataType: "smpteSt2086",
  });
  expect(asked.every((c) => c.type === "file")).toBe(true);
  // An older browser throws on the HDR fields but answers the plain question.
  const older = await refineCapabilities(
    {
      decodingInfo: async (config) => {
        if (config.video?.transferFunction)
          throw new TypeError("unknown field");
        return {
          supported: true,
          smooth: true,
          powerEfficient: false,
        } as MediaCapabilitiesDecodingInfo;
      },
    },
    everything,
  );
  expect(older.video).toContain("hevc10");
});

it("keeps the canPlayType answer when the device will not say", async () => {
  expect(await refineCapabilities(undefined, everything)).toEqual(
    detectCapabilities(everything),
  );
  const silent = await refineCapabilities(
    {
      decodingInfo: async () => {
        throw new Error("not allowed");
      },
    },
    everything,
  );
  expect(silent).toEqual(detectCapabilities(everything));
});
