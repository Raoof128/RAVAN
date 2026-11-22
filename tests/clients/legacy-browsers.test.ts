// The web client once shipped `?.`, `??` and `||=` in its entry script, so an
// LG C1 (webOS 6, Chromium 79) could not parse it and showed an empty page.
// Build both clients and check what an old browser would be asked to run.
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain JavaScript script without declarations
import { checkLegacyBrowsers } from "../../scripts/check-legacy-browsers.mjs";

const root = resolve(import.meta.dirname, "../..");
const out = mkdtempSync(join(tmpdir(), "ravan-legacy-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

function build(app: string) {
  const dir = join(out, app);
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules/vite/bin/vite.js"),
      "build",
      "--outDir",
      dir,
      "--emptyOutDir",
      "--logLevel",
      "error",
    ],
    {
      cwd: join(root, "apps", app),
      stdio: "pipe",
      // Vitest sets NODE_ENV=test, which would build React's development copy.
      env: { ...process.env, NODE_ENV: "production" },
    },
  );
  return dir;
}

describe("clients on Chromium 79 (LG C1)", () => {
  it("web and TV builds hold no syntax or missing functions Chromium 79 lacks", () => {
    const dirs = [build("web"), build("tv")];
    expect(checkLegacyBrowsers(dirs)).toEqual([]);
  }, 120_000);

  it("the checker catches the syntax that blanked the page", () => {
    const dir = mkdtempSync(join(out, "bad-"));
    const file = join(dir, "index-x.js");
    writeFileSync(file, "let a=b?.c??d;a||=1;");
    expect(checkLegacyBrowsers([dir]).sort()).toEqual([
      "index-x.js: ?. (Chrome 80)",
      "index-x.js: ?? (Chrome 80)",
      "index-x.js: logical assignment (Chrome 85)",
    ]);
  });

  it("the checker catches CSS rules Chromium 79 would drop whole", () => {
    const dir = mkdtempSync(join(out, "css-"));
    writeFileSync(
      join(dir, "a.css"),
      ".a:is(b,c){color:red}.x:hover,.x:focus-visible{top:0}.y:focus-visible{top:0}body:has(.z) .h{display:none}",
    );
    expect(checkLegacyBrowsers([dir]).sort()).toEqual([
      'a.css: :focus-visible (Chrome 86) in ".x:hover,.x:focus-visible"',
      'a.css: :has() (Chrome 105) in "body:has(.z) .h"',
      'a.css: :is() (Chrome 88) in ".a:is(b,c)"',
    ]);
  });

  it("posters keep their height where aspect-ratio is missing", () => {
    const dir = join(out, "web", "assets");
    const css = readdirSync(dir)
      .filter((name) => name.endsWith(".css"))
      .map((name) => readFileSync(join(dir, name), "utf8"))
      .join("\n");
    expect(css).toMatch(
      /@supports not \(aspect-ratio:\s*1\)\s*\{\s*\.poster:before\s*\{[^}]*padding-top:\s*150%/,
    );
  });
});

describe("filled-in abort functions", () => {
  it("stand in for Chromium 79's missing ones and leave native ones alone", async () => {
    const statics = AbortSignal as unknown as Record<string, unknown>;
    const proto = AbortSignal.prototype as unknown as Record<string, unknown>;
    const saved = {
      any: statics.any,
      timeout: statics.timeout,
      throwIfAborted: proto.throwIfAborted,
    };
    try {
      delete statics.any;
      delete statics.timeout;
      delete proto.throwIfAborted;
      vi.resetModules();
      await import("../../packages/client/src/legacy.js");
      expect(statics.any).not.toBe(saved.any);

      const a = new AbortController();
      const b = new AbortController();
      const both = AbortSignal.any([a.signal, b.signal]);
      expect(both.aborted).toBe(false);
      expect(() => both.throwIfAborted()).not.toThrow();
      b.abort();
      expect(both.aborted).toBe(true);
      expect(() => both.throwIfAborted()).toThrow();

      const already = new AbortController();
      already.abort();
      expect(AbortSignal.any([already.signal]).aborted).toBe(true);

      const timed = AbortSignal.timeout(5);
      await new Promise((done) => setTimeout(done, 30));
      expect(timed.aborted).toBe(true);
    } finally {
      statics.any = saved.any;
      statics.timeout = saved.timeout;
      proto.throwIfAborted = saved.throwIfAborted;
    }
    vi.resetModules();
    await import("../../packages/client/src/legacy.js");
    expect(statics.any).toBe(saved.any);
  });
});
