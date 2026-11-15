import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ApiContext,
  createApiClient,
  type ApiClient,
} from "../../../packages/client/src/api.js";
import type { SessionState } from "../../../packages/contracts/src/index.js";
import { StatusPanel } from "../../../packages/ui/src/StatusPanel.js";
import { useRoute } from "./router.js";
import { Setup } from "./pages/Setup.js";
import { Library } from "./pages/Library.js";
import { Detail } from "./pages/Detail.js";
import { Watchlist } from "./pages/Watchlist.js";
import { Settings } from "./pages/Settings.js";
import { Player } from "./pages/Player.js";
import "../../../packages/ui/src/tokens.css";
import "./cinema.css";
const publicDemo = import.meta.env.MODE === "public-demo";
const isPreview =
  publicDemo ||
  (import.meta.env.DEV &&
    new URLSearchParams(location.search).get("preview") === "1");
async function start() {
  const api = isPreview
    ? (await import("./preview.js")).previewApi()
    : createApiClient("");
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
    [retry, setRetry] = useState(0);
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
              · <a href="/">Connection setup ↗</a>
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
        {session?.authenticated ? (
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
            <button
              className="profile-button"
              aria-label={isPreview ? "Sample profile" : "Sign out"}
              disabled={isPreview}
              onClick={() => {
                api
                  .logout()
                  .then(() =>
                    setSession({ authenticated: false, configured: true }),
                  )
                  .catch(() => setError(true));
              }}
            >
              M<span className="profile-dot" />
            </button>
          </>
        ) : (
          <span className="header-label">A PERSONAL CINEMA</span>
        )}
      </header>
      {error ? (
        <main id="main">
          <StatusPanel
            title="Your cinema is taking a moment."
            action={
              <button onClick={() => setRetry((n) => n + 1)}>Try again</button>
            }
          >
            We couldn’t reach the server. Check the connection, then try again.
          </StatusPanel>
        </main>
      ) : !session ? (
        <main id="main" className="loading-screen" role="status">
          Opening your cinema…
        </main>
      ) : !session.authenticated ? (
        <Setup session={session} />
      ) : route === "/settings" ? (
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
    </>
  );
}
void start();
