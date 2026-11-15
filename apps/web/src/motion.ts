/**
 * The owner's "reduce interface motion" preference, applied to the document.
 * The system setting is honoured by the stylesheets on its own; this adds the
 * saved choice. Only the flag is cached, so the next visit is still before the
 * preferences have been fetched.
 */
const key = "ravan:motion";
export function applyMotion(reduced: boolean) {
  if (reduced) document.documentElement.dataset.motion = "reduce";
  else delete document.documentElement.dataset.motion;
}
export function rememberMotion(reduced: boolean) {
  applyMotion(reduced);
  try {
    if (reduced) localStorage.setItem(key, "reduce");
    else localStorage.removeItem(key);
  } catch {
    // Private browsing: the choice still applies for this visit.
  }
}
export function restoreMotion() {
  try {
    applyMotion(localStorage.getItem(key) === "reduce");
  } catch {
    // Storage unavailable: fall back to the system setting alone.
  }
}
export function motionReduced() {
  return (
    document.documentElement.dataset.motion === "reduce" ||
    (typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches)
  );
}
