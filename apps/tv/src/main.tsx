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
  TrackOption,
} from "../../../packages/contracts/src/index.js";
import { Poster } from "../../../packages/ui/src/MovieCard.js";
import { backdropUrl } from "../../../packages/ui/src/artwork.js";
import { Icon } from "../../../packages/ui/src/Icon.js";
import { installRemote, restoreFocus, saveFocus } from "./focus.js";
import { pairDevice, credentialStore } from "./pairing.js";
import { WebOSAdapter } from "./platforms/WebOSAdapter.js";
import { detectPlatform } from "./platforms/detect.js";
import {
  PlayerController,
  type ControllerState,
} from "../../web/src/player/PlayerController.js";
import {
  Flow,
  FlowProgress,
  Opening,
  Placeholder,
} from "../../../packages/ui/src/Loading.js";
import { Preparing } from "../../web/src/player/Preparing.js";
import { sameLanguage } from "../../web/src/player/languages.js";
import "../../../packages/ui/src/tokens.css";
import "../../../packages/ui/src/loading.css";
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
/**
 * A picture from the server, fetched with this TV's credential (an img cannot
 * send it) and shown through a local object URL, released when unused.
 */
function useArtwork(api: ApiClient, url?: string) {
  const [source, setSource] = useState<string>();
  useEffect(() => {
    setSource(undefined);
    if (!url || !/^\/api\/artwork\/[a-f0-9]{32}$/.test(url)) return;
    const controller = new AbortController();
    let created: string | undefined;
    api
      .artwork(url, controller.signal)
      .then((blob) => {
        created = URL.createObjectURL(blob);
        setSource(created);
      })
      .catch(() => {});
    return () => {
      controller.abort();
      if (created) URL.revokeObjectURL(created);
    };
  }, [api, url]);
  return source;
}
function TVPoster({
  api,
  movie,
  large,
}: {
  api: ApiClient;
  movie: MovieCard;
  large?: boolean;
}) {
  const source = useArtwork(api, movie.posterUrl);
  // Never the server's address itself: an img would ask without the credential.
  const own = movie.posterUrl?.startsWith("/api/artwork/");
  return (
    <Poster
      movie={own && !source ? { ...movie, posterUrl: undefined } : movie}
      large={large}
      source={source}
    />
  );
}
function TVBackdrop({ api, movie }: { api: ApiClient; movie?: MovieCard }) {
  const url = movie ? backdropUrl(movie) : undefined;
  const source = useArtwork(api, url);
  // Only bundled samples are given by address; the server's are fetched.
  return (
    <FilmStill
      url={url?.startsWith("/api/artwork/") ? undefined : url}
      source={source}
      priority
    />
  );
}
function greeting() {
  const hour = new Date().getHours();
  return hour < 5
    ? "GOOD EVENING"
    : hour < 12
      ? "GOOD MORNING"
      : hour < 18
        ? "GOOD AFTERNOON"
        : "GOOD EVENING";
}
function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds)),
    h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
function TV({ api }: { api: ApiClient }) {
  const [page, setPage] = useState<
      "loading" | "pair" | "library" | "detail" | "player" | "settings"
    >("loading"),
    [items, setItems] = useState<MovieCard[]>([]),
    [movie, setMovie] = useState<MovieDetail>(),
    [message, setMessage] = useState(""),
    [code, setCode] = useState(""),
    [retry, setRetry] = useState(0),
    [cursor, setCursor] = useState<string | null>(null),
    [loaded, setLoaded] = useState(false),
    [opening, setOpening] = useState<string>(),
    [moreBusy, setMoreBusy] = useState(false);
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
    setMessage("");
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
          setLoaded(true);
          setMessage("");
          setItems(data.items);
          setCursor(data.nextCursor);
        }
      })
      .catch(() => {
        if (active) {
          setLoaded(true);
          setMessage(
            "We couldn’t load your films. Check the connection or reconnect this TV.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [page, retry, api]);
  async function open(id: string) {
    if (opening) return;
    setOpening(id);
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
    } finally {
      setOpening(undefined);
    }
  }
  return (
    <div className="tv-shell" data-page={page}>
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
          <h1>Your seat is ready.</h1>
          <p>
            Open RAVAN on your phone, choose Your cinema,
            <br />
            then approve this TV with the code below.
          </p>
          <div className="pair-code" aria-live="polite">
            {code ? (
              <>
                <span aria-hidden="true">{code.slice(0, 4)}</span>
                <span aria-hidden="true">{code.slice(4)}</span>
                <span className="sr-only">
                  Pairing code {code.split("").join(" ")}
                </span>
              </>
            ) : message ? (
              <span className="pair-code-empty">— — — —</span>
            ) : (
              <span className="pair-code-wait">
                <Flow />
                <span className="sr-only">Requesting a pairing code</span>
              </span>
            )}
          </div>
          {code && !message && (
            <p className="pair-waiting">
              Waiting for approval on your phone
              <Flow />
            </p>
          )}
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
            <TVBackdrop api={api} movie={items[0]} />
          </div>
          <p className="eyebrow">{greeting()}. MAKE YOURSELF AT HOME.</p>
          <h1>Something worth watching.</h1>
          {message && (
            <div>
              <p role="status">{message}</p>
              <button
                data-focus-id="retry"
                onClick={() => setRetry((n) => n + 1)}
              >
                Try again
              </button>
            </div>
          )}
          {!loaded ? (
            <Placeholder label="Loading your films" className="tv-grid-wait">
              <div className="tv-grid">
                {[0, 1, 2, 3, 4, 5].map((n) => (
                  <div className="tv-movie" key={n}>
                    <span className="sk tv-sk-poster" />
                    <span className="sk sk-line tv-sk-line" />
                  </div>
                ))}
              </div>
            </Placeholder>
          ) : !items.length && !message ? (
            <p>
              Your collection will appear here after you choose a folder on your
              phone.
            </p>
          ) : (
            <div className="tv-grid">
              {items.map((m) => (
                <button
                  className={`tv-movie${opening === m.id ? " is-opening" : ""}`}
                  aria-busy={opening === m.id || undefined}
                  data-focus-id={`movie-${m.id}`}
                  key={m.id}
                  onClick={() => void open(m.id)}
                >
                  <TVPoster api={api} movie={m} />
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
              className={moreBusy ? "is-pending" : undefined}
              aria-busy={moreBusy || undefined}
              onClick={() => {
                if (moreBusy) return;
                setMoreBusy(true);
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
                  .catch(() => setMessage("More films could not be loaded."))
                  .finally(() => setMoreBusy(false));
              }}
            >
              More films
            </button>
          )}
        </main>
      ) : page === "detail" && movie ? (
        <main className="tv-detail">
          <div className="tv-library-atmosphere">
            <TVBackdrop api={api} movie={movie} />
          </div>
          <TVPoster api={api} movie={movie} large />
          <section>
            <h1>{movie.title}</h1>
            {movie.year ? <p className="tv-year">{movie.year}</p> : null}
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
                <Icon name="play" size={24} />
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
                // Give the credential up on the server first, while this
                // screen can still prove it holds it; then forget it here
                // whether or not the server could be reached.
                void api
                  .forgetDevice()
                  .catch(() => {})
                  .then(() => {
                    credentialStore.clear();
                    api.setDeviceCredential(undefined);
                    setPage("pair");
                  });
              }}
            >
              Disconnect this TV
            </button>
          </div>
        </main>
      ) : (
        <main className="tv-pair tv-opening">
          <Opening words="Opening your cinema" />
        </main>
      )}
      <footer className="tv-footer" hidden={page === "player"}>
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
    [retry, setRetry] = useState(0),
    [time, setTime] = useState({ at: 0, of: 0 }),
    [playing, setPlaying] = useState(false),
    [stalled, setStalled] = useState(false),
    [shown, setShown] = useState(true),
    [audioTrack, setAudioTrack] = useState<number | undefined>(),
    // A press of Audio only names the next language; preparing it waits until
    // the presses stop, so several presses ask for one edition, not several.
    [pendingAudio, setPendingAudio] = useState<number | undefined>(),
    [preferredAudio, setPreferredAudio] = useState(0),
    [subtitles, setSubtitles] = useState<TrackOption[]>([]),
    [streamAudio, setStreamAudio] = useState<TrackOption[]>([]);
  const adapterRef = useRef<WebOSAdapter | null>(null);
  const audioTracks = movie.audioTracks ?? [];
  useEffect(() => {
    let active = true;
    // The edition plays the saved language unless another was chosen.
    api
      .preferences()
      .then((p) => {
        const index = audioTracks.findIndex((t) =>
          sameLanguage(t.language, p.audioLanguage),
        );
        if (active && index >= 0) setPreferredAudio(index);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [api, movie.id]);
  useEffect(() => {
    if (pendingAudio === undefined) return;
    const timer = setTimeout(() => {
      setPendingAudio(undefined);
      if (pendingAudio !== (audioTrack ?? preferredAudio))
        setAudioTrack(pendingAudio);
    }, 1500);
    return () => clearTimeout(timer);
  }, [pendingAudio]);
  const shownRef = useRef(true);
  const hide = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const live = state.kind === "ready" || state.kind === "paused";
  // When the film is ready the transport arrives beside Close, which had the
  // focus while there was nothing else. OK should now mean Play or Pause.
  useEffect(() => {
    if (live)
      document.querySelector<HTMLElement>('[data-focus-id="play"]')?.focus();
  }, [live]);
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
    adapterRef.current = adapter;
    const stopTracks = adapter.onTracks(() => {
      if (!active) return;
      setSubtitles(adapter.subtitleOptions());
      setStreamAudio(adapter.audioOptions());
    });
    const player = new PlayerController(
      api,
      adapter,
      (s) => {
        // The controller says "loading" before each of its checks on a film
        // being prepared. The panel stays up between them.
        if (active)
          setState((previous) =>
            s.kind === "loading" && previous.kind === "preparing"
              ? previous
              : s,
          );
      },
      audioTrack === undefined ? {} : { audioTrack },
    );
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
      stopTracks();
      adapterRef.current = null;
      controller.current = null;
      document.removeEventListener("visibilitychange", visibility);
      void player.destroy();
    };
  }, [api, movie.id, retry, audioTrack]);
  const activeSubtitle = subtitles.find((o) => o.active);
  const inStream = streamAudio.length > 1;
  const currentAudio = inStream
    ? streamAudio.findIndex((o) => o.active)
    : (pendingAudio ?? audioTrack ?? preferredAudio);
  // What the element reports, at most once a second: the C1 need not repaint
  // the transport for every frame of the film.
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let last = -1;
    const tick = () => {
      const at = Math.floor(element.currentTime);
      if (at === last) return;
      last = at;
      setTime({
        at,
        of: Number.isFinite(element.duration) ? element.duration : 0,
      });
    };
    const play = () => setPlaying(true);
    const pause = () => setPlaying(false);
    const stall = () => setStalled(true);
    const flowing = () => setStalled(false);
    const events: Array<[string, () => void]> = [
      ["timeupdate", tick],
      ["durationchange", tick],
      ["play", play],
      ["pause", pause],
      ["ended", pause],
      ["waiting", stall],
      ["playing", flowing],
      ["canplay", flowing],
      ["seeked", flowing],
    ];
    for (const [name, handler] of events)
      element.addEventListener(name, handler);
    return () => {
      for (const [name, handler] of events)
        element.removeEventListener(name, handler);
    };
  }, []);
  // The transport steps aside while the film plays and returns on any key.
  // The key that brings it back does nothing else, so a press on a control the
  // viewer could not see never acts.
  useEffect(() => {
    const reveal = () => {
      shownRef.current = true;
      setShown(true);
      clearTimeout(hide.current);
      if (playing && live)
        hide.current = setTimeout(() => {
          shownRef.current = false;
          setShown(false);
        }, 4500);
    };
    reveal();
    const key = (event: KeyboardEvent) => {
      const element = video.current;
      const back =
        event.key === "Escape" ||
        event.key === "Backspace" ||
        event.keyCode === 461;
      const hidden = !shownRef.current;
      reveal();
      if (!element || !live) return;
      // Transport keys on the remote act whether or not the bar is showing.
      const code = event.keyCode;
      if (code === 415 || code === 19 || code === 179 || code === 413) {
        event.preventDefault();
        if (code === 415 || (code === 179 && element.paused))
          void element.play().catch(() => {});
        else element.pause();
        return;
      }
      if (code === 412 || code === 417) {
        event.preventDefault();
        element.currentTime = Math.max(
          0,
          element.currentTime + (code === 412 ? -30 : 30),
        );
        return;
      }
      if (hidden && !back) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointermove", reveal);
    return () => {
      clearTimeout(hide.current);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointermove", reveal);
    };
  }, [playing, live]);
  const seek = (delta: number) => {
    const element = video.current;
    if (!element) return;
    element.currentTime = Math.max(
      0,
      Math.min(element.duration || 0, element.currentTime + delta),
    );
  };
  return (
    <main
      className={`tv-player${live && playing && !shown ? " tv-player-idle" : ""}`}
    >
      <video
        ref={video}
        playsInline
        preload="metadata"
        aria-label={movie.title}
      />
      {live && stalled && (
        <div className="tv-player-buffering" role="status">
          <Flow />
          <span className="sr-only">Buffering</span>
        </div>
      )}
      {!live && (
        <div className="tv-player-wait">
          {state.kind === "loading" ? (
            <Opening words="Opening your film" />
          ) : state.kind === "preparing" ? (
            <Preparing
              phase={state.phase}
              progress={state.progress}
              reason={state.reason}
            />
          ) : (
            <section className="tv-player-message">
              <h2>
                {state.kind === "conflict"
                  ? "A film is already playing."
                  : state.kind === "unsupported"
                    ? "This film can’t play on this TV yet."
                    : "Playback has stopped."}
              </h2>
              <p role="status">
                {state.kind === "conflict"
                  ? "A film is already playing on another screen."
                  : state.kind === "error" || state.kind === "unsupported"
                    ? state.reason
                    : ""}
              </p>
            </section>
          )}
        </div>
      )}
      <div className="tv-player-controls">
        <h1>{movie.title}</h1>
        {live && (
          <div className="tv-transport">
            <span>{clock(time.at)}</span>
            {time.of > 0 ? (
              <>
                <FlowProgress
                  value={(time.at / time.of) * 100}
                  label="Position in the film"
                />
                <span>{clock(time.of)}</span>
              </>
            ) : (
              <span className="tv-transport-open" />
            )}
          </div>
        )}
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
          ) : live ? (
            <>
              <button data-focus-id="rewind" onClick={() => seek(-10)}>
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
                {playing ? "Pause" : "Play"}
              </button>
              <button data-focus-id="forward" onClick={() => seek(10)}>
                +10 sec
              </button>
              {subtitles.length > 0 && (
                <button
                  data-focus-id="subtitles"
                  onClick={() => {
                    // Off, then each track in turn, then off again.
                    const at = subtitles.findIndex((o) => o.active);
                    const next = subtitles[at + 1];
                    void adapterRef.current
                      ?.selectSubtitle(next ? next.id : null)
                      .catch(() => {});
                  }}
                >
                  Subtitles: {activeSubtitle ? activeSubtitle.label : "Off"}
                </button>
              )}
              {(inStream || audioTracks.length > 1) && (
                <button
                  data-focus-id="audio"
                  onClick={() => {
                    const count = inStream
                      ? streamAudio.length
                      : audioTracks.length;
                    const next = (Math.max(0, currentAudio) + 1) % count;
                    if (inStream)
                      void adapterRef.current
                        ?.selectAudio(String(next))
                        .catch(() => {});
                    // This edition has one language: prepare the next one,
                    // once the viewer has stopped pressing.
                    else setPendingAudio(next);
                  }}
                >
                  Audio:{" "}
                  {audioTracks[Math.max(0, currentAudio)]?.label ??
                    streamAudio[Math.max(0, currentAudio)]?.label ??
                    "Original"}
                </button>
              )}
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
