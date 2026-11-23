import { APPLE_MP4_RECIPE } from "../../../worker/src/prepared-store.js";
import { createHash } from "node:crypto";
import type { Database } from "../../../../packages/db/src/open.js";
import type {
  PlaybackOptions,
  SourceRef,
} from "../../../../packages/contracts/src/index.js";
import type { Principal } from "../sessions/devices.js";
import type { MediaPlanner } from "./planner.js";

function ownerKey(who: Principal) {
  if (who.deviceId) return "device:" + who.deviceId;
  if (who.webHash) return "owner:" + who.webHash;
  throw Error("Unauthenticated");
}

export function rememberPreparation(
  db: Database,
  who: Principal,
  movieId: string,
  editionId: string,
  source: SourceRef,
  options: PlaybackOptions,
  jobId: string,
) {
  const principal = ownerKey(who);
  const choices = JSON.stringify({
    quality: options.quality ?? "auto",
    audioTrack: options.audioTrack,
    forceCompatible: options.forceCompatible ?? false,
  });
  const id = createHash("sha256")
    .update(
      JSON.stringify([
        APPLE_MP4_RECIPE,
        principal,
        movieId,
        editionId,
        source.fileId,
        source.generation,
        choices,
      ]),
    )
    .digest("hex");
  db.transaction(() => {
    db.prepare(
      `INSERT INTO native_preparations(id,principal,movie_id,edition_id,source_id,generation,options,job_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET job_id=excluded.job_id,direct=0,failure=NULL,created_at=excluded.created_at`,
    ).run(
      id,
      principal,
      movieId,
      editionId,
      source.fileId,
      source.generation,
      choices,
      jobId,
      Date.now(),
    );
    // Keep recent job history bounded even for repeatedly changed selections.
    db.prepare(
      "DELETE FROM native_preparations WHERE principal=? AND id IN (SELECT id FROM native_preparations WHERE principal=? ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET 100)",
    ).run(principal, principal);
  })();
  return id;
}

export function preparationStatus(db: Database, who: Principal, id: string) {
  const row = db
    .prepare(
      `SELECT p.direct,p.failure,s.available,j.kind,j.state,j.progress,j.error_code,a.state asset_state
    FROM native_preparations p LEFT JOIN editions e ON e.id=p.edition_id AND e.movie_id=p.movie_id AND e.generation=p.generation AND e.source_id=p.source_id
    LEFT JOIN source_files s ON s.id=e.source_id AND s.generation=p.generation AND s.movie_id=p.movie_id
    LEFT JOIN jobs j ON j.id=p.job_id LEFT JOIN prepared_assets a ON a.id=json_extract(j.payload,'$.id') AND a.source_id=p.source_id AND a.generation=p.generation
    WHERE p.id=? AND p.principal=?`,
    )
    .get(id, ownerKey(who)) as
    | {
        direct: number;
        failure: string | null;
        available: number | null;
        kind: string | null;
        state: string | null;
        progress: number;
        error_code: string | null;
        asset_state: string | null;
      }
    | undefined;
  if (!row) return;
  if (!row.available)
    return { state: "invalidated", reasonCode: "source_changed" };
  if (row.direct) return { state: "ready" };
  if (row.failure || row.state === "failed")
    return {
      state: "failed",
      reasonCode: row.failure ?? row.error_code ?? "media_failed",
    };
  if (
    !row.state ||
    (row.kind !== "probe" &&
      row.state === "completed" &&
      row.asset_state !== "ready")
  )
    return { state: "evicted" };
  if (row.kind === "probe")
    return { state: row.state === "queued" ? "queued" : "probing" };
  if (row.state === "completed" && row.asset_state === "ready")
    return { state: "ready" };
  return row.state === "running"
    ? {
        state: "preparing",
        progressPercent: Math.min(100, Math.max(0, row.progress)),
      }
    : { state: "queued" };
}

// A cold request initially names the probe job. Once it completes, only the
// worker advances it to the requested output. A status GET never enqueues or plays.
export async function advanceNativePreparations(
  db: Database,
  planner: MediaPlanner,
) {
  const rows = db
    .prepare(
      `SELECT p.id,p.principal,p.options,j.id jobId,s.id fileId,s.generation,s.size_bytes sizeBytes
    FROM native_preparations p JOIN jobs j ON j.id=p.job_id AND j.kind='probe' AND j.state='completed'
    JOIN editions e ON e.id=p.edition_id AND e.movie_id=p.movie_id AND e.source_id=p.source_id AND e.generation=p.generation
    JOIN source_files s ON s.id=e.source_id AND s.generation=p.generation AND s.movie_id=p.movie_id AND s.available=1
    WHERE p.direct=0 AND p.failure IS NULL
      AND (EXISTS(SELECT 1 FROM devices d WHERE p.principal='device:'||d.id AND d.revoked_at IS NULL)
           OR EXISTS(SELECT 1 FROM web_sessions w WHERE p.principal='owner:'||w.token_hash AND w.expires_at>?))
    LIMIT 64`,
    )
    .all(Date.now()) as Array<
    SourceRef & {
      id: string;
      principal: string;
      options: string;
      jobId: string;
    }
  >;
  for (const row of rows) {
    const result = await planner.planPlayback(
      {
        fileId: row.fileId,
        generation: row.generation,
        sizeBytes: row.sizeBytes,
      },
      { id: "apple-sdr-v1", platform: "apple", verified: false },
      {
        ...JSON.parse(row.options),
        screen: row.principal.startsWith("device:"),
      },
    );
    if (result.mode === "unsupported" && result.waitingForCapacity) continue;
    // Prepared cache hits can have a different logical quality name. Resolve
    // their committed conversion job, so eviction remains visible after restart.
    const job =
      result.mode === "prepared"
        ? (db
            .prepare("SELECT id FROM jobs WHERE unique_key=?")
            .get("browser:" + result.assetId) as { id: string } | undefined)
        : undefined;
    db.prepare(
      "UPDATE native_preparations SET job_id=?,direct=?,failure=? WHERE id=? AND job_id=?",
    ).run(
      job?.id ?? result.assetId,
      Number(result.mode === "direct"),
      result.mode === "unsupported" ? "media_unsupported" : null,
      row.id,
      row.jobId,
    );
  }
}
