export function detectPlatform(): "webos" | "tizen" | "unsupported" {
  const agent = navigator.userAgent;
  if (/web0s|webos/i.test(agent) || "PalmSystem" in window) return "webos";
  if (/tizen/i.test(agent) && "webapis" in window) return "tizen";
  return "unsupported";
}
