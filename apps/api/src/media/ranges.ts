import type { RangeDecision } from "../../../../packages/contracts/src/index.js";
export function parseRange(
  header: string | undefined,
  size: bigint,
): RangeDecision {
  if (!header) return { kind: "full" };
  if (header.length > 1024 || !header.startsWith("bytes="))
    return { kind: "invalid" };
  const parts = header
    .slice(6)
    .split(",")
    .map((s) => s.trim());
  if (parts.some((s) => !/^\d*-\d*$/.test(s) || s === "-"))
    return { kind: "invalid" };
  for (const part of parts) {
    const [a, b] = part.split("-");
    if (a && b && BigInt(a) > BigInt(b)) return { kind: "invalid" };
  }
  if (parts.length > 1) return { kind: "full" };
  const [left, right] = parts[0]!.split("-");
  if (size === 0n) return { kind: "unsatisfiable" };
  if (!left) {
    const count = BigInt(right!);
    return count === 0n
      ? { kind: "unsatisfiable" }
      : {
          kind: "partial",
          start: count >= size ? 0n : size - count,
          end: size - 1n,
        };
  }
  const start = BigInt(left);
  if (start >= size) return { kind: "unsatisfiable" };
  const requested = right ? BigInt(right) : size - 1n;
  return {
    kind: "partial",
    start,
    end: requested >= size ? size - 1n : requested,
  };
}
