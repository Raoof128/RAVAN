function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error("Pairing cancelled"));
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
export async function pairDevice(
  origin: string,
  signal: AbortSignal,
  onCode: (code: string) => void,
): Promise<string> {
  async function request(path: string, body: unknown, credential?: string) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 15000);
    try {
      if (signal.aborted) throw new Error("Pairing cancelled");
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        credentials: "omit",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("Pairing expired or unavailable");
      return response.status === 204 ? undefined : await response.json();
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
  }
  const challenge = await request("/api/pairing", { name: "LG C1" });
  if (
    typeof challenge?.id !== "string" ||
    typeof challenge?.code !== "string" ||
    typeof challenge?.pollSecret !== "string" ||
    !Number.isFinite(Date.parse(challenge.expiresAt))
  )
    throw new Error("Invalid pairing response");
  onCode(challenge.code);
  while (Date.now() < Date.parse(challenge.expiresAt)) {
    await wait(5000, signal);
    const reply = await request("/api/pairing/poll", {
      id: challenge.id,
      pollSecret: challenge.pollSecret,
    });
    if (reply?.state === "approved" && typeof reply.credential === "string") {
      await request("/api/pairing/ack", { id: challenge.id }, reply.credential);
      return reply.credential;
    }
    if (reply?.state !== "pending") throw new Error("Pairing unavailable");
  }
  throw new Error("Pairing code expired");
}
export const credentialStore = {
  get() {
    try {
      return localStorage.getItem("mov-device");
    } catch {
      return null;
    }
  },
  set(value: string) {
    localStorage.setItem("mov-device", value);
  },
  clear() {
    localStorage.removeItem("mov-device");
  },
};
