/**
 * The few browser functions RAVAN calls that an LG C1 (webOS 6, Chromium 79)
 * lacks. Each is filled in only where the browser has none, so current
 * browsers keep their own. Import this first in each client's entry module.
 * Syntax newer than Chromium 79 is lowered by the build (`build.target`).
 */
type Statics = {
  any?: (signals: AbortSignal[]) => AbortSignal;
  timeout?: (ms: number) => AbortSignal;
};

function abortError(name = "AbortError") {
  return new DOMException("The operation was aborted.", name);
}

if (typeof AbortSignal !== "undefined") {
  const statics = AbortSignal as unknown as Statics;
  const proto = AbortSignal.prototype as Partial<AbortSignal>;

  if (typeof statics.timeout !== "function") {
    statics.timeout = (ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(abortError("TimeoutError")), ms);
      return controller.signal;
    };
  }

  if (typeof statics.any !== "function") {
    statics.any = (signals: AbortSignal[]) => {
      const controller = new AbortController();
      const done = signals.find((signal) => signal.aborted);
      if (done) {
        controller.abort((done as { reason?: unknown }).reason);
        return controller.signal;
      }
      const listeners: Array<() => void> = [];
      const stop = () => {
        signals.forEach((signal, i) =>
          signal.removeEventListener("abort", listeners[i]!),
        );
      };
      signals.forEach((signal) => {
        const listener = () => {
          stop();
          controller.abort((signal as { reason?: unknown }).reason);
        };
        listeners.push(listener);
        signal.addEventListener("abort", listener);
      });
      return controller.signal;
    };
  }

  if (typeof proto.throwIfAborted !== "function") {
    proto.throwIfAborted = function (this: AbortSignal) {
      if (!this.aborted) return;
      const reason = (this as { reason?: unknown }).reason;
      throw reason === undefined ? abortError() : reason;
    };
  }
}

/**
 * Chromium 79 lays out flex rows and columns without `gap` (it arrived in
 * Chromium 84), and CSS cannot ask whether it is there. Where a measurement
 * shows it missing, each flex item after the first gets the gap as a margin.
 * Items with a margin of their own (such as `auto`) are left alone. Browsers
 * with flex `gap` never run any of this.
 */
function flexGapMissing() {
  const box = document.createElement("div");
  box.style.cssText =
    "display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden";
  for (let i = 0; i < 2; i++) {
    const item = document.createElement("div");
    item.style.height = "1px";
    box.appendChild(item);
  }
  document.documentElement.appendChild(box);
  const height = box.scrollHeight;
  box.remove();
  // 3 with gap, 2 without; 0 where nothing is laid out (a test DOM).
  return height === 2;
}

type Side = "marginLeft" | "marginRight" | "marginTop" | "marginBottom";
const SIDES: Side[] = [
  "marginLeft",
  "marginRight",
  "marginTop",
  "marginBottom",
];
const ours = new WeakMap<HTMLElement, Partial<Record<Side, string>>>();

function spaceItems(container: Element) {
  const style = getComputedStyle(container);
  if (style.display !== "flex" && style.display !== "inline-flex") return;
  const rowGap = parseFloat(style.rowGap) || 0;
  const columnGap = parseFloat(style.columnGap) || 0;
  // Flex items: elements, and runs of text, which are items of their own.
  const entries: Array<HTMLElement | null> = [];
  for (const child of Array.from(container.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (child.textContent?.trim()) entries.push(null);
      continue;
    }
    if (!(child instanceof HTMLElement) && !(child instanceof SVGElement))
      continue;
    const own = getComputedStyle(child);
    if (own.display === "none") continue;
    if (own.position === "absolute" || own.position === "fixed") continue;
    entries.push(child as HTMLElement);
  }
  const items = entries.filter((entry): entry is HTMLElement => !!entry);
  const row = style.flexDirection.startsWith("row");
  const reverse = style.flexDirection.endsWith("reverse");
  const wrap = style.flexWrap !== "nowrap";
  items.forEach((item, index) => {
    const want: Partial<Record<Side, number>> = {};
    const at = entries.indexOf(item);
    if (wrap) {
      // Space after each item, so a line still starts flush.
      if (index < items.length - 1)
        want[row ? (reverse ? "marginLeft" : "marginRight") : "marginBottom"] =
          row ? columnGap : rowGap;
      if (row) want.marginBottom = rowGap;
      else want.marginRight = columnGap;
    } else {
      const gap = row ? columnGap : rowGap;
      const before: Side = row
        ? reverse
          ? "marginRight"
          : "marginLeft"
        : reverse
          ? "marginBottom"
          : "marginTop";
      const after: Side = row
        ? reverse
          ? "marginLeft"
          : "marginRight"
        : reverse
          ? "marginTop"
          : "marginBottom";
      if (at > 0) want[before] = gap;
      // Text cannot take a margin: the element before it carries the gap.
      if (at < entries.length - 1 && entries[at + 1] === null)
        want[after] = gap;
    }
    const set = ours.get(item) ?? {};
    const own = getComputedStyle(item);
    for (const side of SIDES) {
      const value = want[side] ? `${want[side]}px` : "";
      if (set[side] !== undefined) {
        // Ours from an earlier pass: update or remove it.
        if (item.style[side] === set[side]) item.style[side] = value;
        if (value) set[side] = value;
        else delete set[side];
      } else if (value && !item.style[side] && parseFloat(own[side]) === 0) {
        item.style[side] = value;
        set[side] = value;
      }
    }
    ours.set(item, set);
  });
}

function installFlexGapFallback() {
  if (!flexGapMissing()) return;
  document.documentElement.setAttribute("data-flex-gap", "fallback");
  let pending = new Set<Element>();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const roots = pending;
    pending = new Set();
    for (const root of roots) {
      if (!root.isConnected) continue;
      spaceItems(root);
      root.querySelectorAll("*").forEach(spaceItems);
    }
  };
  const queue = (element: Element) => {
    pending.add(element);
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(flush);
    }
  };
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.target instanceof Element) queue(record.target);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  // Gaps written in vw or behind media queries change with the window.
  let resizing: ReturnType<typeof setTimeout> | undefined;
  addEventListener("resize", () => {
    clearTimeout(resizing);
    resizing = setTimeout(() => queue(document.body), 200);
  });
  queue(document.body ?? document.documentElement);
}

/** `replaceChildren` (Chromium 86) on elements, fragments and documents. */
function installReplaceChildren() {
  for (const type of [Element, DocumentFragment, Document]) {
    const proto = type.prototype as Partial<ParentNode>;
    if (typeof proto.replaceChildren === "function") continue;
    proto.replaceChildren = function (
      this: ParentNode & Node,
      ...nodes: (Node | string)[]
    ) {
      while (this.lastChild) this.removeChild(this.lastChild);
      this.append(...nodes);
    };
  }
}

/**
 * `addEventListener(type, listener, { signal })` (Chromium 90). Older engines
 * ignore `signal`, so a listener meant to end with it would stay forever.
 */
function installListenerSignal() {
  let read = false;
  try {
    const probe = {
      get signal() {
        read = true;
        return undefined;
      },
    };
    new EventTarget().addEventListener("probe", () => {}, probe);
  } catch {
    return;
  }
  if (read) return;
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    const signal =
      typeof options === "object" && options ? options.signal : undefined;
    if (signal?.aborted) return;
    add.call(this, type, listener, options);
    if (signal && listener)
      signal.addEventListener("abort", () =>
        this.removeEventListener(type, listener, options),
      );
  };
}

/**
 * Chromium 79 has no `:focus-visible` and drops every CSS rule that names it.
 * Mark the page so the stylesheets' `[data-focus-visible="fallback"]` rules
 * use `:focus` instead.
 */
function markFocusVisible() {
  try {
    document.querySelector(":focus-visible");
  } catch {
    document.documentElement.setAttribute("data-focus-visible", "fallback");
  }
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  installReplaceChildren();
  installListenerSignal();
  markFocusVisible();
  installFlexGapFallback();
}

export {};
