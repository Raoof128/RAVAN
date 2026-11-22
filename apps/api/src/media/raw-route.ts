import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { SourceRef } from "../../../../packages/contracts/src/index.js";
import type { BlockCache } from "./cache.js";
import { parseRange } from "./ranges.js";
export async function sendRaw(
  request: FastifyRequest,
  reply: FastifyReply,
  source: SourceRef,
  cache: Pick<BlockCache, "readSource">,
  authorize: () => Promise<void>,
  mime = "video/mp4",
) {
  const size = BigInt(source.sizeBytes);
  const etag = `"${source.generation}"`;
  const matches =
    !request.headers["if-range"] || request.headers["if-range"] === etag;
  const range = parseRange(
    request.method === "HEAD" || !matches ? undefined : request.headers.range,
    size,
  );
  reply.header("Accept-Ranges", "bytes").header("ETag", etag);
  if (range.kind === "invalid")
    return reply.code(400).send({ error: "invalid_range" });
  if (range.kind === "unsatisfiable")
    return reply.header("Content-Range", `bytes */${size}`).code(416).send();
  const start = range.kind === "partial" ? range.start : 0n;
  const end = range.kind === "partial" ? range.end : size - 1n;
  await authorize();
  // Fastify's automatic HEAD hook overwrites undefined payload length. An empty
  // stream preserves our explicit metadata without reading source bytes.
  if (request.method === "HEAD" || size === 0n)
    return reply
      .header("Content-Length", size.toString())
      .type(mime)
      .send(Readable.from([]));
  const controller = new AbortController();
  const abort = () => controller.abort();
  // A healthy open-ended response may last a whole film. Bound revocation
  // exposure instead of imposing a total response lifetime.
  let checking = false;
  const authorizationCheck = setInterval(() => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    void authorize()
      .catch(abort)
      .finally(() => {
        checking = false;
      });
  }, 10000);
  authorizationCheck.unref();
  reply.raw.once("close", abort);
  const cleanup = () => {
    clearInterval(authorizationCheck);
    reply.raw.removeListener("close", abort);
  };
  const iterator = cache
    .readSource(source, start, end, controller.signal)
    [Symbol.asyncIterator]();
  let first: IteratorResult<Uint8Array>;
  try {
    first = await iterator.next();
    await authorize();
  } catch {
    controller.abort();
    cleanup();
    await iterator.return?.();
    return reply.code(502).send({ error: "source_unavailable" });
  }
  if (range.kind === "partial")
    reply.code(206).header("Content-Range", `bytes ${start}-${end}/${size}`);
  reply.header("Content-Length", (end - start + 1n).toString()).type(mime);
  async function* stream() {
    let complete = false;
    try {
      if (!first.done) yield first.value;
      while (true) {
        controller.signal.throwIfAborted();
        await authorize();
        const next = await iterator.next();
        if (next.done) break;
        yield next.value;
      }
      complete = true;
    } finally {
      // Aborting destroys the body. After the last chunk that would race its
      // delivery: a final chunk that filled the stream's buffer (64 KiB) was
      // dropped and the response never finished.
      if (!complete) controller.abort();
      await iterator.return?.();
      cleanup();
    }
  }
  const body = Readable.from(stream(), {
    objectMode: false,
    highWaterMark: 64 * 1024,
  });
  controller.signal.addEventListener("abort", () => body.destroy(), {
    once: true,
  });
  body.once("close", cleanup);
  return reply.send(body);
}
