/**
 * Whether two language codes name the same language. Films carry three-letter
 * codes ("eng", "fas", "per"); people type two-letter ones ("en", "fa"). The
 * server and its clients must agree on this, or the language the player shows
 * is not the one the server prepared: compare by the language's name.
 */
const names = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" });
  } catch {
    return undefined;
  }
})();
function key(code: unknown) {
  if (typeof code !== "string") return "";
  const plain = code.trim().toLowerCase();
  if (!plain || plain === "und" || plain === "off" || plain === "original")
    return "";
  try {
    return (names?.of(plain) ?? plain).toLowerCase();
  } catch {
    return plain;
  }
}
export function sameLanguage(a: unknown, b: unknown) {
  const left = key(a);
  return left !== "" && left === key(b);
}
