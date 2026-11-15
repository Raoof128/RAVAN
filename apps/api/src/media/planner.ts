import { PROBE_VERSION, type Probe } from "../../../worker/src/probe.js";
import { profiles } from "./profiles.js";
import { statfs } from "node:fs/promises";
import {
  clientDecodes,
  conversionPlan,
  qualities,
  textSubtitles,
  type Quality,
} from "../../../worker/src/compatibility.js";
import {
  assetId,
  CAPACITY,
  editionBytes,
  roomPlan,
} from "../../../worker/src/prepared-store.js";
import type { Database } from "../../../../packages/db/src/open.js";
import type {
  SourceRef,
  DeviceProfile,
  PlaybackPlan,
  PlaybackOptions,
  ClientCapabilities,
  PictureChoice,
} from "../../../../packages/contracts/src/index.js";
import { JobQueue } from "../../../worker/src/leases.js";
import { HLS_MAX_AUDIO } from "../../../worker/src/hls.js";
import { capabilitiesSchema } from "../../../../packages/contracts/src/schemas.js";
import { sameLanguage } from "../../../../packages/contracts/src/languages.js";
type FileHint = { name?: string | null; mimeType?: string | null };
export type PlanOptions = PlaybackOptions & {
  startMs?: number;
  /** Asked for by a paired screen rather than the owner's own session. */
  screen?: boolean;
};
/**
 * Conversions a paired screen may have waiting or running, across all films.
 * A screen's request outranks background work and can remove other films'
 * copies to make room, so without a bound one screen could queue every film
 * in every size: hours of work each. The owner is not held to it.
 */
export const SCREEN_WAITING_LIMIT = 3;
/** Audio a browser plays from each container, before asking what this client decodes. */
const containerAudio = {
  mp4: ["aac", "mp3", "ac3", "eac3", "flac"],
  webm: ["opus", "vorbis"],
  matroska: ["aac", "mp3", "ac3", "eac3", "flac", "opus", "vorbis"],
} as const;
const containerVideo = {
  mp4: ["h264", "hevc", "av1"],
  webm: ["vp8", "vp9", "av1"],
  matroska: ["h264", "hevc", "av1", "vp9", "vp8"],
} as const;
function containerOf(probe: Probe, file: FileHint | undefined) {
  if (probe.container.includes("mp4")) return "mp4" as const;
  if (!probe.container.includes("matroska")) return;
  // FFprobe reports WebM and Matroska alike; browsers that refuse Matroska do not.
  return file?.mimeType === "video/webm" || /\.webm$/i.test(file?.name ?? "")
    ? ("webm" as const)
    : ("matroska" as const);
}
/**
 * Whether the original file can be handed to the player untouched. Without
 * reported capabilities only the combination every browser plays is direct. With
 * them, anything this client says it decodes is, which avoids preparation
 * entirely. A wrong guess is recoverable: the player asks for a compatible
 * edition when the browser rejects a stream.
 */
export function choosePlayback(
  probe: Probe,
  profile: string,
  capabilities?: ClientCapabilities,
  file?: FileHint,
): { mode: "direct" | "prepare" | "unsupported"; reason?: string } {
  if (!(profile in profiles))
    return {
      mode: "unsupported",
      reason: "This device profile is not supported.",
    };
  const v = probe.video;
  if (!v) return { mode: "unsupported", reason: "No video track was found." };
  if (v.dolbyVisionProfile === 5)
    return {
      mode: "unsupported",
      reason:
        "This Dolby Vision-only file needs a compatible base-layer edition.",
    };
  const bounds = profiles[profile as keyof typeof profiles];
  const fits = v.width <= bounds.maxWidth && v.height <= bounds.maxHeight;
  const prepare = {
    mode: "prepare" as const,
    reason: "Preparing a compatible browser edition.",
  };
  if (!capabilities)
    return probe.container.includes("mp4") &&
      v.codec === "h264" &&
      v.pixelFormat === "yuv420p" &&
      !v.hdr &&
      fits &&
      probe.audio.length <= 1 &&
      probe.audio.every((a) => a.codec === "aac" && a.channels <= 2) &&
      probe.subtitles.length === 0
      ? { mode: "direct" }
      : prepare;
  const container = containerOf(probe, file);
  const first = probe.audio[0];
  // The player cannot choose a track in an original file; it plays the default.
  // Stay direct only when that is unambiguously the first track.
  const firstIsDefault =
    !probe.audio.some((a, index) => index > 0 && a.default) ||
    Boolean(first?.default);
  return container &&
    capabilities.containers.includes(container) &&
    (containerVideo[container] as readonly string[]).includes(v.codec) &&
    clientDecodes(v, capabilities.video) &&
    fits &&
    firstIsDefault &&
    (!first ||
      ((containerAudio[container] as readonly string[]).includes(first.codec) &&
        (capabilities.audio as readonly string[]).includes(first.codec))) &&
    // Captions need extracting; image subtitles cannot be shown either way.
    !probe.subtitles.some((track) => textSubtitles.has(track.codec))
    ? { mode: "direct" }
    : prepare;
}
export class MediaPlanner {
  constructor(
    private db: Database,
    private workerConfigured: boolean,
    private preparedDir?: string,
    private now = Date.now,
    private settings: {
      /** "hls" editions can be watched while they are still being prepared. */
      format?: "mp4" | "hls";
      capacityBytes?: number;
    } = {},
  ) {}
  /**
   * Background preparation has no client to ask, so it plans for the browser the
   * owner last played from. The caller must have established that the report
   * came from the owner's own session: a paired device must not be able to
   * steer what the server spends hours preparing.
   */
  rememberCapabilities(capabilities: ClientCapabilities) {
    const value = JSON.stringify(capabilities);
    this.db
      .prepare(
        "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE settings.value<>excluded.value",
      )
      .run(CAPABILITIES_KEY, value, this.now());
  }
  /** A copy this large would not fit the prepared volume beside anything else. */
  private tooLargeToCopy(source: SourceRef) {
    return (
      Number(source.sizeBytes) >
      Math.max(0, (this.settings.capacityBytes ?? CAPACITY) - 4 * 1024 ** 3)
    );
  }
  /**
   * What choosing each picture would do, for the web player: play a copy that
   * is ready, make one in free space, make one by removing other films'
   * prepared copies (and how many films), or nothing, because the space is
   * being watched. Plans for the browser the owner last played from.
   */
  async pictureChoices(source: SourceRef): Promise<PictureChoice[]> {
    const row = this.db
      .prepare("SELECT metadata FROM tracks WHERE id=? AND kind='probe'")
      .get(`probe-${source.fileId}`) as { metadata: string } | undefined;
    const record = row
      ? (JSON.parse(row.metadata) as {
          generation: string;
          probe: Probe;
          version?: number;
        })
      : undefined;
    if (
      !this.preparedDir ||
      !record ||
      record.generation !== source.generation ||
      !record.probe.video
    )
      return [];
    const probe = record.probe;
    const caps =
      record.version === PROBE_VERSION
        ? storedCapabilities(this.db)
        : undefined;
    const file = this.db
      .prepare("SELECT name,mime_type mimeType FROM source_files WHERE id=?")
      .get(source.fileId) as FileHint | undefined;
    const direct = choosePlayback(probe, "web", caps, file).mode === "direct";
    const forceFor = (q: Quality) =>
      q === "auto" && this.tooLargeToCopy(source);
    const plans = new Map(
      qualities.map((q) => {
        try {
          return [q, conversionPlan(probe, q, forceFor(q), caps?.video)];
        } catch {
          return [q, undefined];
        }
      }),
    );
    const readyQualities = new Set(
      (
        this.db
          .prepare(
            "SELECT quality FROM prepared_assets WHERE source_id=? AND generation=? AND state='ready' AND format=?",
          )
          .all(
            source.fileId,
            source.generation,
            this.settings.format ?? "mp4",
          ) as Array<{ quality: string }>
      ).map((r) => r.quality),
    );
    // Free space on the volume, as configured: the filesystem's own figure
    // could be larger than the share prepared films may use.
    const capacity = this.settings.capacityBytes ?? CAPACITY;
    const used = Number(
      (
        this.db
          .prepare(
            "SELECT coalesce(sum(CAST(size_bytes AS INTEGER)),0) n FROM prepared_assets WHERE state='ready'",
          )
          .get() as { n: number }
      ).n,
    );
    const space = await statfs(this.preparedDir, { bigint: true }).catch(
      () => undefined,
    );
    const available = Math.max(
      0,
      Math.min(
        space ? Number(space.bavail * space.bsize) : Infinity,
        capacity - used,
      ),
    );
    const readyFilms = new Map<string, number>();
    for (const r of this.db
      .prepare(
        "SELECT source_id sourceId,count(*) n FROM prepared_assets WHERE state='ready' GROUP BY source_id",
      )
      .all() as Array<{ sourceId: string; n: number }>)
      readyFilms.set(r.sourceId, r.n);
    return qualities.map((quality): PictureChoice => {
      const plan = plans.get(quality);
      if (!plan) return { quality, state: "unavailable" };
      const key = JSON.stringify(plan);
      if (
        (direct &&
          (quality === "auto" ||
            quality === "original" ||
            plan.height === probe.video!.height)) ||
        qualities.some(
          (q) => readyQualities.has(q) && JSON.stringify(plans.get(q)) === key,
        )
      )
        return { quality, state: "ready" };
      const needed = editionBytes({
        copyVideo: plan.copyVideo,
        bitrateKbps: plan.bitrate,
        durationMs: probe.durationMs,
        sourceBytes: Number(source.sizeBytes),
        capacity,
      });
      const evicted = roomPlan(this.db, available, needed, this.now());
      if (!evicted) return { quality, state: "too-large" };
      // Films that would be left with no prepared copy at all.
      const lost = new Map<string, number>();
      for (const e of evicted)
        if (e.sourceId !== source.fileId)
          lost.set(e.sourceId, (lost.get(e.sourceId) ?? 0) + 1);
      const films = [...lost].filter(
        ([id, n]) => n >= (readyFilms.get(id) ?? 0),
      ).length;
      return films
        ? { quality, state: "removes", films }
        : { quality, state: "fits" };
    });
  }
  async planPlayback(
    source: SourceRef,
    profile: DeviceProfile,
    options: PlanOptions = {},
    background = false,
  ): Promise<PlaybackPlan> {
    if (!(profile.id in profiles))
      return {
        mode: "unsupported",
        assetId: source.fileId,
        reason: "Unsupported device profile.",
      };
    const row = this.db
      .prepare("SELECT metadata FROM tracks WHERE id=? AND kind='probe'")
      .get(`probe-${source.fileId}`) as { metadata: string } | undefined;
    const record = row
      ? (JSON.parse(row.metadata) as {
          generation: string;
          probe: Probe;
          version?: number;
        })
      : undefined;
    const queue = new JobQueue(this.db, this.now);
    // A film someone is waiting on outranks background preparation, and the most
    // recently requested film outranks earlier requests.
    const wanted = !background;
    const priority = wanted ? this.now() : 0;
    if (
      !record ||
      record.generation !== source.generation ||
      (this.preparedDir && record.version !== PROBE_VERSION)
    ) {
      if (!this.workerConfigured)
        return {
          mode: "unsupported",
          assetId: source.fileId,
          reason: "The media worker is unavailable.",
        };
      const jobId = queue.enqueue(
        "probe",
        `probe-v${PROBE_VERSION}:${source.fileId}:${source.generation}`,
        source,
        priority,
      );
      const job = this.db
        .prepare("SELECT state FROM jobs WHERE id=?")
        .get(jobId) as { state: string };
      return job.state === "failed" && !(wanted && queue.retry(jobId))
        ? {
            mode: "unsupported",
            assetId: source.fileId,
            reason:
              "This file could not be decoded. It may be damaged, encrypted, or use an unavailable format.",
          }
        : {
            mode: "prepare",
            assetId: jobId,
            reason: "Checking video, audio and captions.",
            phase: "inspecting",
          };
    }
    const probe = record.probe,
      quality = options.quality ?? "auto";
    const prefs = this.db
      .prepare("SELECT data FROM preferences WHERE id=1")
      .get() as { data: string } | undefined;
    const language = prefs
      ? String(JSON.parse(prefs.data).audioLanguage ?? "original")
      : "original";
    // By the rule the players use: a saved "en" is the film's "eng" track.
    const preferred = probe.audio.findIndex((a) =>
      sameLanguage(a.language, language),
    );
    const audio = options.audioTrack ?? Math.max(0, preferred);
    if (audio >= Math.max(1, probe.audio.length))
      return {
        mode: "unsupported",
        assetId: source.fileId,
        reason: "That audio track is unavailable.",
      };
    // An older probe does not say which audio track is the default, so it cannot
    // support the wider direct-play rules. Plan it the conservative way.
    const capabilities =
      record.version === PROBE_VERSION ? options.capabilities : undefined;
    const file = this.db
      .prepare("SELECT name,mime_type mimeType FROM source_files WHERE id=?")
      .get(source.fileId) as FileHint | undefined;
    const choice = choosePlayback(probe, profile.id, capabilities, file);
    if (choice.mode === "unsupported")
      return { ...choice, assetId: source.fileId };
    const forceFor = (q: Quality) =>
      Boolean(options.forceCompatible) ||
      // A copy this large would not fit the prepared volume beside anything else.
      (q === "auto" && this.tooLargeToCopy(source));
    const forceEncode = forceFor(quality);
    let conversion;
    try {
      conversion = conversionPlan(
        probe,
        quality,
        forceEncode,
        capabilities?.video,
      );
    } catch {
      return {
        mode: "unsupported",
        assetId: source.fileId,
        reason:
          "This file exceeds supported dimensions/duration or has no compatible video base layer.",
      };
    }
    if (
      choice.mode === "direct" &&
      !options.forceCompatible &&
      audio === 0 &&
      (quality === "auto" ||
        quality === "original" ||
        conversion.height === probe.video!.height)
    )
      return { mode: "direct", assetId: source.fileId, label: "Original" };
    if (!this.preparedDir)
      return {
        mode: "unsupported",
        assetId: source.fileId,
        reason: "Compatible-version preparation is not configured.",
      };
    // Each edition's identity, under one quality's name.
    const names = (q: Quality, force: boolean) => ({
      single: assetId(
        source.fileId,
        source.generation,
        q,
        audio,
        force,
        conversion.variant,
      ),
      oneTrack: assetId(
        source.fileId,
        source.generation,
        q,
        audio,
        force,
        [conversion.variant, "hls"].filter(Boolean).join("+"),
      ),
      // A streamed edition of a film with several audio tracks carries all of
      // them, so changing language needs no new edition. Its identity does not
      // depend on which track was asked for.
      everyTrack: assetId(
        source.fileId,
        source.generation,
        q,
        -1,
        force,
        [conversion.variant, "hls", "all-audio"].filter(Boolean).join("+"),
      ),
    });
    type Kind = keyof ReturnType<typeof names>;
    const own = names(quality, forceEncode);
    // The same edition can go by several names: on a 4K film, Auto, Original
    // and 2160p all copy the original picture. One made under another name is
    // used rather than made again, and so is one being made.
    const twins = sameEditions(
      probe,
      quality,
      conversion,
      forceFor,
      capabilities?.video,
    ).map(([q, force]) => ({ q, force, ids: names(q, force) }));
    const ready = (candidate: string) => {
      const row = this.db
        .prepare("SELECT state,label FROM prepared_assets WHERE id=?")
        .get(candidate) as { state: string; label: string } | undefined;
      if (row?.state !== "ready") return;
      if (!background)
        this.db
          .prepare("UPDATE prepared_assets SET last_used=? WHERE id=?")
          .run(Date.now(), candidate);
      return {
        mode: "prepared" as const,
        assetId: candidate,
        label: row.label,
      };
    };
    // Only the web player is known to play a segmented edition; other clients
    // keep the single file. Each layout has its own identity.
    const streamed = this.settings.format === "hls" && profile.id === "web";
    const { single, everyTrack } = own;
    const readyAs = (kind: Kind) => {
      for (const ids of [own, ...twins.map((t) => t.ids)]) {
        const found = ready(ids[kind]);
        if (found) return found;
      }
    };
    // If the all-languages edition could not be made, fall back to one
    // language at a time rather than leave the film unplayable.
    const allAudio =
      streamed &&
      probe.audio.length > 1 &&
      probe.audio.length <= HLS_MAX_AUDIO &&
      (
        this.db
          .prepare("SELECT state FROM jobs WHERE unique_key=?")
          .get(`browser:${everyTrack}`) as { state: string } | undefined
      )?.state !== "failed";
    const kind: Kind = allAudio
      ? "everyTrack"
      : streamed
        ? "oneTrack"
        : "single";
    // Editions finished earlier play as well as a new one: the all-tracks one,
    // then one with the asked-for track, streamed or as a single file.
    // A viewer is given what is already finished: the all-languages edition,
    // or one in the language asked for. Background planning instead builds
    // the all-languages edition of a film that has only one-language copies,
    // so that switching language is instant by the time someone tries.
    const finished =
      readyAs(kind) ??
      (allAudio && !background ? readyAs("oneTrack") : undefined) ??
      (streamed && !(allAudio && background) ? readyAs("single") : undefined);
    if (finished) return finished;
    const jobState = (candidate: string) =>
      (
        this.db
          .prepare("SELECT state FROM jobs WHERE unique_key=?")
          .get(`browser:${candidate}`) as { state: string } | undefined
      )?.state;
    const making = twins.find((t) =>
      ["queued", "running"].includes(jobState(t.ids[kind]) ?? ""),
    );
    const [jobQuality, jobForce] = making
      ? [making.q, making.force]
      : [quality, forceEncode];
    const id = (making?.ids ?? own)[kind];
    const asset = this.db
      .prepare("SELECT state,label FROM prepared_assets WHERE id=?")
      .get(id) as { state: string; label: string } | undefined;
    if (asset?.state === "streaming" && wanted) {
      const running = this.db
        .prepare(
          // A worker that died still shows as running until its lease expires.
          "SELECT progress,started_at startedAt FROM jobs WHERE unique_key=? AND state='running' AND lease_until>?",
        )
        .get(`browser:${id}`, this.now()) as
        { progress: number; startedAt: number | null } | undefined;
      if (
        running?.startedAt &&
        playableNow({
          durationMs: probe.durationMs,
          progress: running.progress,
          startedAt: running.startedAt,
          now: this.now(),
          startMs: options.startMs ?? 0,
        })
      )
        return {
          mode: "prepared",
          assetId: id,
          label: asset.label,
          live: true,
        };
    }
    // An evicted background rendition stays evicted until the viewer asks for it.
    // Otherwise a library larger than the cache would re-encode forever.
    // That holds for either layout: an evicted single file is not a reason to
    // prepare the streamed one in the background.
    if (
      background &&
      (asset?.state === "evicted" ||
        (streamed &&
          (
            this.db
              .prepare("SELECT state FROM prepared_assets WHERE id=?")
              .get(single) as { state: string } | undefined
          )?.state === "evicted"))
    )
      return {
        mode: "unsupported",
        assetId: id,
        reason: "Prepared edition reclaimed; play to prepare again.",
      };
    if (
      options.screen &&
      wanted &&
      !["queued", "running"].includes(jobState(id) ?? "") &&
      (
        this.db
          .prepare(
            "SELECT count(*) n FROM jobs WHERE kind='browser-prepare' AND state IN ('queued','running') AND priority>0",
          )
          .get() as { n: number }
      ).n >= SCREEN_WAITING_LIMIT
    )
      return {
        mode: "unsupported",
        assetId: id,
        reason:
          "The server is already preparing other films. Try again when one has finished.",
      };
    // One transaction: the worker's cleanup of superseded jobs must see either
    // none of this request or all of it, priority included.
    const jobId = this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO prepared_assets(id,source_id,generation,quality,audio_track,last_used,format) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id,
          source.fileId,
          source.generation,
          jobQuality,
          audio,
          Date.now(),
          streamed ? "hls" : "mp4",
        );
      return queue.enqueue(
        "browser-prepare",
        `browser:${id}`,
        {
          source,
          quality: jobQuality,
          audio,
          forceEncode: jobForce,
          id,
          format: streamed ? "hls" : "mp4",
          ...(allAudio ? { allAudio: true } : {}),
          ...(capabilities ? { video: capabilities.video } : {}),
        },
        priority,
      );
    })();
    if (asset?.state === "evicted")
      this.db
        .prepare(
          "UPDATE jobs SET state='queued',attempts=0,progress=0 WHERE id=? AND state='completed'",
        )
        .run(jobId);
    const job = this.db
      .prepare("SELECT state,progress,error_code FROM jobs WHERE id=?")
      .get(jobId) as {
      state: string;
      progress: number;
      error_code: string | null;
    };
    if (job.state === "failed") {
      // Asking again is the owner's retry. The queue enforces a cool-down, so a
      // film that cannot be prepared reports its reason instead of looping.
      if (wanted && queue.retry(jobId))
        return {
          mode: "prepare",
          assetId: jobId,
          progress: 0,
          reason: "Trying this edition again.",
          phase: "retrying",
        };
      return {
        mode: "unsupported",
        assetId: id,
        reason: preparationFailureReason(job.error_code),
      };
    }
    return {
      mode: "prepare",
      assetId: jobId,
      progress: job.progress,
      reason:
        asset?.state === "streaming"
          ? "Nearly there. Playback starts once enough is ready to play without stopping."
          : job.state === "running"
            ? conversion.copyVideo
              ? "Repackaging your film without changing picture quality."
              : "Creating a browser-compatible edition. This runs in the background; you can return later."
            : "Queued for automatic preparation.",
      phase:
        asset?.state === "streaming"
          ? "buffering"
          : job.state === "running"
            ? conversion.copyVideo
              ? "repackaging"
              : "converting"
            : "queued",
    };
  }
}

/**
 * Whether an edition still being prepared can be watched from `startMs` without
 * the viewer catching up with the encoder. When preparation is faster than
 * playback a short lead is enough. When it is slower, playback may begin once
 * what remains to prepare will be done before the viewer reaches it.
 */
export function playableNow(input: {
  durationMs: number;
  /** Percent of the film prepared so far. */
  progress: number;
  startedAt: number;
  now: number;
  startMs: number;
}): boolean {
  const { durationMs, startMs } = input;
  const available = (input.progress / 100) * durationMs;
  const elapsed = input.now - input.startedAt;
  if (elapsed <= 0 || available <= 0) return false;
  if (available < Math.min(durationMs, startMs + 15000)) return false;
  // Media prepared per unit of real time, since the job began.
  const speed = available / elapsed;
  return (
    speed >= 1.05 || available >= durationMs - speed * (durationMs - startMs)
  );
}
const CAPABILITIES_KEY = "capabilities:web";
/** The capabilities the web player last reported, for planning without a client. */
export function storedCapabilities(
  db: Database,
): ClientCapabilities | undefined {
  const row = db
    .prepare("SELECT value FROM settings WHERE key=?")
    .get(CAPABILITIES_KEY) as { value: string } | undefined;
  const parsed = row && capabilitiesSchema.safeParse(JSON.parse(row.value));
  return parsed?.success ? parsed.data : undefined;
}
export function preparationFailureReason(code: string | null) {
  switch (code) {
    case "media_resources":
      return "Preparation stopped because the server reached a processing limit. This does not mean your film is damaged.";
    case "media_storage":
      return "Preparation stopped because this edition could not fit in the available preparation storage.";
    case "media_source":
      return "Preparation stopped because the connection to Google Drive was interrupted.";
    case "media_timeout":
      return "Preparation took longer than the server's allowed processing time.";
    case "media_unavailable":
      return "The server's media converter is unavailable.";
    case "source_changed":
      return "The source changed during preparation. The library will check the updated file automatically.";
    default:
      return "The server could not finish preparing this edition. This does not necessarily mean the file is damaged or unsupported.";
  }
}

/**
 * Other qualities whose plan is the same as this one's, so would make the
 * very same edition under another name.
 */
function sameEditions(
  probe: Probe,
  quality: Quality,
  plan: ReturnType<typeof conversionPlan>,
  forceFor: (q: Quality) => boolean,
  caps?: readonly string[],
): Array<[Quality, boolean]> {
  const key = JSON.stringify(plan);
  return qualities.flatMap((q): Array<[Quality, boolean]> => {
    if (q === quality) return [];
    try {
      const force = forceFor(q);
      return JSON.stringify(conversionPlan(probe, q, force, caps)) === key
        ? [[q, force]]
        : [];
    } catch {
      return [];
    }
  });
}
