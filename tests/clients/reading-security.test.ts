// @vitest-environment jsdom
import { expect, it } from "vitest";
import { sanitizeChapter } from "../../apps/web/src/reading/book.js";
import {
  resolveResource,
  safeArchivePath,
} from "../../apps/web/src/reading/archive.js";

it("removes executable markup, outbound requests, forms, CSS and unowned image URLs", () => {
  const safe = sanitizeChapter(
    `<h1 id="main">Story</h1><script>alert(1)</script><img src="https://evil.test/pixel" onerror="alert(1)"><img src="blob:secret"><img src="blob:owned"><iframe src="/api/session"></iframe><style>body{display:none}</style><p style="background:url(https://evil.test)">Text</p><a href="javascript:alert(1)">Link</a><form action="/api/logout"><button>Send</button></form><svg onload="alert(1)"></svg>`,
    new Set(["blob:owned"]),
  );
  expect(safe).toContain("Story");
  expect(safe).toContain("Text");
  expect(safe).toContain('src="blob:owned"');
  expect(safe).not.toMatch(
    /script|iframe|style=|<style|onerror|onload|<form|<button|<svg|href=|https:|blob:secret|id=/,
  );
});
it("resolves only archive-local EPUB references and rejects ambiguous archive paths", () => {
  expect(resolveResource("OPS/text/chapter.xhtml", "../images/cover.png")).toBe(
    "OPS/images/cover.png",
  );
  for (const path of [
    "https://evil.test",
    "//evil.test/file",
    "../../outside.png",
    "%2fetc/passwd",
    "%5cwindows",
    "javascript:alert(1)",
  ])
    expect(resolveResource("OPS/book.xhtml", path), path).toBeUndefined();
  for (const path of ["../file", "/absolute", "C:\\file", "a/../b", "a\u0000b"])
    expect(safeArchivePath(path), path).toBe(false);
});
