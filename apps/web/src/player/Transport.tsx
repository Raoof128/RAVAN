import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { Icon } from "../../../../packages/ui/src/Icon.js";

/** "42:10", or "1:58:00" past an hour. */
export function clockText(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}
/** A length in words: "1 hour 16 minutes", "16 minutes", "40 seconds". */
export function lengthWords(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60);
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (h) return m ? `${unit(h, "hour")} ${unit(m, "minute")}` : unit(h, "hour");
  if (m) return unit(m, "minute");
  return unit(s, "second");
}

type Media = {
  time: number;
  /** How far the film can be played to: its length, or what is written so far. */
  span: number;
  buffered: number;
  paused: boolean;
  muted: boolean;
  volume: number;
  started: boolean;
};
function read(video: HTMLVideoElement, started: boolean): Media {
  const seekable = video.seekable;
  const span = Number.isFinite(video.duration)
    ? video.duration
    : seekable.length
      ? seekable.end(seekable.length - 1)
      : 0;
  let buffered = 0;
  for (let i = 0; i < video.buffered.length; i++)
    if (video.buffered.start(i) <= video.currentTime + 0.5)
      buffered = Math.max(buffered, video.buffered.end(i));
  return {
    time: video.currentTime,
    span,
    buffered,
    paused: video.paused,
    muted: video.muted || video.volume === 0,
    volume: video.volume,
    started: started || !video.paused,
  };
}

/**
 * RAVAN's own controls. The seek line is the copper line over the Ā in the
 * wordmark, and its playhead is that mark, riding above the line. The
 * controls act on the video element only; PlayerController keeps the
 * session, tickets and recovery.
 */
export function Transport({
  video,
  title,
  caption,
  shown,
  onWake,
  onHide,
  onHold,
  fullscreen,
  onFullscreen,
  next,
  onNext,
}: {
  video: RefObject<HTMLVideoElement | null>;
  title: string;
  /** Shown above the line in full screen: the episode, when there is one. */
  caption?: string;
  shown: boolean;
  onWake: () => void;
  onHide: () => void;
  /** True while the pointer rests on the bar: it must not fade under it. */
  onHold: (holding: boolean) => void;
  fullscreen: boolean;
  onFullscreen: () => void;
  next?: { label: string; title: string };
  onNext?: () => void;
}) {
  const [media, setMedia] = useState<Media>({
    time: 0,
    span: 0,
    buffered: 0,
    paused: true,
    muted: false,
    volume: 1,
    started: false,
  });
  const started = useRef(false);
  const [flash, setFlash] = useState<{ icon: "play" | "pause"; n: number }>();
  const [nudge, setNudge] = useState<{ side: "back" | "forward"; n: number }>();
  const [remaining, setRemaining] = useState(false);
  const [pip, setPip] = useState(false);
  // The element reports four times a second at most; that is all the line needs.
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = read(element, started.current);
        started.current = next.started;
        setMedia(next);
      });
    };
    let flashed = 0;
    const toggled = (icon: "play" | "pause") => () => {
      update();
      // Only a change the viewer made after the film began, never the end.
      if (!started.current || element.ended) return;
      setFlash({ icon, n: ++flashed });
    };
    const played = toggled("play"),
      paused = toggled("pause");
    const events: Array<[string, () => void]> = [
      ["timeupdate", update],
      ["durationchange", update],
      ["progress", update],
      ["volumechange", update],
      ["loadedmetadata", update],
      ["seeked", update],
      ["play", played],
      ["pause", paused],
    ];
    for (const [name, handler] of events)
      element.addEventListener(name, handler);
    const pipChange = () =>
      setPip(document.pictureInPictureElement === element);
    element.addEventListener("enterpictureinpicture", pipChange);
    element.addEventListener("leavepictureinpicture", pipChange);
    update();
    return () => {
      cancelAnimationFrame(frame);
      for (const [name, handler] of events)
        element.removeEventListener(name, handler);
      element.removeEventListener("enterpictureinpicture", pipChange);
      element.removeEventListener("leavepictureinpicture", pipChange);
    };
  }, [video]);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(undefined), 700);
    return () => clearTimeout(timer);
  }, [flash]);
  useEffect(() => {
    if (!nudge) return;
    const timer = setTimeout(() => setNudge(undefined), 650);
    return () => clearTimeout(timer);
  }, [nudge]);

  const element = () => video.current;
  const togglePlay = () => {
    const v = element();
    if (!v) return;
    if (v.paused || v.ended) void v.play().catch(() => {});
    else v.pause();
  };
  const skip = (seconds: number) => {
    const v = element();
    if (!v) return;
    const end = media.span || v.currentTime + seconds;
    v.currentTime = Math.max(0, Math.min(end, v.currentTime + seconds));
  };
  const toggleMute = () => {
    const v = element();
    if (!v) return;
    if (v.muted || v.volume === 0) {
      v.muted = false;
      if (v.volume === 0) v.volume = 0.6;
    } else v.muted = true;
  };
  const pipAvailable =
    typeof document !== "undefined" &&
    (document as { pictureInPictureEnabled?: boolean })
      .pictureInPictureEnabled === true;
  const togglePip = () => {
    const v = element() as
      | (HTMLVideoElement & {
          requestPictureInPicture?: () => Promise<unknown>;
        })
      | null;
    if (!v) return;
    if (document.pictureInPictureElement)
      void document.exitPictureInPicture().catch(() => {});
    else void v.requestPictureInPicture?.().catch(() => {});
  };

  // The middle of the picture. A click plays or pauses, a double click is
  // full screen. On a touch screen a tap shows or hides the controls and a
  // double tap on either side moves ten seconds.
  const lastTouch = useRef({ at: 0, x: 0 });
  const touched = useRef(false);
  const onSurfaceUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    touched.current = event.pointerType === "touch";
    if (!touched.current) return;
    const box = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width;
    const now = Date.now();
    const double =
      now - lastTouch.current.at < 320 &&
      Math.abs(x - lastTouch.current.x) < 0.2;
    lastTouch.current = { at: now, x };
    if (double && (x < 1 / 3 || x > 2 / 3)) {
      const side = x < 1 / 3 ? "back" : "forward";
      skip(side === "back" ? -10 : 10);
      setNudge({ side, n: now });
      onWake();
      return;
    }
    if (shown && !media.paused) onHide();
    else onWake();
  };
  const onSurfaceClick = () => {
    if (touched.current) return;
    togglePlay();
    onWake();
  };

  const fraction = media.span ? Math.min(1, media.time / media.span) : 0;
  const loaded = media.span ? Math.min(1, media.buffered / media.span) : 0;
  const pausedHere = media.paused && media.span > 0;

  return (
    <>
      <div
        className="stage-surface"
        aria-hidden="true"
        onPointerUp={onSurfaceUp}
        onClick={onSurfaceClick}
        onDoubleClick={() => {
          if (!touched.current) onFullscreen();
        }}
      />
      {flash && (
        <div className="stage-flash" key={flash.n} aria-hidden="true">
          <svg viewBox="0 0 100 100" className="stage-flash-ring">
            <circle cx="50" cy="50" r="46" />
          </svg>
          <Icon name={flash.icon} size={34} />
        </div>
      )}
      {nudge && (
        <div
          className={`stage-nudge stage-nudge-${nudge.side}`}
          key={nudge.n}
          aria-hidden="true"
        >
          <Icon name={nudge.side} size={22} />
          10 s
        </div>
      )}
      {pausedHere && !flash && (
        <div className="intermission">
          <button
            type="button"
            className="intermission-play"
            onClick={() => {
              togglePlay();
              onWake();
            }}
          >
            <Icon name="play" size={30} />
            <span>{media.started ? "Resume" : "Play film"}</span>
          </button>
          {media.started && (
            <p className="intermission-note">
              <span className="intermission-title">{title}</span>
              Paused at {clockText(media.time)}
              {media.span - media.time > 1
                ? `, ${lengthWords(media.span - media.time)} to go.`
                : "."}
            </p>
          )}
        </div>
      )}
      <div
        className={`transport${shown || media.paused ? "" : " is-hidden"}`}
        onPointerEnter={() => onHold(true)}
        onPointerLeave={() => onHold(false)}
        onFocusCapture={onWake}
      >
        {fullscreen && (
          <div className="transport-caption">
            {caption && <p className="transport-episode">{caption}</p>}
            <p className="transport-title">{title}</p>
          </div>
        )}
        <SeekLine
          fraction={fraction}
          loaded={loaded}
          span={media.span}
          time={media.time}
          onSeek={(seconds) => {
            const v = element();
            if (v) v.currentTime = seconds;
          }}
          onWake={onWake}
        />
        <div className="transport-bar">
          <button
            type="button"
            className="transport-button transport-play"
            aria-label={media.paused ? "Play" : "Pause"}
            onClick={togglePlay}
          >
            <Icon name={media.paused ? "play" : "pause"} size={22} />
          </button>
          <button
            type="button"
            className="transport-button transport-skip"
            aria-label="Back 10 seconds"
            onClick={() => skip(-10)}
          >
            <Icon name="back" size={20} />
          </button>
          <button
            type="button"
            className="transport-button transport-skip"
            aria-label="Forward 10 seconds"
            onClick={() => skip(10)}
          >
            <Icon name="forward" size={20} />
          </button>
          <button
            type="button"
            className="transport-button"
            aria-label={media.muted ? "Sound on" : "Mute"}
            onClick={toggleMute}
          >
            <Icon name={media.muted ? "mute" : "volume"} size={20} />
          </button>
          <input
            type="range"
            className="transport-volume"
            aria-label="Volume"
            min={0}
            max={1}
            step={0.05}
            value={media.muted ? 0 : media.volume}
            onChange={(event) => {
              const v = element();
              if (!v) return;
              v.volume = Number(event.target.value);
              v.muted = v.volume === 0;
            }}
          />
          <button
            type="button"
            className="transport-time"
            aria-label={
              remaining
                ? `${lengthWords(media.span - media.time)} to go. Show time watched`
                : `${lengthWords(media.time)} watched. Show time to go`
            }
            onClick={() => setRemaining((r) => !r)}
          >
            {remaining
              ? `−${clockText(media.span - media.time)}`
              : clockText(media.time)}
            {media.span > 0 && (
              <span className="transport-length">
                {` / ${clockText(media.span)}`}
              </span>
            )}
          </button>
          <span className="transport-spacer" />
          {next && onNext && (
            <button
              type="button"
              className="transport-button transport-next"
              title={`Next episode: ${next.title}`}
              onClick={onNext}
            >
              <Icon name="next" size={20} />
              <span className="transport-next-text">Next episode</span>
              <span className="transport-next-label">{next.label}</span>
            </button>
          )}
          {pipAvailable && (
            <button
              type="button"
              className="transport-button"
              aria-label={
                pip ? "Leave picture in picture" : "Picture in picture"
              }
              aria-pressed={pip}
              onClick={togglePip}
            >
              <Icon name="pip" size={20} />
            </button>
          )}
          <button
            type="button"
            className="transport-button fullscreen-button"
            aria-label={fullscreen ? "Exit full screen" : "Full screen"}
            aria-pressed={fullscreen}
            onClick={onFullscreen}
          >
            <Icon name={fullscreen ? "shrink" : "expand"} size={20} />
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * The copper line. A slider for assistive technology and the keyboard (the
 * player's arrow keys move ten seconds; Home and End go to either end), and
 * a line to point at or drag along, with the time there written above it.
 */
function SeekLine({
  fraction,
  loaded,
  span,
  time,
  onSeek,
  onWake,
}: {
  fraction: number;
  loaded: number;
  span: number;
  time: number;
  onSeek: (seconds: number) => void;
  onWake: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [point, setPoint] = useState<number>();
  const [dragging, setDragging] = useState(false);
  const at = (clientX: number) => {
    const box = track.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - box.left) / box.width));
  };
  const shown = dragging && point !== undefined ? point : fraction;
  return (
    <div
      ref={track}
      className={`seek${dragging ? " is-dragging" : ""}${span ? "" : " is-unknown"}`}
      role="slider"
      tabIndex={span ? 0 : -1}
      aria-label="Position in the film"
      aria-valuemin={0}
      aria-valuemax={Math.round(span)}
      aria-valuenow={Math.round(time)}
      aria-valuetext={`${lengthWords(time)} of ${lengthWords(span)}`}
      onKeyDown={(event) => {
        if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          onSeek(event.key === "Home" ? 0 : Math.max(0, span - 1));
        }
      }}
      onPointerDown={(event) => {
        if (!span) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        setPoint(at(event.clientX));
        onWake();
      }}
      onPointerMove={(event) => {
        if (!span) return;
        setPoint(at(event.clientX));
        onWake();
      }}
      onPointerUp={(event) => {
        if (!dragging) return;
        setDragging(false);
        onSeek(at(event.clientX) * span);
      }}
      onPointerCancel={() => setDragging(false)}
      onPointerLeave={() => {
        if (!dragging) setPoint(undefined);
      }}
    >
      <div className="seek-rail">
        <span
          className="seek-loaded"
          style={{ transform: `scaleX(${loaded})` }}
        />
        <span
          className="seek-played"
          style={{ transform: `scaleX(${shown})` }}
        />
      </div>
      <span className="seek-head" style={{ left: `${shown * 100}%` }} />
      {point !== undefined && span > 0 && (
        <span
          className="seek-time"
          style={{ left: `${point * 100}%` }}
          aria-hidden="true"
        >
          {clockText(point * span)}
        </span>
      )}
    </div>
  );
}
