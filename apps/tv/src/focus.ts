type Direction = "left" | "right" | "up" | "down";
const saved = new Map<string, string>();
function targets() {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-focus-id]"),
  ).filter(
    (el) =>
      !el.hasAttribute("disabled") &&
      !el.hidden &&
      el.getBoundingClientRect().width > 0,
  );
}
export function saveFocus(routeKey: string, selectedId?: string) {
  const id =
    selectedId ??
    (document.activeElement as HTMLElement | null)?.dataset.focusId;
  if (id) saved.set(routeKey, id);
}
export function restoreFocus(routeKey: string) {
  const elements = targets();
  (
    elements.find((el) => el.dataset.focusId === saved.get(routeKey)) ??
    elements.find((el) =>
      routeKey === "library"
        ? el.dataset.focusId?.startsWith("movie-")
        : el.dataset.focusId ===
          (
            { detail: "watch", player: "play", settings: "return" } as Record<
              string,
              string
            >
          )[routeKey],
    ) ??
    elements[0]
  )?.focus();
}
export function moveFocus(direction: Direction) {
  const elements = targets();
  const active = document.activeElement as HTMLElement;
  const rect = active?.getBoundingClientRect();
  if (!rect || !elements.includes(active)) {
    elements[0]?.focus();
    return;
  }
  const x = rect.left + rect.width / 2,
    y = rect.top + rect.height / 2;
  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "left" || direction === "up" ? -1 : 1;
  const candidates = elements
    .filter((el) => el !== active)
    .map((el) => {
      const r = el.getBoundingClientRect(),
        dx = r.left + r.width / 2 - x,
        dy = r.top + r.height / 2 - y;
      const primary = (horizontal ? dx : dy) * sign,
        secondary = horizontal ? dy : dx;
      return { el, primary, score: primary ** 2 + secondary ** 2 * 2 };
    })
    .filter((c) => c.primary > 1)
    .sort((a, b) => a.score - b.score);
  candidates[0]?.el.focus();
}
export function installRemote(back: () => void) {
  let last = 0;
  const handler = (event: KeyboardEvent) => {
    const directions: Record<string, Direction> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    };
    const direction = directions[event.key];
    if (direction) {
      event.preventDefault();
      const now = Date.now();
      if (event.repeat && now - last < 140) return;
      last = now;
      moveFocus(direction);
    } else if (
      event.key === "Escape" ||
      event.key === "Backspace" ||
      event.keyCode === 461
    ) {
      event.preventDefault();
      back();
    }
  };
  const pointer = (event: PointerEvent) => {
    (event.target as HTMLElement)
      .closest<HTMLElement>("[data-focus-id]")
      ?.focus();
  };
  window.addEventListener("keydown", handler);
  window.addEventListener("pointerdown", pointer);
  return () => {
    window.removeEventListener("keydown", handler);
    window.removeEventListener("pointerdown", pointer);
  };
}
