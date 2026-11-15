import type { ClientCapabilities } from "../../../../packages/contracts/src/index.js";

// One representative type string per codec. The server uses the answers to hand
// over an original file, or to repackage it, instead of re-encoding for hours.
const video: Record<ClientCapabilities["video"][number], string> = {
  h264: 'video/mp4; codecs="avc1.640028"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L120.90"',
  // Main 10 at level 5.1: 10-bit and HDR10 sources up to 4K.
  hevc10: 'video/mp4; codecs="hvc1.2.4.L153.B0"',
  av1: 'video/mp4; codecs="av01.0.08M.08"',
  vp9: 'video/webm; codecs="vp09.00.40.08"',
  vp8: 'video/webm; codecs="vp8"',
};
const audio: Record<ClientCapabilities["audio"][number], string[]> = {
  aac: ['audio/mp4; codecs="mp4a.40.2"'],
  mp3: ["audio/mpeg"],
  ac3: ['audio/mp4; codecs="ac-3"'],
  eac3: ['audio/mp4; codecs="ec-3"'],
  flac: ['audio/mp4; codecs="flac"', "audio/flac"],
  opus: ['audio/webm; codecs="opus"'],
  vorbis: ['audio/webm; codecs="vorbis"'],
};
const containers: Record<ClientCapabilities["containers"][number], string> = {
  mp4: video.h264,
  webm: 'video/webm; codecs="vp8, vorbis"',
  matroska: 'video/x-matroska; codecs="avc1.640028, mp4a.40.2"',
};
type Element = Pick<HTMLMediaElement, "canPlayType">;
type Decoding = Pick<MediaCapabilities, "decodingInfo">;
let cached: ClientCapabilities | undefined;

function supported(probe: Element): ClientCapabilities {
  const plays = (type: string) => {
    try {
      return probe.canPlayType(type) !== "";
    } catch {
      return false;
    }
  };
  const keys = <T extends string>(table: Record<T, string | string[]>) =>
    (Object.keys(table) as T[]).filter((key) =>
      ([] as string[]).concat(table[key]).some(plays),
    );
  return {
    video: keys(video),
    audio: keys(audio),
    containers: keys(containers),
  };
}

/**
 * What this browser reports it can play. "maybe" counts: the server's guess is
 * recoverable, because a stream the browser then rejects falls back to a
 * compatible edition. Once refineCapabilities() has finished, its answer is used.
 */
export function detectCapabilities(element?: Element): ClientCapabilities {
  if (element) return supported(element);
  return (cached ??= supported(document.createElement("video")));
}

/**
 * canPlayType says a codec can be decoded, not that it plays well. The Media
 * Capabilities API also says whether decoding is smooth on this device, which
 * is what separates a hardware decoder from software that stutters. A codec the
 * device cannot play smoothly is withdrawn, so the server prepares an edition
 * instead of handing over an original that would judder.
 */
export async function refineCapabilities(
  decoding: Decoding | undefined = globalThis.navigator?.mediaCapabilities,
  element?: Element,
): Promise<ClientCapabilities> {
  const base = element
    ? supported(element)
    : supported(document.createElement("video"));
  if (!decoding?.decodingInfo) {
    if (!element) cached = base;
    return base;
  }
  const smooth = async (
    codec: ClientCapabilities["video"][number],
  ): Promise<boolean> => {
    const ask = async (extra: Partial<VideoConfiguration>) => {
      const info = await decoding.decodingInfo({
        type: "file",
        video: {
          contentType: video[codec],
          width: 1920,
          height: 1080,
          bitrate: 10_000_000,
          framerate: 24,
          ...extra,
        },
      });
      return info.supported && info.smooth;
    };
    try {
      // 10-bit HEVC is asked about as HDR10, the hardest thing it will be given.
      return await ask(
        codec === "hevc10"
          ? {
              hdrMetadataType: "smpteSt2086",
              colorGamut: "rec2020",
              transferFunction: "pq",
            }
          : {},
      );
    } catch {
      try {
        // A browser that does not know the HDR fields rejects the whole query.
        return await ask({});
      } catch {
        // No answer at all: keep what canPlayType said.
        return true;
      }
    }
  };
  const verdicts = await Promise.all(base.video.map(smooth));
  const refined = {
    ...base,
    video: base.video.filter((_codec, index) => verdicts[index]),
  };
  if (!element) cached = refined;
  return refined;
}
