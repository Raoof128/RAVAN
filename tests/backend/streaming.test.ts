import { expect, it } from "vitest";
import { DriveSourceReader } from "../../apps/api/src/media/source-stream.js";
const ref = { fileId: "one", generation: "abc", sizeBytes: "10" };
it("reads exact ranges and rejects an upstream that ignores range", async () => {
  const reader = new DriveSourceReader(
    async () => "token",
    async () => ref,
    async (_url, init) => {
      expect(new Headers(init?.headers).get("Range")).toBe("bytes=2-5");
      return new Response("2345", {
        status: 206,
        headers: { "Content-Range": "bytes 2-5/10" },
      });
    },
  );
  expect(
    Buffer.from(
      await reader.block(ref, 2n, 5n, new AbortController().signal),
    ).toString(),
  ).toBe("2345");
  const bad = new DriveSourceReader(
    async () => "token",
    async () => ref,
    async () => new Response("0123456789"),
  );
  await expect(
    bad.block(ref, 2n, 5n, new AbortController().signal),
  ).rejects.toThrow(/range/i);
});
it("rejects replacement and truncated source bytes", async () => {
  const replaced = new DriveSourceReader(
    async () => "token",
    async () => ({ ...ref, generation: "new" }),
    async () =>
      new Response("2345", {
        status: 206,
        headers: { "Content-Range": "bytes 2-5/10" },
      }),
  );
  await expect(
    replaced.block(ref, 2n, 5n, new AbortController().signal),
  ).rejects.toThrow(/changed/);
  const short = new DriveSourceReader(
    async () => "token",
    async () => ref,
    async () =>
      new Response("23", {
        status: 206,
        headers: { "Content-Range": "bytes 2-5/10" },
      }),
  );
  await expect(
    short.block(ref, 2n, 5n, new AbortController().signal),
  ).rejects.toThrow(/length/i);
});
it("propagates client cancellation to the upstream request", async () => {
  const controller = new AbortController();
  let aborted = false;
  const reader = new DriveSourceReader(
    async () => "token",
    async () => ref,
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
        controller.abort();
      }),
  );
  await expect(reader.block(ref, 0n, 3n, controller.signal)).rejects.toThrow();
  expect(aborted).toBe(true);
});

it("serves HTTP 200/206/416/HEAD and ignores a stale If-Range", async () => {
  const { default: Fastify } = await import("fastify");
  const { sendRaw } = await import("../../apps/api/src/media/raw-route.js");
  const app = Fastify();
  const cache = {
    async *readSource(_ref: typeof ref, start: bigint, end: bigint) {
      yield Buffer.from("0123456789").subarray(Number(start), Number(end) + 1);
    },
  };
  app.get("/", (request, reply) =>
    sendRaw(request, reply, ref, cache, async () => {}),
  );
  try {
    const partial = await app.inject({
      url: "/",
      headers: { range: "bytes=2-5" },
    });
    expect(partial.statusCode).toBe(206);
    expect(partial.body).toBe("2345");
    expect(partial.headers["content-range"]).toBe("bytes 2-5/10");
    const full = await app.inject({
      url: "/",
      headers: { range: "bytes=2-5", "if-range": '"stale"' },
    });
    expect(full.statusCode).toBe(200);
    expect(full.body).toBe("0123456789");
    const head = await app.inject({ method: "HEAD", url: "/" });
    expect(head.body).toBe("");
    expect(head.headers["content-length"]).toBe("10");
    const outside = await app.inject({
      url: "/",
      headers: { range: "bytes=10-" },
    });
    expect(outside.statusCode).toBe(416);
    expect(outside.headers["content-range"]).toBe("bytes */10");
  } finally {
    await app.close();
  }
});
it("does not emit a success header when the first source read fails", async () => {
  const { default: Fastify } = await import("fastify");
  const { sendRaw } = await import("../../apps/api/src/media/raw-route.js");
  const app = Fastify();
  const cache = {
    readSource() {
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
          throw new Error("upstream");
        },
      };
    },
  };
  app.get("/", (request, reply) =>
    sendRaw(request, reply, ref, cache, async () => {}),
  );
  try {
    expect((await app.inject("/")).statusCode).toBe(502);
  } finally {
    await app.close();
  }
});

it("keeps a healthy slow response open beyond the former total-response deadline", async () => {
  const { vi } = await import("vitest");
  const { default: Fastify } = await import("fastify");
  const { sendRaw } = await import("../../apps/api/src/media/raw-route.js");
  const nativeTimeout = globalThis.setTimeout;
  const timer = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation(((
      callback: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) =>
      nativeTimeout(
        callback,
        ms === 120000 ? 30 : ms,
        ...args,
      )) as typeof setTimeout);
  const app = Fastify();
  const cache = {
    async *readSource() {
      for (const byte of "01234567") {
        await new Promise((resolve) => nativeTimeout(resolve, 12));
        yield Buffer.from(byte);
      }
    },
  };
  app.get("/", (request, reply) =>
    sendRaw(request, reply, { ...ref, sizeBytes: "8" }, cache, async () => {}),
  );
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(address);
    expect(response.headers.get("content-length")).toBe("8");
    expect(await response.text()).toBe("01234567");
  } finally {
    timer.mockRestore();
    await app.close();
  }
});
