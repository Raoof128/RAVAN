// @vitest-environment jsdom
// What an LG C1 (Chromium 79) lacks in the page itself: the fill-ins in
// packages/client/src/legacy.ts, and the reader's word for a PDF it cannot
// open. Each test removes the modern function first, as Chromium 79 has none.
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function freshLegacy() {
  vi.resetModules();
  await import("../../packages/client/src/legacy.js");
}

it("fills in replaceChildren where elements have none", async () => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  const native = proto.replaceChildren;
  try {
    delete proto.replaceChildren;
    await freshLegacy();
    const box = document.createElement("div");
    box.append("old", document.createElement("span"));
    box.replaceChildren(document.createElement("b"), "new");
    expect(box.innerHTML).toBe("<b></b>new");
    box.replaceChildren();
    expect(box.childNodes.length).toBe(0);
  } finally {
    proto.replaceChildren = native;
  }
});

it("ends a listener with its signal where addEventListener ignores one", async () => {
  const native = EventTarget.prototype.addEventListener;
  // An engine that never reads `signal`, as Chromium 79.
  EventTarget.prototype.addEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    const capture =
      typeof options === "object" && options ? !!options.capture : !!options;
    native.call(this, type, listener, capture);
  };
  try {
    await freshLegacy();
    expect(EventTarget.prototype.addEventListener).not.toBe(native);
    const target = new EventTarget();
    const controller = new AbortController();
    const heard = vi.fn();
    target.addEventListener("ping", heard, { signal: controller.signal });
    target.dispatchEvent(new Event("ping"));
    controller.abort();
    target.dispatchEvent(new Event("ping"));
    expect(heard).toHaveBeenCalledTimes(1);
    // Already aborted: never added.
    target.addEventListener("ping", heard, { signal: controller.signal });
    target.dispatchEvent(new Event("ping"));
    expect(heard).toHaveBeenCalledTimes(1);
  } finally {
    EventTarget.prototype.addEventListener = native;
  }
});

it("marks the page for :focus rings only where :focus-visible is unknown", async () => {
  document.documentElement.removeAttribute("data-focus-visible");
  await freshLegacy();
  expect(document.documentElement.getAttribute("data-focus-visible")).toBe(
    null,
  );
  vi.spyOn(Document.prototype, "querySelector").mockImplementation(
    (selector: string) => {
      if (selector === ":focus-visible")
        throw new DOMException("not a valid selector", "SyntaxError");
      return null;
    },
  );
  await freshLegacy();
  expect(document.documentElement.getAttribute("data-focus-visible")).toBe(
    "fallback",
  );
  document.documentElement.removeAttribute("data-focus-visible");
});

it("says a PDF needs a newer browser instead of loading PDF.js", async () => {
  const promise = Promise as unknown as Record<string, unknown>;
  const native = promise.try;
  try {
    delete promise.try;
    const { Reader } = await import("../../apps/web/src/reading/Reader.js");
    render(
      <Reader
        source={{
          title: "Atlas",
          format: "pdf",
          blob: new Blob(["%PDF-1.7"]),
          position: { section: 0, fraction: 0 },
        }}
        onClose={() => {}}
        onProgress={async () => {}}
      />,
    );
    expect(screen.getByRole("alert").textContent).toMatch(
      /PDF books need a newer browser/,
    );
    expect(screen.queryByText("Loading PDF reader…")).toBeNull();
    expect(document.body.classList.contains("reading-open")).toBe(true);
    cleanup();
    expect(document.body.classList.contains("reading-open")).toBe(false);
  } finally {
    promise.try = native;
  }
});
