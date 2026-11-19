import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
const fileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  parents: z.array(z.string()).optional(),
  size: z.string().regex(/^\d+$/).optional(),
  version: z.string().optional(),
  md5Checksum: z.string().optional(),
  headRevisionId: z.string().optional(),
  trashed: z.boolean().optional(),
  capabilities: z.object({ canDownload: z.boolean().optional() }).optional(),
});
export type DriveFile = z.infer<typeof fileSchema>;
export interface DriveClient {
  get(id: string, signal?: AbortSignal): Promise<DriveFile>;
  list(
    parent: string,
    page?: string,
    signal?: AbortSignal,
  ): Promise<{ files: DriveFile[]; nextPageToken?: string }>;
  startToken(signal?: AbortSignal): Promise<string>;
  changes(
    token: string,
    signal?: AbortSignal,
  ): Promise<{
    changed: boolean;
    /**
     * What changed, when the client can say. The feed covers the whole Drive, so
     * without this any edit anywhere counts as a change to the library.
     */
    items?: Array<{ fileId: string; parents?: string[] }>;
    nextPageToken?: string;
    newStartPageToken?: string;
  }>;
}
export class DriveError extends Error {
  constructor(public status: number) {
    super(`Drive request failed (${status})`);
  }
}
/**
 * Drive answers 403 both for "you may not read this" and for "slow down": a
 * usage limit comes back as 403 with the domain "usageLimits" as well as 429.
 * Read as a refusal, a busy minute at Google looked like a film that had been
 * removed, which ends playback and can close the whole library. Consumes the
 * body. Anything that cannot be read as a usage limit stays a refusal.
 */
export async function usageLimited(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  const reader = response.body?.getReader();
  if (!reader) return false;
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 64 * 1024) return false;
      chunks.push(chunk.value);
    }
    const body = z
      .object({
        error: z.object({
          errors: z
            .array(z.object({ domain: z.string().optional() }))
            .optional(),
          status: z.string().optional(),
        }),
      })
      .safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    // Google's newer error shape names a limit by status, not domain.
    return (
      body.success &&
      (body.data.error.status === "RESOURCE_EXHAUSTED" ||
        (body.data.error.errors ?? []).some((e) => e.domain === "usageLimits"))
    );
  } catch {
    return false;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
const fields =
  "id,name,mimeType,parents,size,version,md5Checksum,headRevisionId,trashed,capabilities(canDownload)";
export const driveId = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
/** Attempts for a rate-limited Drive request, with Google's backoff. */
export const DRIVE_RATE_LIMIT_ATTEMPTS = 5;
export function createDriveClient(
  token: () => Promise<string>,
  fetcher: typeof fetch = fetch,
  rateLimitDelayMs = 1000,
): DriveClient {
  async function request(
    path: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = new URL(`https://www.googleapis.com/drive/v3/${path}`);
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    let failures = 0,
      limits = 0;
    for (;;) {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(15000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetcher(url, {
        headers: { authorization: `Bearer ${await token()}` },
        signal: combined,
        redirect: "error",
      });
      if (!response.ok) {
        const status = (await usageLimited(response)) ? 429 : response.status;
        if (response.status !== 403) await response.body?.cancel();
        // Rate limits: min(2^n s + up to 1 s, 32 s), as Google recommends.
        // Server errors keep a short retry so playback checks stay quick.
        if (status === 429 && ++limits < DRIVE_RATE_LIMIT_ATTEMPTS) {
          await delay(
            Math.min(
              rateLimitDelayMs * 2 ** (limits - 1) +
                Math.random() * rateLimitDelayMs,
              32000,
            ),
            undefined,
            { signal },
          );
          continue;
        }
        if (status >= 500 && ++failures < 3) {
          await delay(
            250 * 2 ** (failures - 1) + Math.random() * 100,
            undefined,
            {
              signal,
            },
          );
          continue;
        }
        throw new DriveError(status);
      }
      // Bound decoded response size even when the server omits Content-Length.
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Empty Drive response");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > 8 * 1024 * 1024)
            throw new Error("Drive response too large");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    }
  }
  return {
    async get(id, signal) {
      return fileSchema.parse(
        await request(
          `files/${driveId.parse(id)}`,
          { fields, supportsAllDrives: "true" },
          signal,
        ),
      );
    },
    async list(parent, page, signal) {
      return z
        .object({
          files: z.array(fileSchema),
          nextPageToken: z.string().optional(),
        })
        .parse(
          await request(
            "files",
            {
              q: `'${driveId.parse(parent)}' in parents and trashed = false`,
              fields: `nextPageToken,files(${fields})`,
              pageSize: "1000",
              supportsAllDrives: "true",
              includeItemsFromAllDrives: "true",
              ...(page ? { pageToken: page } : {}),
            },
            signal,
          ),
        );
    },
    async startToken(signal) {
      return z
        .object({ startPageToken: z.string() })
        .parse(await request("changes/startPageToken", {}, signal))
        .startPageToken;
    },
    async changes(tokenValue, signal) {
      const data = z
        .object({
          changes: z.array(
            z.object({
              fileId: z.string().optional(),
              file: z
                .object({ parents: z.array(z.string()).optional() })
                .optional(),
            }),
          ),
          nextPageToken: z.string().optional(),
          newStartPageToken: z.string().optional(),
        })
        .parse(
          await request(
            "changes",
            {
              pageToken: tokenValue,
              pageSize: "1000",
              fields:
                "nextPageToken,newStartPageToken,changes(fileId,removed,file(parents))",
              includeRemoved: "true",
              supportsAllDrives: "true",
              includeItemsFromAllDrives: "true",
            },
            signal,
          ),
        );
      return {
        changed: data.changes.length > 0,
        // A change without a file id cannot be placed; report it as unplaceable.
        items: data.changes.map((change) => ({
          fileId: change.fileId ?? "",
          ...(change.file?.parents ? { parents: change.file.parents } : {}),
        })),
        nextPageToken: data.nextPageToken,
        newStartPageToken: data.newStartPageToken,
      };
    },
  };
}
