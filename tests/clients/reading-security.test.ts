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

it("keeps a chapter's language, direction and table spans", () => {
  const safe = sanitizeChapter(
    `<p lang="ar" dir="rtl">مرحبا</p><table><tr><td colspan="2" rowspan="3">Cell</td></tr></table><p dir="javascript:alert(1)">x</p>`,
    new Set(),
  );
  const doc = new DOMParser().parseFromString(safe, "text/html");
  const p = doc.querySelector("p")!;
  expect(p.getAttribute("lang")).toBe("ar");
  expect(p.getAttribute("dir")).toBe("rtl");
  const td = doc.querySelector("td")!;
  expect(td.getAttribute("colspan")).toBe("2");
  expect(td.getAttribute("rowspan")).toBe("3");
  // Attribute values stay text; nothing becomes a link or script.
  expect(safe).not.toMatch(/<a|<script|href|on\w+=/i);
});
