import { FilmStill } from "../../../../packages/ui/src/FilmStill.js";
import { useEffect, useRef, useState } from "react";
import { useApi } from "../../../../packages/client/src/api.js";
import type { MovieDetail } from "../../../../packages/contracts/src/index.js";
import { Poster } from "../../../../packages/ui/src/MovieCard.js";
import { backdropUrl } from "../../../../packages/ui/src/artwork.js";
import { StatusPanel } from "../../../../packages/ui/src/StatusPanel.js";
import {
  ActionButton,
  Line,
  Placeholder,
  useDelayed,
  usePending,
} from "../../../../packages/ui/src/Loading.js";
import { episodeLabel, episodeWords } from "../player/UpNext.js";
import { Icon } from "../../../../packages/ui/src/Icon.js";
import { forgetLibrary } from "../libraryCache.js";
import { returnTo, useTitle } from "../router.js";
const editionState: Record<string, string> = {
  source: "Original file",
  ready: "Prepared",
  preparing: "Being prepared",
  queued: "Waiting to be prepared",
};
export function Detail({ id }: { id: string }) {
  const api = useApi();
  const [movie, setMovie] = useState<MovieDetail>(),
    [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0),
    [message, setMessage] = useState(""),
    [formError, setFormError] = useState(""),
    [editing, setEditing] = useState(false);
  const [saving, runSave] = usePending();
  const [storing, runStore] = usePending();
  const firstField = useRef<HTMLInputElement>(null);
  const editToggle = useRef<HTMLButtonElement>(null);
  useTitle(movie?.title);
  useEffect(() => {
    let active = true;
    setMovie(undefined);
    setFailed(false);
    setMessage("");
    setEditing(false);
    api
      .detail(id)
      .then((m) => {
        if (active) setMovie(m);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [api, id, retry]);
  useEffect(() => {
    if (editing) firstField.current?.focus();
  }, [editing]);
  const waiting = useDelayed(!movie && !failed);
  // Back to the list the reader came from, where they left it; otherwise the library.
  const back = (
    <a
      className="back-link"
      href="#/library"
      onClick={(event) => {
        if (returnTo(/^\/(library|watchlist|folder\/[A-Za-z0-9_-]+)$/))
          event.preventDefault();
      }}
    >
      <Icon name="arrow-left" />
      Back to the collection
    </a>
  );
  if (failed)
    return (
      <main id="main">
        <StatusPanel
          tone="error"
          level={1}
          title="This film couldn’t be loaded."
          action={
            <div className="button-row">
              <button onClick={() => setRetry((n) => n + 1)}>Try again</button>
              <a className="button" href="#/library">
                Back to your library
              </a>
            </div>
          }
        >
          The connection may have changed. Your watch history is still saved.
        </StatusPanel>
      </main>
    );
  if (!movie)
    return (
      <main id="main" className="detail-page">
        {back}
        {waiting ? (
          <Placeholder label="Opening the film" className="detail-wait">
            <div className="detail-grid">
              <span className="sk sk-poster" />
              <div className="detail-copy">
                <Line width="200px" />
                <Line width="min(560px, 85%)" strong className="sk-title" />
                <Line width="min(620px, 95%)" />
                <Line width="min(480px, 70%)" />
                <span className="sk sk-button" />
              </div>
            </div>
          </Placeholder>
        ) : (
          <div className="detail-wait" aria-busy="true" />
        )}
      </main>
    );
  const film = movie;
  function save() {
    void runSave(async () => {
      try {
        await api.saveMovie(id, !film.saved);
        forgetLibrary(api);
        setMovie({ ...film, saved: !film.saved });
        setMessage(
          film.saved
            ? "Removed from your watchlist."
            : "Saved for another night.",
        );
      } catch {
        setMessage("Couldn’t update your watchlist. Please try again.");
      }
    });
  }
  const audio = film.audioTracks ?? [];
  const playable = film.editions.filter((e) => e.available).length;
  return (
    <main id="main" className="detail-page">
      <div className="detail-atmosphere">
        <FilmStill url={backdropUrl(film)} priority />
      </div>
      {back}
      <div className="detail-grid">
        <Poster movie={film} large />
        <div className="detail-copy">
          {film.episode && (
            <p className="detail-episode">
              <a
                href={`#/folder/${encodeURIComponent(film.episode.folder.id)}`}
              >
                {film.episode.folder.name || "This series"}
              </a>{" "}
              · {episodeWords(film.episode)} of {film.episode.count}
            </p>
          )}
          <h1 data-long={film.title.length > 28 || undefined}>{film.title}</h1>
          {film.year ? <p className="detail-year">{film.year}</p> : null}
          {film.description ? (
            <p className="detail-description">{film.description}</p>
          ) : (
            <p className="detail-description detail-description-empty">
              No description yet.{" "}
              <button className="text-link" onClick={() => setEditing(true)}>
                Add one
              </button>{" "}
              to make this film easier to find.
            </p>
          )}
          <div className="button-row">
            {film.available ? (
              <a
                className="button primary"
                href={`#/player/${encodeURIComponent(id)}`}
              >
                <Icon name="play" />
                {film.resumeMs ? "Resume film" : "Watch film"}
              </a>
            ) : (
              <span className="unavailable">Source unavailable</span>
            )}
            <ActionButton
              pending={saving}
              pendingLabel="Updating your watchlist"
              onClick={save}
            >
              {film.saved ? "✓ In watchlist" : "+ Watchlist"}
            </ActionButton>
          </div>
          {film.episode?.next && (
            <p className="detail-next">
              Next:{" "}
              <a href={`#/movie/${encodeURIComponent(film.episode.next.id)}`}>
                {episodeLabel(film.episode.next)} · {film.episode.next.title}
              </a>
            </p>
          )}
          {!film.available && (
            <p className="muted">
              The file is no longer in your Drive folder, or Google needs to be
              reconnected. <a href="#/settings">Open Your cinema</a> to check.
            </p>
          )}
          {film.available && film.resumeMs > 0 && (
            <p className="muted">
              Paused at {Math.floor(film.resumeMs / 60000)} minutes.{" "}
              <a href={`#/player/${encodeURIComponent(id)}?start=0`}>
                Start from the beginning
              </a>
            </p>
          )}
          <p className="detail-message" role="status">
            {message}
          </p>
          <section className="detail-section">
            <h2>Available editions</h2>
            {film.editions.map((edition) => (
              <div className="edition" key={edition.id}>
                <span>{edition.label}</span>
                <span className="muted">
                  {edition.available
                    ? (editionState[edition.state] ?? edition.state)
                    : "Unavailable"}
                </span>
              </div>
            ))}
            {audio.length > 1 && (
              <div className="edition">
                <span>Audio</span>
                <span className="muted">
                  {audio.map((a) => a.label).join(", ")}
                </span>
              </div>
            )}
            {(film.subtitleTracks ?? []).length > 0 && (
              <div className="edition">
                <span>Subtitles</span>
                <span className="muted">
                  {film
                    .subtitleTracks!.map((t) =>
                      t.text ? t.label : `${t.label} (picture, can’t be shown)`,
                    )
                    .join(", ")}
                </span>
              </div>
            )}
            {playable > 1 && (
              <p className="muted">
                Multiple editions need a selection before playback. Manage
                source associations in the catalogue.
              </p>
            )}
          </section>
          <button
            ref={editToggle}
            className="text-button"
            aria-expanded={editing}
            aria-controls="edit-film"
            onClick={() => {
              setFormError("");
              setEditing(!editing);
            }}
          >
            {editing ? "Cancel editing" : "Edit film details"}
          </button>
          {editing && (
            <form
              id="edit-film"
              className="form-stack"
              aria-label="Film details"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void runStore(async () => {
                  setFormError("");
                  try {
                    const updated = await api.editMovie(id, {
                      title: String(form.get("title")),
                      description: String(form.get("description")),
                      ...(form.get("year")
                        ? { year: Number(form.get("year")) }
                        : {}),
                    });
                    forgetLibrary(api);
                    setMovie(updated);
                    setEditing(false);
                    setMessage("Film details saved.");
                    // The form and its button are gone; return to what opened it.
                    editToggle.current?.focus();
                  } catch {
                    setFormError(
                      "Couldn’t save the details. Your existing information is unchanged.",
                    );
                  }
                });
              }}
            >
              <label>
                Title
                <input
                  ref={firstField}
                  name="title"
                  defaultValue={film.title}
                  required
                  maxLength={300}
                />
              </label>
              <label>
                Year
                <input
                  name="year"
                  type="number"
                  inputMode="numeric"
                  min="1888"
                  max="2100"
                  defaultValue={film.year}
                />
              </label>
              <label>
                Description
                <textarea
                  name="description"
                  defaultValue={film.description}
                  maxLength={4000}
                />
              </label>
              {formError && (
                <p className="notice" role="alert">
                  {formError}
                </p>
              )}
              <ActionButton
                className="primary"
                pending={storing}
                pendingLabel="Saving film details"
              >
                Save details
              </ActionButton>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
