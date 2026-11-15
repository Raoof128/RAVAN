import type { Probe } from "../../../worker/src/probe.js";
import { profiles } from "./profiles.js";
import { conversionPlan } from "../../../worker/src/compatibility.js";
import { assetId } from "../../../worker/src/prepared-store.js";
import type { Database } from "../../../../packages/db/src/open.js";
import type {
  SourceRef,
  DeviceProfile,
  PlaybackPlan,
  PlaybackOptions,
} from "../../../../packages/contracts/src/index.js";
import { JobQueue } from "../../../worker/src/leases.js";
export function choosePlayback(
  probe: Probe,
  profile: string,
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
  if (
    probe.container.includes("mp4") &&
    v.codec === "h264" &&
    v.pixelFormat === "yuv420p" &&
    !v.hdr &&
    v.width <= bounds.maxWidth &&
    v.height <= bounds.maxHeight &&
    probe.audio.length <= 1 &&
    probe.audio.every((a) => a.codec === "aac" && a.channels <= 2) &&
    probe.subtitles.length === 0
  )
    return { mode: "direct" };
  return { mode: "prepare", reason: "Preparing a compatible browser edition." };
}
export class MediaPlanner {
  constructor(
    private db: Database,
    private workerConfigured: boolean,
    private preparedDir?: string,
  ) {}
  async planPlayback(
    source: SourceRef,
    profile: DeviceProfile,
    options: PlaybackOptions = {},
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
    const queue = new JobQueue(this.db);
    if (
      !record ||
      record.generation !== source.generation ||
      (this.preparedDir && record.version !== 2)
    ) {
      if (!this.workerConfigured)
        return {
          mode: "unsupported",
          assetId: source.fileId,
          reason: "The media worker is unavailable.",
        };
      const jobId = queue.enqueue(
        "probe",
        `probe-v2:${source.fileId}:${source.generation}`,
        source,
      );
      const job = this.db
        .prepare("SELECT state FROM jobs WHERE id=?")
        .get(jobId) as { state: string };
      return job.state === "failed"
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
    const preferred = probe.audio.findIndex((a) => a.language === language);
    const audio = options.audioTrack ?? Math.max(0, preferred);
    if (audio >= Math.max(1, probe.audio.length))
      return {
        mode: "unsupported",
        assetId: source.fileId,
        reason: "That audio track is unavailable.",
      };
    const choice = choosePlayback(probe, profile.id);
    if (choice.mode === "unsupported")
      return { ...choice, assetId: source.fileId };
    const forceEncode =
      options.forceCompatible ||
      (quality === "auto" && Number(source.sizeBytes) > 16 * 1024 ** 3);
    let conversion;
    try {
      conversion = conversionPlan(probe, quality, forceEncode);
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
    const id = assetId(
      source.fileId,
      source.generation,
      quality,
      audio,
      forceEncode,
    );
    const asset = this.db
      .prepare("SELECT state,label FROM prepared_assets WHERE id=?")
      .get(id) as { state: string; label: string } | undefined;
    if (asset?.state === "ready") {
      if (!background)
        this.db
          .prepare("UPDATE prepared_assets SET last_used=? WHERE id=?")
          .run(Date.now(), id);
      return { mode: "prepared", assetId: id, label: asset.label };
    }
    // An evicted background rendition stays evicted until the viewer asks for it.
    // Otherwise a library larger than the cache would re-encode forever.
    if (background && asset?.state === "evicted")
      return {
        mode: "unsupported",
        assetId: id,
        reason: "Prepared edition reclaimed; play to prepare again.",
      };
    this.db
      .prepare(
        "INSERT OR IGNORE INTO prepared_assets(id,source_id,generation,quality,audio_track,last_used) VALUES(?,?,?,?,?,?)",
      )
      .run(id, source.fileId, source.generation, quality, audio, Date.now());
    const jobId = queue.enqueue("browser-prepare", `browser:${id}`, {
      source,
      quality,
      audio,
      forceEncode: forceEncode ?? false,
      id,
    });
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
    if (job.state === "failed")
      return {
        mode: "unsupported",
        assetId: id,
        reason: preparationFailureReason(job.error_code),
      };
    return {
      mode: "prepare",
      assetId: jobId,
      progress: job.progress,
      reason:
        job.state === "running"
          ? conversion.copyVideo
            ? "Repackaging your film without changing picture quality."
            : "Creating a browser-compatible edition. This runs in the background; you can return later."
          : "Queued for automatic preparation.",
    };
  }
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
