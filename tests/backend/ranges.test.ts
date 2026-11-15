import { expect, it } from "vitest";
import { parseRange } from "../../apps/api/src/media/ranges.js";
it.each([
  [undefined, 10n, { kind: "full" }],
  ["bytes=-4", 10n, { kind: "partial", start: 6n, end: 9n }],
  ["bytes=2-", 10n, { kind: "partial", start: 2n, end: 9n }],
  ["bytes=10-", 10n, { kind: "unsatisfiable" }],
  ["bytes=0-1,4-5", 10n, { kind: "full" }],
  ["bytes=0-99", 10n, { kind: "partial", start: 0n, end: 9n }],
  ["bytes=0-0", 0n, { kind: "unsatisfiable" }],
  ["bytes=-0", 10n, { kind: "unsatisfiable" }],
  ["bytes=4-2", 10n, { kind: "invalid" }],
  ["bytes=oops", 10n, { kind: "invalid" }],
  ["bytes=0-1,bad", 10n, { kind: "invalid" }],
  [
    "bytes=9007199254740993-",
    9007199254740995n,
    { kind: "partial", start: 9007199254740993n, end: 9007199254740994n },
  ],
] as const)("parses %s at size %s", (header, size, result) =>
  expect(parseRange(header, size)).toEqual(result),
);
