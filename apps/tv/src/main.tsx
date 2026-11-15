import { FilmStill } from "../../../packages/ui/src/FilmStill.js";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createApiClient,
  type ApiClient,
} from "../../../packages/client/src/api.js";
import type {
  MovieCard,
  MovieDetail,
} from "../../../packages/contracts/src/index.js";
import { Poster } from "../../../packages/ui/src/MovieCard.js";
import { installRemote, restoreFocus, saveFocus } from "./focus.js";
import { pairDevice, credentialStore } from "./pairing.js";
import { WebOSAdapter } from "./platforms/WebOSAdapter.js";
import { detectPlatform } from "./platforms/detect.js";
import {
  PlayerController,
  type ControllerState,
} from "../../web/src/player/PlayerController.js";
import "../../../packages/ui/src/tokens.css";
import "./tv.css";
const preview =
  import.meta.env.DEV &&
  new URLSearchParams(location.search).get("preview") === "1";
const origin = import.meta.env.VITE_MOV_ORIGIN ?? "";
async function launch() {
  const api = preview
    ? (await import("../../web/src/preview.js")).previewApi()
    : createApiClient(origin);
  const credential = credentialStore.get();
  if (credential) api.setDeviceCredential(credential);
  createRoot(document.getElementById("root")!).render(<TV api={api} />);
}
void launch();
function TV({ api }: { api: ApiClient }) {
  const [page, setPage] = useState<
      "loading" | "pair" | "library" | "detail" | "player" | "settings"
    >("loading"),
    [items, setItems] = useState<MovieCard[]>([]),
    [movie, setMovie] = useState<MovieDetail>(),
    [message, setMessage] = useState(""),
    [code, setCode] = useState(""),
    [retry, setRetry] = useState(0),
    [cursor, setCursor] = useState<string | null>(null);
  const pageRef = useRef(page);
  const loadedRevision = useRef<number | null>(null);
  const resumePositions = useRef(new Map<string, number>());
  pageRef.current = page;
  function go(next: typeof page) {
    saveFocus(pageRef.current);
    setMessage("");
    setPage(next);
  }
  useEffect(
    () =>
      installRemote(() => {
        const current = pageRef.current;
        if (current === "detail" || current === "settings") go("library");
        else if (current === "player") go("detail");
      }),
    [],
  );
  useEffect(() => {
    const timer = setTimeout(() => restoreFocus(page), 100);
    return () => clearTimeout(timer);
  }, [page, items, code]);
  useEffect(() => {
    let active = true;
    api
      .session()
      .then((s) => {
        if (active) setPage(s.authenticated ? "library" : "pair");
      })
      .catch(() => {
        if (active) {
          setMessage("The connection is unavailable.");
          setPage("pair");
        }
      });
    return () => {
      active = false;
    };
  }, [api]);
  useEffect(() => {
    if (page !== "pair" || preview) return;
    const controller = new AbortController();
    setCode("");
    if (!/^https:\/\//.test(origin)) {
      setMessage(
        "This TV app needs your cinema’s secure address. Install the configured package.",
      );
      return;
    }
    pairDevice(origin, controller.signal, setCode)
      .then((token) => {
        credentialStore.set(token);
        api.setDeviceCredential(token);
        setPage("library");
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setMessage("Pairing expired or the connection was lost. Try again.");
      });
    return () => controller.abort();
  }, [page, retry, api]);
  useEffect(() => {
    if (page !== "library" || loadedRevision.current === retry) return;
    let active = true;
    api
      .listMovies()
      .then((data) => {
        if (active) {
          loadedRevision.current = retry;
          setItems(data.items);
          setCursor(data.nextCursor);
        }
      })
      .catch(() => {
        if (active)
          setMessage(
            "We couldn’t load your films. Check the connection or reconnect this TV.",
          );
      });
    return () => {
      active = false;
    };
  }, [page, retry, api]);
  async function open(id: string) {
    try {
      const value = await api.detail(id);
      resumePositions.current.delete(id);
      setMovie(value);
      go("detail");
      // Pointer activation need not focus a button on every engine. Preserve
      // the selected identity explicitly rather than guessing from activeElement.
      saveFocus("library", `movie-${id}`);
    } catch {
      setMessage("This film is unavailable. Try refreshing your collection.");
    }
  }
  return (
    <div className="tv-shell">
      <header className="tv-header">
        <span className="wordmark">RAVĀN</span>
        <span className="tv-label">
          {preview ? "LG C1 DEVELOPMENT PREVIEW" : "YOUR PRIVATE CINEMA"}
        </span>
        {page !== "pair" && page !== "loading" && (
          <button data-focus-id="settings" onClick={() => go("settings")}>
            Your cinema
          </button>
        )}
      </header>
      {page === "pair" ? (
        <main className="tv-pair">
          <p className="eyebrow">BRING THE BIG SCREEN</p>
          <h1>Your seat is ready.</h1>
          <p>
            Open RAVAN on your phone, choose Your cinema,
            <br />
            then approve this TV with the code below.
          </p>
          <div className="pair-code" aria-live="polite">
            {code || "— — — —"}
          </div>
          <p className="tv-address">{origin}</p>
          <p role="status">{message}</p>
          {message && (
            <button
              data-focus-id="pair-retry"
              onClick={() => setRetry((n) => n + 1)}
            >
              Try again
            </button>
          )}
        </main>
      ) : page === "library" ? (
        <main className="tv-library">
          <div className="tv-library-atmosphere">
            <FilmStill url={items[0]?.posterUrl} priority />
          </div>
          <p className="eyebrow">GOOD EVENING. MAKE YOURSELF AT HOME.</p>
          <h1>Something worth watching.</h1>
          {message && (
            <div role="status">
              <p>{message}</p>
              <button
                data-focus-id="retry"
                onClick={() => setRetry((n) => n + 1)}
              >
                Try again
              </button>
            </div>
          )}
          {!items.length && !message ? (
            <p>
              Your collection will appear here after you choose a folder on your
              phone.
            </p>
          ) : (
            <div className="tv-grid">
              {items.map((m) => (
                <button
                  className="tv-movie"
                  data-focus-id={`movie-${m.id}`}
                  key={m.id}
                  onClick={() => void open(m.id)}
                >
                  <Poster movie={m} />
                  <strong>{m.title}</strong>
                  <small>
                    {!m.available
                      ? "Source unavailable"
                      : m.resumeMs
                        ? `Continue at ${Math.floor(m.resumeMs / 60000)} min`
                        : (m.year ?? "Your collection")}
                  </small>
                </button>
              ))}
            </div>
          )}
          {cursor && (
            <button
              data-focus-id="more"
              onClick={() => {
                api
                  .listMovies(cursor)
                  .then((data) => {
                    setItems((old) => [
                      ...old,
                      ...data.items.filter(
                        (m) => !old.some((o) => o.id === m.id),
                      ),
                    ]);
                    setCursor(data.nextCursor);
                  })
                  .catch(() => setMessage("More films could not be loaded."));
              }}
            >
              More films
            </button>
          )}
        </main>
      ) : page === "detail" && movie ? (
        <main className="tv-detail">
          <div className="tv-library-atmosphere">
            <FilmStill url={movie.posterUrl} priority />
          </div>
          <Poster movie={movie} large />
          <section>
            <p className="eyebrow">
              FROM YOUR COLLECTION / {movie.year ?? "RAVAN"}
            </p>
            <h1>{movie.title}</h1>
            <p>
              {movie.description || "A film from your personal collection."}
            </p>
            <div className="button-row">
              <button
                className="primary"
                data-focus-id="watch"
                disabled={!movie.available}
                onClick={() => go("player")}
              >
                ▶{" "}
                {(resumePositions.current.get(movie.id) ?? movie.resumeMs)
                  ? "Continue watching"
                  : "Watch film"}
              </button>
              <button data-focus-id="back" onClick={() => go("library")}>
                Back to collection
              </button>
            </div>
            {!movie.available && (
              <p>Source unavailable. Reconnect your Drive on your phone.</p>
            )}
          </section>
        </main>
      ) : page === "player" && movie ? (
        <TVPlayer
          movie={movie}
          api={api}
          resumeMs={resumePositions.current.get(movie.id) ?? movie.resumeMs}
          remember={(position) =>
            resumePositions.current.set(movie.id, position)
          }
          close={() => go("detail")}
        />
      ) : page === "settings" ? (
        <main className="tv-settings">
          <p className="eyebrow">YOUR SCREEN, YOUR SPACE</p>
          <h1>Welcome to your cinema.</h1>
          <p>
            Manage your movie folder and languages on your phone.
            <br />
            This TV only holds its own revocable device credential.
          </p>
          <div className="button-row">
            <button
              className="primary"
              data-focus-id="return"
              onClick={() => go("library")}
            >
              Back to films
            </button>
            <button
              data-focus-id="signout"
              onClick={() => {
                credentialStore.clear();
                api.setDeviceCredential(undefined);
                setPage("pair");
              }}
            >
              Disconnect this TV
            </button>
          </div>
        </main>
      ) : (
        <main className="tv-pair" role="status">
          <h1>Opening your cinema…</h1>
        </main>
      )}
      <footer className="tv-footer">
        <span>EVERY STORY FLOWS.</span>
        <span>↑ ↓ ← → to explore · OK to choose · Back to return</span>
      </footer>
    </div>
  );
}
function TVPlayer({
  movie,
  api,
  close,
  resumeMs,
  remember,
}: {
  movie: MovieDetail;
  api: ApiClient;
  close: () => void;
  resumeMs: number;
  remember: (position: number) => void;
}) {
  const video = useRef<HTMLVideoElement>(null),
    controller = useRef<PlayerController | null>(null);
  const position = useRef(resumeMs);
  const [state, setState] = useState<ControllerState>({ kind: "loading" }),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!preview && detectPlatform() !== "webos") {
      setState({
        kind: "unsupported",
        reason:
          "This package targets LG webOS. This device has not been validated.",
      });
      return;
    }
    let active = true;
    // Retain the element itself: React clears refs before unmount cleanup.
    const element = video.current!;
    const adapter = new WebOSAdapter(element, origin || location.origin);
    const player = new PlayerController(api, adapter, (s) => {
      if (active) setState(s);
    });
    controller.current = player;
    const capturePosition = () => {
      if (element.readyState > 0)
        position.current = element.ended ? 0 : adapter.getPositionMs();
      remember(position.current);
    };
    void player.start(movie.id, "lg-c1", position.current);
    const visibility = () => {
      if (document.hidden) {
        capturePosition();
        adapter.pause();
      } else if (active)
        setState({
          kind: "error",
          reason: "Welcome back. Reconnect playback to renew your session.",
        });
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      capturePosition();
      active = false;
      controller.current = null;
      document.removeEventListener("visibilitychange", visibility);
      void player.destroy();
    };
  }, [api, movie.id, retry]);
  return (
    <main className="tv-player">
      <video
        ref={video}
        playsInline
        preload="metadata"
        aria-label={movie.title}
      />
      <div className="tv-player-controls">
        <h1>{movie.title}</h1>
        <p role="status">
          {state.kind === "error" || state.kind === "unsupported"
            ? state.reason
            : state.kind === "preparing"
              ? "Checking the source format…"
              : state.kind === "loading"
                ? "Opening your film…"
                : state.kind === "conflict"
                  ? "A film is already playing on another screen."
                  : ""}
        </p>
        <div className="button-row">
          {state.kind === "conflict" ? (
            <button
              data-focus-id="replace"
              onClick={() =>
                void controller.current?.start(
                  movie.id,
                  "lg-c1",
                  position.current,
                  state.sessionId,
                )
              }
            >
              Stop other session and play here
            </button>
          ) : state.kind === "error" ? (
            <button
              data-focus-id="retry-play"
              onClick={() => setRetry((n) => n + 1)}
            >
              Reconnect playback
            </button>
          ) : state.kind === "ready" || state.kind === "paused" ? (
            <>
              <button
                data-focus-id="rewind"
                onClick={() => {
                  video.current!.currentTime = Math.max(
                    0,
                    video.current!.currentTime - 10,
                  );
                }}
              >
                −10 sec
              </button>
              <button
                className="primary"
                data-focus-id="play"
                onClick={() => {
                  if (video.current!.paused)
                    void video.current!.play().catch(() =>
                      setState({
                        kind: "error",
                        reason: "This source could not be played.",
                      }),
                    );
                  else video.current!.pause();
                }}
              >
                Play / Pause
              </button>
              <button
                data-focus-id="forward"
                onClick={() => {
                  video.current!.currentTime = Math.min(
                    video.current!.duration || 0,
                    video.current!.currentTime + 10,
                  );
                }}
              >
                +10 sec
              </button>
            </>
          ) : null}
          <button data-focus-id="close" onClick={close}>
            Close film
          </button>
        </div>
      </div>
    </main>
  );
}
