// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  moveFocus,
  saveFocus,
  restoreFocus,
  installRemote,
} from "../../apps/tv/src/focus.js";
import { pairDevice } from "../../apps/tv/src/pairing.js";
afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function buttons() {
  document.body.innerHTML =
    '<button data-focus-id="a">A</button><button data-focus-id="b">B</button><button data-focus-id="c">C</button>';
  const list = Array.from(document.querySelectorAll("button"));
  list.forEach((el, i) => {
    el.getBoundingClientRect = () => ({
      x: i * 100,
      y: 0,
      left: i * 100,
      top: 0,
      right: i * 100 + 80,
      bottom: 80,
      width: 80,
      height: 80,
      toJSON() {
        return {};
      },
    });
  });
  return list;
}
it("navigates by direction, restores stable ids, and handles empty screens", () => {
  const [a, b] = buttons();
  a!.focus();
  moveFocus("right");
  expect(document.activeElement).toBe(b);
  saveFocus("library");
  document.body.innerHTML = "";
  restoreFocus("library");
  buttons();
  restoreFocus("library");
  expect(document.activeElement?.getAttribute("data-focus-id")).toBe("b");
  moveFocus("left");
  expect(document.activeElement?.getAttribute("data-focus-id")).toBe("a");
});
it("handles Back and removes key listeners on disposal", () => {
  const back = vi.fn();
  const remove = installRemote(back);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(back).toHaveBeenCalledTimes(1);
  remove();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(back).toHaveBeenCalledTimes(1);
});
it("polls with a secret and never approves itself", async () => {
  vi.useFakeTimers();
  const urls: string[] = [];
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url);
    const body = JSON.parse(String(init?.body));
    if (url.endsWith("/api/pairing"))
      return new Response(
        JSON.stringify({
          id: "pair",
          code: "ABCDEFGH",
          pollSecret: "secret",
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        }),
      );
    if (url.endsWith("/poll")) {
      expect(body.pollSecret).toBe("secret");
      return new Response(
        JSON.stringify({
          state: "approved",
          credential: "device",
          deviceId: "tv",
        }),
      );
    }
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", request);
  const callback = vi.fn();
  const paired = pairDevice(
    "https://mov.example.test",
    new AbortController().signal,
    callback,
  );
  await vi.advanceTimersByTimeAsync(5000);
  expect(await paired).toBe("device");
  expect(callback).toHaveBeenCalledWith("ABCDEFGH");
  expect(urls.some((u) => u.endsWith("/approve"))).toBe(false);
});
it("cancels waiting without another poll", async () => {
  vi.useFakeTimers();
  const request = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: "pair",
          code: "ABCDEFGH",
          pollSecret: "secret",
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        }),
      ),
  );
  vi.stubGlobal("fetch", request);
  const controller = new AbortController();
  const promise = pairDevice(
    "https://mov.example.test",
    controller.signal,
    () => {},
  );
  const rejected = expect(promise).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await rejected;
  expect(request).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
