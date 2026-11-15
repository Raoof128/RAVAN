import type {
  MovieDetail,
  Quality,
} from "../../../../packages/contracts/src/index.js";
import { useEffect, useRef, useState } from "react";
import { useApi } from "../../../../packages/client/src/api.js";
import { FilmStill } from "../../../../packages/ui/src/FilmStill.js";
import { Flow, Opening } from "../../../../packages/ui/src/Loading.js";
import { BrowserAdapter } from "../player/BrowserAdapter.js";
import { Preparing } from "../player/Preparing.js";
import {
  detectCapabilities,
  refineCapabilities,
} from "../player/capabilities.js";
// Ask the device how well it decodes each codec as soon as the player is
// loaded; the answer is ready long before a film is started.
void refineCapabilities().catch(() => {});
import {
  PlayerController,
  type ControllerState,
} from "../player/PlayerController.js";
import { Icon } from "../../../../packages/ui/src/Icon.js";
import { forgetLibrary } from "../libraryCache.js";
import { useTitle } from "../router.js";
const qualities: Array<[Quality, string]> = [
  ["auto", "Auto (recommended)"],
  ["original", "Original resolution"],
  ["480p", "480p, saves data"],
  ["720p", "720p HD"],
  ["1080p", "1080p Full HD"],
  ["1440p", "1440p"],
  ["2160p", "2160p 4K"],
];
const shortcuts: Array<[string, string]> = [
  ["Space or K", "Play or pause"],
  ["← →", "Back or forward 10 seconds"],
  ["↑ ↓", "Volume"],
  ["M", "Mute"],
  ["C", "Captions"],
  ["F", "Full screen"],
];
type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => void;
  webkitEnterFullscreen?: () => void;
};
export function Player({
  id,
  startOver = false,
}: {
  id: string;
  startOver?: boolean;
}) {
  const api = useApi();
  const [quality, setQuality] = useState<Quality>("auto");
  const [audioTrack, setAudioTrack] = useState<number | undefined>();
  const [audioTracks, setAudioTracks] = useState<
    Array<{ index: number; label: string }>
  >([]);
  const replacement = useRef<string | undefined>(undefined);
  const video = useRef<HTMLVideoElement>(null),
    controller = useRef<PlayerController | null>(null);
  const checkpoint = useRef<{ id: string; position: number } | undefined>(
    undefined,
  );
  const [state, setState] = useState<ControllerState>({ kind: "loading" }),
    [movie, setMovie] = useState<Pick<MovieDetail, "title" | "posterUrl">>(),
    [retry, setRetry] = useState(0),
    [resume, setResume] = useState(0),
    [waiting, setWaiting] = useState(false),
    [playing, setPlaying] = useState(false),
    [ended, setEnded] = useState(false),
    [notice, setNotice] = useState("");
  const title = movie?.title ?? "Your film";
  useTitle(movie?.title);
  useEffect(() => {
    let active = true;
    // Watching changes what the library shows: positions, and what is in progress.
    forgetLibrary(api);
    setWaiting(false);
    setEnded(false);
    setPlaying(false);
    const player = new PlayerController(
      api,
      new BrowserAdapter(video.current!),
      (s) => {
        if (active) {
          // The controller says "loading" before each of its checks on a film
          // being prepared. The panel stays up between them.
          setState((previous) =>
            s.kind === "loading" && previous.kind === "preparing"
              ? previous
              : s,
          );
          if (s.kind === "ready")
            void api
              .detail(id)
              .then((film) => {
                if (active) setAudioTracks(film.audioTracks ?? []);
              })
              .catch(() => {});
        }
      },
      { quality, audioTrack, capabilities: detectCapabilities() },
    );
    controller.current = player;
    api
      .detail(id)
      .then((film) => {
        if (active) {
          setMovie({ title: film.title, posterUrl: film.posterUrl });
          setAudioTracks(film.audioTracks ?? []);
          const start =
            checkpoint.current?.id === id
              ? checkpoint.current.position
              : startOver
                ? 0
                : film.resumeMs;
          setResume(start);
          void player.start(id, "web", start, replacement.current);
          replacement.current = undefined;
        }
      })
      .catch(() => {
        if (active)
          setState({ kind: "error", reason: "The film could not be loaded." });
      });
    return () => {
      active = false;
      if (video.current && video.current.readyState > 0)
        checkpoint.current = {
          id,
          position: video.current.ended ? 0 : video.current.currentTime * 1000,
        };
      replacement.current = player.sessionId;
      controller.current = null;
      void player.destroy();
    };
  }, [api, id, startOver, retry, quality, audioTrack]);
  const visible = state.kind === "ready" || state.kind === "paused";
  // What the element itself reports: stalled for data, playing, finished.
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const stall = () => setWaiting(true);
    const flowing = () => setWaiting(false);
    const play = () => {
      setPlaying(true);
      setEnded(false);
    };
    const pause = () => setPlaying(false);
    const end = () => {
      setPlaying(false);
      setEnded(true);
    };
    const events: Array<[string, () => void]> = [
      ["waiting", stall],
      ["playing", flowing],
      ["canplay", flowing],
      ["seeked", flowing],
      ["play", play],
      ["pause", pause],
      ["ended", end],
    ];
    for (const [name, handler] of events)
      element.addEventListener(name, handler);
    return () => {
      for (const [name, handler] of events)
        element.removeEventListener(name, handler);
    };
  }, []);
  // The same keys in every browser, wherever focus is on the page.
  useEffect(() => {
    if (!visible) return;
    let clear: ReturnType<typeof setTimeout>;
    const say = (text: string) => {
      setNotice(text);
      clearTimeout(clear);
      clear = setTimeout(() => setNotice(""), 1600);
    };
    const handler = (event: KeyboardEvent) => {
      const element = video.current;
      const target = event.target as HTMLElement | null;
      if (
        !element ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (target &&
          target !== element &&
          /^(INPUT|SELECT|TEXTAREA|BUTTON|A|SUMMARY)$/.test(target.tagName))
      )
        return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (key === " " || key === "k") {
        if (element.paused) {
          void element.play().catch(() => {});
          say("Playing");
        } else {
          element.pause();
          say("Paused");
        }
      } else if (key === "ArrowLeft" || key === "ArrowRight") {
        const step = key === "ArrowLeft" ? -10 : 10;
        const end = Number.isFinite(element.duration)
          ? element.duration
          : element.currentTime + step;
        element.currentTime = Math.max(
          0,
          Math.min(end, element.currentTime + step),
        );
        say(step < 0 ? "Back 10 seconds" : "Forward 10 seconds");
      } else if (key === "ArrowUp" || key === "ArrowDown") {
        element.muted = false;
        element.volume = Math.max(
          0,
          Math.min(1, element.volume + (key === "ArrowUp" ? 0.1 : -0.1)),
        );
        say(`Volume ${Math.round(element.volume * 100)}%`);
      } else if (key === "m") {
        element.muted = !element.muted;
        say(element.muted ? "Muted" : "Sound on");
      } else if (key === "c") {
        const tracks = Array.from(element.textTracks).filter(
          (t) => t.kind === "subtitles" || t.kind === "captions",
        );
        if (!tracks.length) say("This film has no captions");
        else {
          const on = tracks.some((t) => t.mode === "showing");
          for (const t of tracks) t.mode = "disabled";
          if (!on) tracks[0]!.mode = "showing";
          say(on ? "Captions off" : `Captions: ${tracks[0]!.label || "on"}`);
        }
      } else if (key === "f") {
        const stage = element as FullscreenElement;
        if (document.fullscreenElement) void document.exitFullscreen();
        else if (stage.requestFullscreen)
          void stage.requestFullscreen().catch(() => {});
        else if (stage.webkitRequestFullscreen) stage.webkitRequestFullscreen();
        else stage.webkitEnterFullscreen?.();
      } else return;
      event.preventDefault();
    };
    document.addEventListener("keydown", handler, true);
    return () => {
      clearTimeout(clear);
      setNotice("");
      document.removeEventListener("keydown", handler, true);
    };
  }, [visible]);
  return (
    <main id="main" className="player-page">
      <div className="player-heading">
        <h1 data-long={title.length > 36 || undefined}>{title}</h1>
        <a className="button" href={`#/movie/${encodeURIComponent(id)}`}>
          Close player
        </a>
      </div>
      <div
        className={`stage${visible ? " stage-live" : ""}`}
        data-state={state.kind}
      >
        {!visible && (
          <div className="stage-backdrop">
            <FilmStill url={movie?.posterUrl} />
          </div>
        )}
        <video
          ref={video}
          controls
          playsInline
          preload="metadata"
          aria-label={`${title} player`}
          hidden={!visible}
        />
        {visible && waiting && (
          <div className="stage-buffering" role="status">
            <Flow />
            <span className="sr-only">Buffering</span>
          </div>
        )}
        {visible && !playing && state.kind === "paused" && !ended && (
          <button
            className="stage-play primary"
            onClick={() => void video.current?.play().catch(() => {})}
          >
            <Icon name="play" />
            Play film
          </button>
        )}
        {visible && ended && (
          <div className="stage-ended">
            <p>The end.</p>
            <div className="button-row">
              <button
                className="primary"
                onClick={() => {
                  const element = video.current;
                  if (!element) return;
                  element.currentTime = 0;
                  void element.play().catch(() => {});
                }}
              >
                Watch again
              </button>
              <a className="button" href="#/library">
                Back to the collection
              </a>
            </div>
          </div>
        )}
        {visible && (
          <p className="stage-notice" aria-live="polite">
            {notice}
          </p>
        )}
        {state.kind === "loading" ? (
          <Opening words="Connecting to your film" />
        ) : state.kind === "preparing" ? (
          <Preparing
            phase={state.phase}
            progress={state.progress}
            reason={state.reason}
          />
        ) : state.kind === "unsupported" ? (
          <section className="stage-message" role="alert">
            <h2>This film can’t play here yet.</h2>
            <p>{state.reason}</p>
            <div className="button-row">
              <button onClick={() => setRetry((n) => n + 1)}>Try again</button>
              <a className="button" href={`#/movie/${encodeURIComponent(id)}`}>
                Back to the film
              </a>
            </div>
          </section>
        ) : state.kind === "conflict" ? (
          <section className="stage-message" role="status">
            <h2>A film is already playing.</h2>
            <p>Continuing here will stop playback on the other screen.</p>
            <div className="button-row">
              <button
                className="primary"
                onClick={() =>
                  void controller.current?.start(
                    id,
                    "web",
                    resume,
                    state.sessionId,
                  )
                }
              >
                Stop that session and play here
              </button>
            </div>
          </section>
        ) : state.kind === "error" ? (
          <section className="stage-message" role="alert">
            <h2>Let’s try that again.</h2>
            <p>{state.reason}</p>
            <div className="button-row">
              <button
                className="primary"
                onClick={() => setRetry((n) => n + 1)}
              >
                Retry playback
              </button>
            </div>
          </section>
        ) : null}
      </div>
      <div className="playback-options">
        <label>
          <span>Quality</span>
          <select
            aria-label="Playback quality"
            value={quality}
            onChange={(e) => setQuality(e.target.value as Quality)}
          >
            {qualities.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {audioTracks.length > 1 && (
          <label>
            <span>Audio</span>
            <select
              aria-label="Audio track"
              value={audioTrack ?? ""}
              onChange={(e) =>
                setAudioTrack(
                  e.target.value === "" ? undefined : Number(e.target.value),
                )
              }
            >
              <option value="">Preferred / original</option>
              {audioTracks.map((a) => (
                <option key={a.index} value={a.index}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {state.kind === "ready" && state.session.label && (
          <span className="playback-edition">
            Now playing: {state.session.label}
          </span>
        )}
      </div>
      <details className="player-help">
        <summary>Keyboard shortcuts</summary>
        <dl>
          {shortcuts.map(([keys, action]) => (
            <div key={keys}>
              <dt>{keys}</dt>
              <dd>{action}</dd>
            </div>
          ))}
        </dl>
      </details>
      <p className="fine-print">
        Your position is saved while watching and when you pause. Quality
        choices never upscale the source; audio and caption choices depend on
        the file.
      </p>
    </main>
  );
}
