import { useEffect, useRef, useState } from "react";
import type { EpisodeInfo } from "../../../../packages/contracts/src/index.js";
import { FilmStill } from "../../../../packages/ui/src/FilmStill.js";
import { Icon } from "../../../../packages/ui/src/Icon.js";

/** How long the copper line flows before the next episode plays on its own. */
export const AUTOPLAY_SECONDS = 10;

export function episodeLabel(e: { season?: number; episode: number }) {
  return e.season !== undefined
    ? `S${e.season} · E${e.episode}`
    : `Episode ${e.episode}`;
}
export function episodeWords(e: { season?: number; episode: number }) {
  return e.season !== undefined
    ? `Season ${e.season}, episode ${e.episode}`
    : `Episode ${e.episode}`;
}

/**
 * The season as a rail of marks: the episodes before this one, this one, and
 * the one the line flows into. Long seasons are named in words instead.
 */
function SeasonRail({ episode }: { episode: EpisodeInfo }) {
  if (episode.count < 2 || episode.count > 40) return null;
  return (
    <ol className="season-rail" aria-hidden="true">
      {Array.from({ length: episode.count }, (_, i) => (
        <li
          key={i}
          className={
            i + 1 < episode.index
              ? "is-past"
              : i + 1 === episode.index
                ? "is-current"
                : i + 1 === episode.index + 1
                  ? "is-next"
                  : undefined
          }
        />
      ))}
    </ol>
  );
}

/**
 * A small card in the stage's corner for the last moments of an episode. It
 * never takes the focus: the film is still playing.
 */
export function UpNextPeek({
  episode,
  onPlay,
  onHide,
}: {
  episode: EpisodeInfo & { next: NonNullable<EpisodeInfo["next"]> };
  onPlay: () => void;
  onHide: () => void;
}) {
  const next = episode.next;
  return (
    <aside className="up-next-peek" aria-label="Up next">
      <div className="up-next-thumb">
        <FilmStill url={next.stillUrl ?? next.posterUrl} />
      </div>
      <div className="up-next-peek-copy">
        <p className="up-next-kicker">Up next · {episodeLabel(next)}</p>
        <p className="up-next-peek-title">{next.title}</p>
      </div>
      <button type="button" className="primary" onClick={onPlay}>
        <Icon name="next" />
        Play now
      </button>
      <button
        type="button"
        className="up-next-hide"
        aria-label="Hide up next"
        onClick={onHide}
      >
        <Icon name="close" />
      </button>
    </aside>
  );
}

/**
 * The end of an episode: the next one, a copper line that flows into it, and
 * the season's rail. The line is the countdown; the seconds are written too,
 * and with reduced motion the line stays still while they count. "Not now"
 * stops it, and one press turns playing on its own off for good.
 */
export function UpNextEnd({
  episode,
  autoplay,
  onPlay,
  onWatchAgain,
  onTurnOff,
}: {
  episode: EpisodeInfo & { next: NonNullable<EpisodeInfo["next"]> };
  autoplay: boolean;
  onPlay: () => void;
  onWatchAgain: () => void;
  onTurnOff: () => void;
}) {
  const next = episode.next;
  const [counting, setCounting] = useState(autoplay);
  const [left, setLeft] = useState(AUTOPLAY_SECONDS);
  const play = useRef<HTMLButtonElement>(null);
  // The player re-renders while the count runs; the count must not restart.
  const playNext = useRef(onPlay);
  playNext.current = onPlay;
  // OK on a remote, or Enter, plays it at once.
  useEffect(() => {
    play.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => setCounting(autoplay), [autoplay]);
  useEffect(() => {
    if (!counting) return;
    setLeft(AUTOPLAY_SECONDS);
    const started = Date.now();
    const timer = setInterval(() => {
      const remaining =
        AUTOPLAY_SECONDS - Math.floor((Date.now() - started) / 1000);
      if (remaining <= 0) {
        clearInterval(timer);
        playNext.current();
      } else setLeft(remaining);
    }, 250);
    return () => clearInterval(timer);
  }, [counting]);
  return (
    <section
      className={`up-next-end${counting ? " is-counting" : ""}`}
      aria-labelledby="up-next-title"
    >
      <div className="up-next-art">
        <FilmStill url={next.stillUrl ?? next.posterUrl} />
      </div>
      <div className="up-next-copy">
        <p className="up-next-kicker">
          Up next · {episodeLabel(next)}
          {episode.folder.name ? ` · ${episode.folder.name}` : ""}
        </p>
        <h2 id="up-next-title">{next.title}</h2>
        <p className="up-next-place">
          {episodeWords(next)} of {episode.count}
        </p>
        <SeasonRail episode={episode} />
        {counting && (
          <>
            <div className="up-next-line" aria-hidden="true">
              <span />
            </div>
            <p className="up-next-count" aria-hidden="true">
              Plays in {left} s
            </p>
            <p className="sr-only" role="status">
              {`${next.title} plays in ${AUTOPLAY_SECONDS} seconds.`}
            </p>
          </>
        )}
        <div className="button-row">
          <button ref={play} type="button" className="primary" onClick={onPlay}>
            <Icon name="next" />
            {counting ? "Play now" : "Play next episode"}
          </button>
          {counting ? (
            <button type="button" onClick={() => setCounting(false)}>
              Not now
            </button>
          ) : (
            <button type="button" onClick={onWatchAgain}>
              Watch again
            </button>
          )}
          <a
            className="button"
            href={`#/folder/${encodeURIComponent(episode.folder.id)}`}
          >
            {episode.folder.name
              ? `Back to ${episode.folder.name}`
              : "Back to the series"}
          </a>
        </div>
        {counting && (
          <button
            type="button"
            className="text-link up-next-off"
            onClick={() => {
              setCounting(false);
              onTurnOff();
            }}
          >
            Don’t play episodes on their own
          </button>
        )}
      </div>
    </section>
  );
}
