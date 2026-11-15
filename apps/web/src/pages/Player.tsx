import type {
  MovieDetail,
  Quality,
  TrackOption,
} from "../../../../packages/contracts/src/index.js";
import { useEffect, useRef, useState } from "react";
import { useApi } from "../../../../packages/client/src/api.js";
import { FilmStill } from "../../../../packages/ui/src/FilmStill.js";
import { backdropUrl } from "../../../../packages/ui/src/artwork.js";
import { Flow, Opening } from "../../../../packages/ui/src/Loading.js";
import { BrowserAdapter } from "../player/BrowserAdapter.js";
import { Preparing } from "../player/Preparing.js";
import { preferredTrack, sameLanguage } from "../player/languages.js";
import {
  readableChoices,
  TrackPanel,
  type TrackList,
} from "../player/TrackPanel.js";
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
  ["auto", "Auto, recommended"],
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
  ["C", "Next subtitle track, then off"],
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
    NonNullable<MovieDetail["audioTracks"]>
  >([]);
  const [subtitleTracks, setSubtitleTracks] = useState<
    NonNullable<MovieDetail["subtitleTracks"]>
  >([]);
  // What the stream itself offers, as the adapter reports it.
  const [streamAudio, setStreamAudio] = useState<TrackOption[]>([]);
  const [streamSubtitles, setStreamSubtitles] = useState<TrackOption[]>([]);
  // The viewer's subtitle choice for this viewing: undefined follows the
  // saved preference, null is off, otherwise a track label and language.
  const subtitleChoice = useRef<
    { label: string; language: string } | null | undefined
  >(undefined);
  const preferredSubtitles = useRef("off");
  const preferredAudio = useRef("original");
  const adapterRef = useRef<BrowserAdapter | null>(null);
  const replacement = useRef<string | undefined>(undefined);
  const video = useRef<HTMLVideoElement>(null),
    controller = useRef<PlayerController | null>(null);
  const checkpoint = useRef<{ id: string; position: number } | undefined>(
    undefined,
  );
  const [state, setState] = useState<ControllerState>({ kind: "loading" }),
    [movie, setMovie] =
      useState<Pick<MovieDetail, "title" | "posterUrl" | "stillUrl">>(),
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
    const adapter = new BrowserAdapter(video.current!);
    adapterRef.current = adapter;
    // Keep the menus in step with the stream, and keep the viewer's subtitle
    // choice when the captions are replaced (they arrive when preparation ends).
    // The language to start in is settled once per stream: the one asked for
    // (on the old one-language editions), else the saved preference. After
    // that only the viewer changes it.
    let audioSettled = false;
    const tracksChanged = () => {
      if (!active) return;
      const audioOptions = adapter.audioOptions();
      const subtitleOptions = adapter.subtitleOptions();
      setStreamAudio(audioOptions);
      setStreamSubtitles(subtitleOptions);
      if (!audioSettled && audioOptions.length > 1) {
        audioSettled = true;
        const wanted =
          audioTrack !== undefined
            ? audioOptions[audioTrack]
            : preferredTrack(audioOptions, preferredAudio.current);
        if (wanted && !wanted.active)
          void adapter.selectAudio(wanted.id).catch(() => {});
      }
      const showing = subtitleOptions.find((o) => o.active);
      const choice = subtitleChoice.current;
      // The viewer turned them off: keep them off whatever arrives.
      if (choice === null) {
        if (showing) void adapter.selectSubtitle(null).catch(() => {});
        return;
      }
      // The viewer's choice, else the saved language. A saved "off" leaves
      // alone a track the browser showed for the system's caption setting.
      const target = choice
        ? (subtitleOptions.find(
            (o) => o.label === choice.label && o.language === choice.language,
          ) ?? preferredTrack(subtitleOptions, choice.language))
        : preferredTrack(subtitleOptions, preferredSubtitles.current);
      if (target && target.id !== showing?.id)
        void adapter.selectSubtitle(target.id).catch(() => {});
    };
    const stopWatching = adapter.onTracks(tracksChanged);
    setWaiting(false);
    setEnded(false);
    setPlaying(false);
    const player = new PlayerController(
      api,
      adapter,
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
                if (!active) return;
                setAudioTracks(film.audioTracks ?? []);
                setSubtitleTracks(film.subtitleTracks ?? []);
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
          setMovie({
            title: film.title,
            posterUrl: film.posterUrl,
            stillUrl: film.stillUrl,
          });
          setAudioTracks(film.audioTracks ?? []);
          setSubtitleTracks(film.subtitleTracks ?? []);
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
      stopWatching();
      adapterRef.current = null;
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
  useEffect(() => {
    let active = true;
    api
      .preferences()
      .then((p) => {
        if (!active) return;
        preferredSubtitles.current =
          typeof p.subtitleLanguage === "string" ? p.subtitleLanguage : "off";
        preferredAudio.current =
          typeof p.audioLanguage === "string" ? p.audioLanguage : "original";
        // Apply it to captions that were already there.
        const adapter = adapterRef.current;
        const options = adapter?.subtitleOptions() ?? [];
        const target = preferredTrack(options, preferredSubtitles.current);
        if (subtitleChoice.current === undefined && target && !target.active)
          void adapter?.selectSubtitle(target.id).catch(() => {});
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [api]);
  function chooseSubtitle(id: string) {
    const adapter = adapterRef.current;
    if (!adapter) return;
    const option = streamSubtitles.find((o) => o.id === id);
    subtitleChoice.current = option
      ? { label: option.label, language: option.language }
      : null;
    void adapter.selectSubtitle(option ? option.id : null).catch(() => {});
  }
  // Audio switches inside the stream when it carries every track; otherwise
  // a different track means a different edition.
  const inStream = streamAudio.length > 1;
  // Full screen holds the picture and the menus together. Where an element
  // cannot be full screen (an iPhone), the video's own full screen is used,
  // which has its own language menus.
  const frame = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wake = () => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), 3000);
  };
  useEffect(() => {
    const change = () =>
      setFullscreen(
        document.fullscreenElement === frame.current ||
          (document as unknown as { webkitFullscreenElement?: Element })
            .webkitFullscreenElement === frame.current,
      );
    document.addEventListener("fullscreenchange", change);
    document.addEventListener("webkitfullscreenchange", change);
    return () => {
      clearTimeout(idleTimer.current);
      document.removeEventListener("fullscreenchange", change);
      document.removeEventListener("webkitfullscreenchange", change);
    };
  }, []);
  function toggleFullscreen() {
    const box = frame.current as FullscreenElement | null;
    const doc = document as unknown as {
      webkitFullscreenElement?: Element;
      webkitExitFullscreen?: () => void;
    };
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    if (doc.webkitFullscreenElement) {
      doc.webkitExitFullscreen?.();
      return;
    }
    if (box?.requestFullscreen) void box.requestFullscreen().catch(() => {});
    else if (box?.webkitRequestFullscreen) box.webkitRequestFullscreen();
    else (video.current as FullscreenElement | null)?.webkitEnterFullscreen?.();
    wake();
  }
  const textSubtitles = subtitleTracks.filter((t) => t.text);
  const pictureSubtitles = subtitleTracks.filter((t) => !t.text);
  // The lists for the audio and subtitles panel, in words people read.
  const audioChoices = readableChoices(
    inStream
      ? streamAudio.map((o) => ({
          id: o.id,
          label: audioTracks[Number(o.id)]?.label ?? o.label,
          language: o.language,
        }))
      : audioTracks.map((a) => ({
          id: String(a.index),
          label: a.label,
          language: a.language,
        })),
  );
  const playingAudio = inStream
    ? streamAudio.find((o) => o.active)?.id
    : String(
        audioTrack ??
          Math.max(
            0,
            audioTracks.findIndex((t) =>
              sameLanguage(t.language, preferredAudio.current),
            ),
          ),
      );
  const audioList: TrackList | undefined = audioChoices.length
    ? {
        options: audioChoices,
        selected: playingAudio,
        onSelect: (choice) => {
          if (inStream)
            void adapterRef.current?.selectAudio(choice).catch(() => {});
          else setAudioTrack(Number(choice));
        },
        note:
          audioChoices.length === 1
            ? "The only language in this film."
            : !inStream && visible
              ? "The edition with every language is still being made. Choosing another language now prepares the film again; once it is ready, languages switch at once."
              : undefined,
      }
    : undefined;
  const subtitleChoices = readableChoices([
    ...streamSubtitles.map((o) => ({
      id: o.id,
      label: o.label,
      language: o.language,
    })),
    // Text subtitles not yet available, and picture subtitles, are listed but
    // cannot be chosen, so the viewer knows what the film carries.
    ...(streamSubtitles.length === 0
      ? textSubtitles.map((t, i) => ({
          id: `waiting-${i}`,
          label: t.label,
          language: t.language,
          detail: "after preparation",
          disabled: true,
        }))
      : []),
    ...pictureSubtitles.map((t, i) => ({
      id: `picture-${i}`,
      label: t.label,
      language: t.language,
      detail: "picture, can’t be shown",
      disabled: true,
    })),
  ]);
  const subtitleList: TrackList | undefined =
    subtitleChoices.length || subtitleTracks.length
      ? {
          options: [{ id: "", label: "Off" }, ...subtitleChoices],
          selected: streamSubtitles.find((o) => o.active)?.id ?? "",
          onSelect: chooseSubtitle,
          note:
            streamSubtitles.length === 0 && textSubtitles.length > 0
              ? "Subtitles can be chosen once this film’s preparation has finished."
              : pictureSubtitles.length > 0
                ? "Picture subtitles from a Blu-ray or DVD cannot be shown by a browser."
                : undefined,
        }
      : undefined;
  const pictureList: TrackList = {
    options: qualities.map(([id, label]) => {
      const [name, ...rest] = label.split(", ");
      return { id, label: name!, detail: rest.join(", ") || undefined };
    }),
    selected: quality,
    onSelect: (choice) => setQuality(choice as Quality),
    note: "A different picture is prepared again, and never larger than the original.",
  };
  const activeSubtitle = streamSubtitles.find((o) => o.active);
  const trackSummary = [
    audioChoices.find((o) => o.id === playingAudio)?.label,
    activeSubtitle
      ? `${subtitleChoices.find((o) => o.id === activeSubtitle.id)?.label ?? activeSubtitle.label} subtitles`
      : "Subtitles off",
  ]
    .filter(Boolean)
    .join(" · ");
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
        const adapter = adapterRef.current;
        const options = adapter?.subtitleOptions() ?? [];
        if (!adapter || !options.length) say("No subtitles to show yet");
        else {
          // Off, then each track in turn, then off again.
          const at = options.findIndex((o) => o.active);
          const next = options[at + 1];
          subtitleChoice.current = next
            ? { label: next.label, language: next.language }
            : null;
          void adapter.selectSubtitle(next ? next.id : null).catch(() => {});
          say(next ? `Subtitles: ${next.label}` : "Subtitles off");
        }
      } else if (key === "f") {
        toggleFullscreen();
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
        ref={frame}
        className={`player-frame${idle ? " is-idle" : ""}${playing ? " is-playing" : ""}`}
        onPointerMove={wake}
        onFocusCapture={wake}
      >
        <div
          className={`stage${visible ? " stage-live" : ""}`}
          data-state={state.kind}
        >
          {!visible && (
            <div className="stage-backdrop">
              <FilmStill url={movie ? backdropUrl(movie) : undefined} />
            </div>
          )}
          <video
            ref={video}
            controls
            // Full screen is the frame's, so the language menus come along.
            controlsList="nofullscreen"
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
                <button onClick={() => setRetry((n) => n + 1)}>
                  Try again
                </button>
                <a
                  className="button"
                  href={`#/movie/${encodeURIComponent(id)}`}
                >
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
          <TrackPanel
            summary={trackSummary}
            audio={audioList}
            subtitles={subtitleList}
            picture={pictureList}
          />
          <button
            type="button"
            className="fullscreen-button"
            aria-pressed={fullscreen}
            onClick={toggleFullscreen}
          >
            {fullscreen ? "Exit full screen" : "Full screen"}
          </button>
          {state.kind === "ready" && state.session.label && (
            <span className="playback-edition">
              Now playing: {state.session.label}
            </span>
          )}
        </div>
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
