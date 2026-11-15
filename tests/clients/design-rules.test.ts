import { expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createApiClient } from "../../packages/client/src/api.js";
import {
  forgetLibrary,
  recallLibrary,
  rememberLibrary,
} from "../../apps/web/src/libraryCache.js";

afterEach(() => vi.useRealTimers());
const sheets = [
  "packages/ui/src/tokens.css",
  "apps/web/src/cinema.css",
  "packages/ui/src/loading.css",
].map((path) => [path, readFileSync(path, "utf8")] as const);
const declarations = (css: string, property: RegExp) =>
  Array.from(css.matchAll(/(?<![-\w])([\w-]+)\s*:\s*([^;{}]+);/g))
    .filter((m) => property.test(m[1]!))
    .map((m) => m[2]!.trim());

it("sets every type size in rem, so the reader's text-size setting applies", () => {
  for (const [path, css] of sheets) {
    const fixed = declarations(css, /^(font-size|font)$/).filter(
      // The one exception keeps iOS from zooming a focused field.
      (value) => /\dpx/.test(value) && value !== "max(16px, 1rem)",
    );
    expect(fixed, path).toEqual([]);
  }
  expect(sheets[0]![1]).toMatch(/:root \{[^}]*font-size: 93\.75%;/);
});

it("draws text in named colours, not one-off values", () => {
  // Text over artwork and the poster family carry their own colours.
  const allowed = new Set(["#f3ead9", "#243e46", "#302a29", "#eed6bd"]);
  for (const [path, css] of sheets) {
    const raw = declarations(css, /^color$/).filter(
      (value) => /^#[0-9a-f]{6}$/i.test(value) && !allowed.has(value),
    );
    expect(raw.length, `${path}: ${raw.join(" ")}`).toBeLessThanOrEqual(4);
  }
});

it("keeps what the TV loads within Chromium 79", () => {
  for (const path of ["apps/tv/src/tv.css", "packages/ui/src/loading.css"]) {
    const css = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // "aspect-ratio: auto" only resets a shared rule and is ignored there.
    expect(css, path).not.toMatch(
      /aspect-ratio:(?!\s*auto)|:focus-visible|:is\(|:where\(/,
    );
    // Flex gap is unsupported there. Grid gap works, and "gap: 0" is a reset.
    const flexGaps = Array.from(css.matchAll(/([^{}]+)\{([^}]*\bgap:[^}]*)\}/g))
      .filter(
        (m) => !/display:\s*grid/.test(m[2]!) && !/\bgap:\s*0;/.test(m[2]!),
      )
      .map((m) => m[1]!.trim());
    expect(flexGaps, path).toEqual([]);
  }
});

it("recalls a library view for five minutes and forgets it on request", () => {
  vi.useFakeTimers();
  const api = createApiClient(""),
    other = createApiClient("");
  const view = {
    query: "night",
    items: [{ id: "a", title: "A", resumeMs: 0, available: true }],
    cursor: null,
  };
  expect(recallLibrary(api, false)).toBeUndefined();
  rememberLibrary(api, false, view);
  expect(recallLibrary(api, false)).toMatchObject(view);
  // The watchlist and another client have their own.
  expect(recallLibrary(api, true)).toBeUndefined();
  expect(recallLibrary(other, false)).toBeUndefined();
  vi.advanceTimersByTime(5 * 60 * 1000 + 1);
  expect(recallLibrary(api, false)).toBeUndefined();
  rememberLibrary(api, false, view);
  forgetLibrary(api);
  expect(recallLibrary(api, false)).toBeUndefined();
});
