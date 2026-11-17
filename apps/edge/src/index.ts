type Env = {
  RELEASE: string;
  PRIVATE_ORIGIN?: string;
  PRIVATE_ORIGIN_TOKEN?: string;
  PUBLIC_ORIGIN?: string;
};
const headers = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};
function safeOrigin(value: string | undefined) {
  if (!value) return;
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.href === url.origin + "/"
    )
      return url.origin;
  } catch {
    /* An incomplete deployment must stay closed. */
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url),
      path = url.pathname;
    const read = request.method === "GET" || request.method === "HEAD";
    const json = (body: unknown, status = 200) =>
      new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
        status,
        headers,
      });
    const origin = safeOrigin(env.PRIVATE_ORIGIN),
      publicOrigin = safeOrigin(env.PUBLIC_ORIGIN);
    const connected = Boolean(
      origin &&
      publicOrigin &&
      /^[a-f0-9]{64}$/.test(env.PRIVATE_ORIGIN_TOKEN ?? ""),
    );
    if (connected && url.origin !== publicOrigin) {
      if (!read) return json({ error: "canonical_origin_required" }, 403);
      return new Response(null, {
        status: 308,
        headers: { ...headers, Location: publicOrigin + path + url.search },
      });
    }
    if (path === "/version.json" && read)
      return json({
        product: "RAVAN",
        release: env.RELEASE,
        deployment: connected ? "connected" : "frontend",
        streaming: connected ? "automatic" : false,
      });
    if (path.startsWith("/_worker")) return json({ error: "not_found" }, 404);
    if (connected && path.startsWith("/media/")) {
      if (!read) return json({ error: "method_not_allowed" }, 405);
      if (!/^\/media\/s\/[A-Za-z0-9_-]{1,128}\/[^\\]*$/.test(path))
        return json({ error: "not_found" }, 404);
      // The edge issues only a redirect; private video bytes bypass the CDN.
      return new Response(null, {
        status: 307,
        headers: { ...headers, Location: origin + path + url.search },
      });
    }
    if (connected && (/^\/(api|auth)\//.test(path) || path === "/healthz")) {
      try {
        if (
          !new Set([
            "GET",
            "HEAD",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
            "OPTIONS",
          ]).has(request.method)
        )
          return json({ error: "method_not_allowed" }, 405);
        const outgoing = new Headers(request.headers);
        for (const key of [
          "host",
          "forwarded",
          "x-forwarded-host",
          "x-forwarded-for",
          "x-ravan-client-ip",
          "x-forwarded-proto",
          "x-ravan-origin-key",
        ])
          outgoing.delete(key);
        outgoing.set("x-ravan-origin-key", env.PRIVATE_ORIGIN_TOKEN!);
        // Cloudflare replaces this connection header; never trust caller-supplied forwarding headers.
        const clientIp = request.headers.get("cf-connecting-ip") ?? "";
        outgoing.set(
          "x-ravan-client-ip",
          /^[a-fA-F0-9:.]{3,45}$/.test(clientIp) ? clientIp : "0.0.0.0",
        );
        let body: Uint8Array<ArrayBuffer> | undefined;
        if (!read && request.body) {
          const reader = request.body.getReader(),
            chunks: Uint8Array[] = [];
          let size = 0;
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 65536) {
              await reader.cancel();
              return json({ error: "body_too_large" }, 413);
            }
            chunks.push(next.value);
          }
          body = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
          }
          outgoing.delete("content-length");
        }
        const upstream = await fetch(
          new Request(
            origin + (path === "/healthz" ? "/readyz" : path) + url.search,
            {
              method: request.method,
              headers: outgoing,
              body,
              redirect: "manual",
              signal: AbortSignal.timeout(
                /^\/api\/reading\/[A-Za-z0-9_-]+\/content$/.test(path) && read
                  ? 300000
                  : 20000,
              ),
            },
          ),
        );
        const responseHeaders = new Headers(upstream.headers);
        responseHeaders.delete("server");
        responseHeaders.delete("x-powered-by");
        responseHeaders.delete("x-ravan-origin-key");
        responseHeaders.set("Cache-Control", "no-store");
        responseHeaders.set("X-Content-Type-Options", "nosniff");
        responseHeaders.set("Referrer-Policy", "no-referrer");
        return new Response(upstream.body, {
          status: upstream.status,
          headers: responseHeaders,
        });
      } catch {
        return json({ error: "backend_unavailable" }, 503);
      }
    }
    if (path === "/api/session" && read)
      return json({ authenticated: false, configured: false });
    if (path === "/healthz" && read)
      return json({ status: "frontend_ready", streaming: false });
    if (/^\/(api|auth)(\/|$)/.test(path))
      return json({ error: "backend_not_connected" }, 503);
    return json({ error: "not_found" }, 404);
  },
};
