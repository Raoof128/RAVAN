import { useEffect, useState } from "react";
const base = "RAVAN — Every Story Flows.";
const current = () => location.hash.slice(1) || "/library";
/*
 * Back and Forward return to where the reader was. Each history entry is
 * numbered in its own state; an entry that already has a number is one being
 * returned to, and gets its scroll position back once its content is there.
 * A new entry starts at the top. Positions are kept for this visit only.
 */
type Entry = { ravan?: number } | null;
const scrolls = new Map<number, number>();
const routes = new Map<number, string>();
let index = 0;
let top = 0;
let started = false;
function begin() {
  if (started) return;
  started = true;
  try {
    history.scrollRestoration = "manual";
    const known = (history.state as Entry)?.ravan;
    if (typeof known === "number") index = top = known;
    else history.replaceState({ ravan: 0 }, "");
  } catch {
    // History is unavailable (a sandboxed frame): every screen opens at its top.
  }
  routes.set(index, current());
}
// A restore waits for its screen's content. If the reader moves on first,
// the wait is abandoned: it must never scroll the screen that came after.
let settling = 0;
function settle(y: number) {
  const mine = ++settling;
  let tries = 0;
  const step = () => {
    if (mine !== settling) return;
    const reach = document.documentElement.scrollHeight - innerHeight;
    if (reach >= y || tries++ > 40) window.scrollTo(0, Math.min(y, reach));
    else setTimeout(step, 50);
  };
  step();
}
/**
 * The id that follows `prefix` in a route, or undefined when there is none or
 * it is not validly written. Never throws: a link ending in a stray "%" used
 * to blank the whole app, because decoding it failed while rendering.
 */
export function routeParam(route: string, prefix: string): string | undefined {
  if (!route.startsWith(prefix)) return;
  try {
    return (
      decodeURIComponent(route.slice(prefix.length).split("?")[0]!) || undefined
    );
  } catch {
    return;
  }
}
export function useRoute() {
  const [route, setRoute] = useState(current);
  useEffect(() => {
    begin();
    const update = () => {
      scrolls.set(index, window.scrollY);
      const known = (history.state as Entry)?.ravan;
      if (typeof known === "number") {
        index = known;
        top = Math.max(top, index);
        setRoute(current());
        settle(scrolls.get(index) ?? 0);
      } else {
        index = ++top;
        try {
          history.replaceState({ ravan: index }, "");
        } catch {
          // See begin().
        }
        settling++;
        setRoute(current());
        window.scrollTo(0, 0);
      }
      routes.set(index, current());
    };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}
/**
 * For a "back to…" link: if the screen it names is the one the reader just
 * came from, go back to it (keeping its scroll position and search) instead
 * of opening a fresh copy. Returns true when it did.
 */
export function returnTo(pattern: RegExp) {
  const before = routes.get(index - 1);
  if (index === 0 || !before || !pattern.test(before)) return false;
  history.back();
  return true;
}
/**
 * Names the tab after the screen, so history entries, bookmarks and a screen
 * reader's window list say where they lead. The home screen keeps the product
 * name on its own.
 */
export function useTitle(title?: string) {
  useEffect(() => {
    document.title = title ? `${title} — RAVAN` : base;
    return () => {
      document.title = base;
    };
  }, [title]);
}
