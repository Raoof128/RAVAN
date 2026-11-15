import {
  Component,
  StrictMode,
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ApiContext,
  ApiError,
  createApiClient,
  type ApiClient,
} from "../../../packages/client/src/api.js";
import type { SessionState } from "../../../packages/contracts/src/index.js";
import { StatusPanel } from "../../../packages/ui/src/StatusPanel.js";
import {
  ActionButton,
  Opening,
  usePending,
} from "../../../packages/ui/src/Loading.js";
import { useRoute } from "./router.js";
import { rememberMotion, restoreMotion } from "./motion.js";
import { Setup } from "./pages/Setup.js";
import { Library } from "./pages/Library.js";
import { Watchlist } from "./pages/Watchlist.js";
import "../../../packages/ui/src/tokens.css";
import "../../../packages/ui/src/loading.css";
import "./cinema.css";
// The first screen is the library or the sign-in page. Everything else is
// fetched when it is first opened, and warmed once the browser is idle.
const pages = {
  detail: () => import("./pages/Detail.js"),
  player: () => import("./pages/Player.js"),
  settings: () => import("./pages/Settings.js"),
};
const Detail = lazy(() => pages.detail().then((m) => ({ default: m.Detail })));
const Player = lazy(() => pages.player().then((m) => ({ default: m.Player })));
const Settings = lazy(() =>
  pages.settings().then((m) => ({ default: m.Settings })),
);
const publicDemo = import.meta.env.MODE === "public-demo";
const isPreview =
  publicDemo ||
  (import.meta.env.DEV &&
    new URLSearchParams(location.search).get("preview") === "1");
restoreMotion();
/** The page is ready: let go of the opening screen without holding it back. */
function dismissBoot() {
  const boot = document.getElementById("boot");
  if (!boot || boot.classList.contains("leaving")) return;
  boot.classList.add("leaving");
  setTimeout(() => boot.remove(), 220);
}
/**
 * A screen's code is fetched when it is first opened. If that fetch fails (the
 * connection dropped, or a new version replaced the file), say so and offer the
 * reload that fixes it, instead of an empty page.
 */
class ScreenBoundary extends Component<
  { route: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidUpdate(previous: { route: string }) {
    // Leaving for another screen clears the failure.
    if (previous.route !== this.props.route && this.state.failed)
      this.setState({ failed: false });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main id="main">
        <StatusPanel
          tone="error"
          level={1}
          title="This screen couldn’t be opened."
          action={
            <div className="button-row">
              <button onClick={() => location.reload()}>Reload</button>
              <a className="button" href="#/library">
                Back to your library
              </a>
            </div>
          }
        >
          Part of RAVAN didn’t load. Check the connection and reload the page.
        </StatusPanel>
      </main>
    );
  }
}
const signedOut = "ravan:signed-out";
/**
 * A session can end while a page is open: it expires, or the owner signs out
 * in another tab. Any request that then comes back 401 says so once, and the
 * shell checks the session again instead of leaving a page that cannot load.
 */
function watchSession(api: ApiClient): ApiClient {
  const watched = { ...api };
  for (const name of Object.keys(api) as Array<keyof ApiClient>) {
    const method = api[name] as (...args: unknown[]) => unknown;
    if (name === "session" || name === "setDeviceCredential") continue;
    (watched as Record<string, unknown>)[name] = (...args: unknown[]) => {
      const result = method(...args);
      if (result instanceof Promise)
        result.catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 401)
            window.dispatchEvent(new Event(signedOut));
        });
      return result;
    };
  }
  return watched;
}
async function start() {
  const api = isPreview
    ? (await import("./preview.js")).previewApi()
    : watchSession(createApiClient(""));
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ApiContext.Provider value={api}>
        <App api={api} />
      </ApiContext.Provider>
    </StrictMode>,
  );
}
function App({ api }: { api: ApiClient }) {
  const route = useRoute();
  const [session, setSession] = useState<SessionState>(),
    [error, setError] = useState(false),
    [retry, setRetry] = useState(0),
    [signOutFailed, setSignOutFailed] = useState(false),
    [offline, setOffline] = useState(
      typeof navigator !== "undefined" && navigator.onLine === false,
    );
  useEffect(() => {
    const update = () => setOffline(navigator.onLine === false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  const [leaving, signOut] = usePending();
  const view = useRef<HTMLDivElement>(null);
  const shownRoute = useRef(route);
  useEffect(() => {
    let active = true;
    setError(false);
    api
      .session()
      .then((s) => {
        if (active) setSession(s);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [api, retry]);
  useEffect(() => {
    if (session || error) dismissBoot();
  }, [session, error]);
  const authenticated = session?.authenticated === true;
  useEffect(() => {
    // Only a signed-in page has a session to lose; sign-in's own 401s are answers.
    if (!authenticated) return;
    const recheck = () => setRetry((n) => n + 1);
    window.addEventListener(signedOut, recheck);
    return () => window.removeEventListener(signedOut, recheck);
  }, [authenticated]);
  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    api
      .preferences()
      .then((p) => {
        // Also corrects the cached flag when the choice was changed elsewhere.
        if (active) rememberMotion(p.reducedMotion);
      })
      .catch(() => {});
    const idle = window.requestIdleCallback ?? ((f) => setTimeout(f, 1200));
    const cancel = window.cancelIdleCallback ?? clearTimeout;
    const handle = idle(() => {
      void pages.detail().catch(() => {});
      void pages.player().catch(() => {});
    });
    return () => {
      active = false;
      cancel(handle);
    };
  }, [api, authenticated]);
  // A new screen starts at its top for everyone: sighted users are scrolled
  // there, keyboard and screen-reader users are placed there. The first screen
  // is left alone so the skip link stays the first stop.
  useEffect(() => {
    if (shownRoute.current === route) return;
    shownRoute.current = route;
    view.current?.focus({ preventScroll: true });
  }, [route]);
  return (
    <>
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById("main");
          main?.setAttribute("tabindex", "-1");
          main?.focus();
        }}
      >
        Skip to content
      </a>
      {isPreview && (
        <div className="preview-banner">
          {publicDemo
            ? "PUBLIC DEMO · FICTIONAL FILMS · STREAMING NOT CONNECTED"
            : "DESIGN PREVIEW · SAMPLE LIBRARY · NO DRIVE CONNECTION"}
          {publicDemo && (
            <>
              {" "}
              · <a href="/">Connection setup</a>
            </>
          )}
        </div>
      )}
      <header className="site-header">
        <a href="#/library" className="wordmark" aria-label="RAVAN home">
          RAVĀN
        </a>
        <span className="brand-caption">
          EVERY STORY
          <br />
          FLOWS.
        </span>
        {authenticated ? (
          <>
            <nav aria-label="Main navigation">
              <a
                href="#/library"
                aria-current={route === "/library" ? "page" : undefined}
              >
                Library
              </a>
              <a
                href="#/watchlist"
                aria-current={route === "/watchlist" ? "page" : undefined}
              >
                Watchlist
              </a>
              <a
                href="#/settings"
                aria-current={route === "/settings" ? "page" : undefined}
              >
                Your cinema
              </a>
            </nav>
            {!isPreview && (
              <ActionButton
                className="sign-out"
                pending={leaving}
                pendingLabel="Signing out"
                onClick={() =>
                  void signOut(async () => {
                    setSignOutFailed(false);
                    try {
                      await api.logout();
                      setSession({ authenticated: false, configured: true });
                      // The button that had focus is gone; land on the sign-in page.
                      view.current?.focus({ preventScroll: true });
                    } catch {
                      setSignOutFailed(true);
                    }
                  })
                }
              >
                Sign out
              </ActionButton>
            )}
          </>
        ) : (
          <span className="header-label">A PERSONAL CINEMA</span>
        )}
      </header>
      <p className="shell-notice" role="status">
        {offline
          ? "This device is offline. Films and changes will work again when the connection returns."
          : ""}
      </p>
      {signOutFailed && (
        <p className="shell-notice" role="alert">
          You are still signed in: the server could not be reached. Check the
          connection and choose Sign out again.
        </p>
      )}
      <div className="view" ref={view} tabIndex={-1}>
        {error ? (
          <main id="main">
            <StatusPanel
              tone="error"
              level={1}
              title="Your cinema is taking a moment."
              action={
                <button onClick={() => setRetry((n) => n + 1)}>
                  Try again
                </button>
              }
            >
              We couldn’t reach the server. Check the connection, then try
              again.
            </StatusPanel>
          </main>
        ) : !session ? (
          // The opening screen in index.html covers this until the session is known.
          <main id="main" aria-busy="true" />
        ) : !session.authenticated ? (
          <Setup session={session} />
        ) : (
          <ScreenBoundary route={route}>
            <Suspense
              fallback={
                <main id="main">
                  <Opening words="Opening" />
                </main>
              }
            >
              {route === "/settings" ? (
                <Settings />
              ) : route === "/watchlist" ? (
                <Watchlist />
              ) : route.startsWith("/movie/") ? (
                <Detail id={decodeURIComponent(route.slice(7))} />
              ) : route.startsWith("/player/") ? (
                <Player
                  id={decodeURIComponent(route.slice(8).split("?")[0]!)}
                  startOver={route.includes("?start=0")}
                />
              ) : (
                <Library />
              )}
            </Suspense>
          </ScreenBoundary>
        )}
      </div>
    </>
  );
}
void start();
