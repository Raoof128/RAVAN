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
    nextPageToken?: string;
    newStartPageToken?: string;
  }>;
}
export class DriveError extends Error {
  constructor(public status: number) {
    super(`Drive request failed (${status})`);
  }
}
const fields =
  "id,name,mimeType,parents,size,version,md5Checksum,trashed,capabilities(canDownload)";
export const driveId = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
export function createDriveClient(
  token: () => Promise<string>,
  fetcher: typeof fetch = fetch,
): DriveClient {
  async function request(
    path: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = new URL(`https://www.googleapis.com/drive/v3/${path}`);
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(15000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetcher(url, {
        headers: { authorization: `Bearer ${await token()}` },
        signal: combined,
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (
          (response.status === 429 || response.status >= 500) &&
          attempt < 2
        ) {
          await delay(250 * 2 ** attempt + Math.random() * 100, undefined, {
            signal,
          });
          continue;
        }
        throw new DriveError(response.status);
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
    throw new Error("Drive retry limit");
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
          changes: z.array(z.unknown()),
          nextPageToken: z.string().optional(),
          newStartPageToken: z.string().optional(),
        })
        .parse(
          await request(
            "changes",
            {
              pageToken: tokenValue,
              pageSize: "1000",
              fields: "nextPageToken,newStartPageToken,changes(fileId,removed)",
              includeRemoved: "true",
              supportsAllDrives: "true",
              includeItemsFromAllDrives: "true",
            },
            signal,
          ),
        );
      return {
        changed: data.changes.length > 0,
        nextPageToken: data.nextPageToken,
        newStartPageToken: data.newStartPageToken,
      };
    },
  };
}
