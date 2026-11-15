import { FilmStill } from "../../../../packages/ui/src/FilmStill.js";
import { useEffect, useState } from "react";
import { useApi } from "../../../../packages/client/src/api.js";
import type { MovieDetail } from "../../../../packages/contracts/src/index.js";
import { Poster } from "../../../../packages/ui/src/MovieCard.js";
import { StatusPanel } from "../../../../packages/ui/src/StatusPanel.js";
export function Detail({ id }: { id: string }) {
  const api = useApi();
  const [movie, setMovie] = useState<MovieDetail>(),
    [failed, setFailed] = useState(false),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState(false);
  useEffect(() => {
    let active = true;
    setMovie(undefined);
    setFailed(false);
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
  }, [api, id]);
  if (failed)
    return (
      <main id="main">
        <StatusPanel
          title="This film couldn’t be loaded."
          action={
            <a className="button" href="#/library">
              Back to your library
            </a>
          }
        >
          The connection may have changed. Your watch history is still saved.
        </StatusPanel>
      </main>
    );
  if (!movie)
    return (
      <main id="main" className="loading-screen" role="status">
        Opening the film…
      </main>
    );
  async function save() {
    if (!movie) return;
    setBusy(true);
    try {
      await api.saveMovie(id, !movie.saved);
      setMovie({ ...movie, saved: !movie.saved });
      setMessage(
        movie.saved
          ? "Removed from your watchlist."
          : "Saved for another night.",
      );
    } catch {
      setMessage("Couldn’t update your watchlist. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main id="main" className="detail-page">
      <div className="detail-atmosphere">
        <FilmStill url={movie.posterUrl} priority />
      </div>
      <a className="back-link" href="#/library">
        ← Back to the collection
      </a>
      <div className="detail-grid">
        <Poster movie={movie} large />
        <div className="detail-copy">
          <p className="eyebrow">
            FROM YOUR COLLECTION {movie.year ? `/ ${movie.year}` : ""}
          </p>
          <h1>{movie.title}</h1>
          <p className="detail-description">
            {movie.description ||
              "A film from your personal collection. Add a description to make it easier to find next time."}
          </p>
          <div className="button-row">
            {movie.available ? (
              <a
                className="button primary"
                href={`#/player/${encodeURIComponent(id)}`}
              >
                ▶ {movie.resumeMs ? "Resume film" : "Watch film"}
              </a>
            ) : (
              <span className="unavailable">Source unavailable</span>
            )}
            <button disabled={busy} onClick={() => void save()}>
              {movie.saved ? "✓ In watchlist" : "+ Watchlist"}
            </button>
          </div>
          {movie.resumeMs > 0 && (
            <p className="muted">
              Paused at {Math.floor(movie.resumeMs / 60000)} minutes.{" "}
              <a href={`#/player/${encodeURIComponent(id)}?start=0`}>
                Start from the beginning
              </a>
            </p>
          )}
          <p role="status">{message}</p>
          <section className="detail-section">
            <h2>Available editions</h2>
            {movie.editions.map((edition) => (
              <div className="edition" key={edition.id}>
                <span>{edition.label}</span>
                <span className="muted">
                  {edition.available
                    ? edition.state === "source"
                      ? "Original file"
                      : edition.state
                    : "Unavailable"}
                </span>
              </div>
            ))}
            {movie.editions.filter((e) => e.available).length > 1 && (
              <p className="muted">
                Multiple editions need a selection before playback. Manage
                source associations in the catalogue.
              </p>
            )}
          </section>
          <button className="text-button" onClick={() => setEditing(!editing)}>
            {editing ? "Cancel editing" : "Edit film details"}
          </button>
          {editing && (
            <form
              className="form-stack"
              onSubmit={async (event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                setBusy(true);
                try {
                  const updated = await api.editMovie(id, {
                    title: String(form.get("title")),
                    description: String(form.get("description")),
                    ...(form.get("year")
                      ? { year: Number(form.get("year")) }
                      : {}),
                  });
                  setMovie(updated);
                  setEditing(false);
                  setMessage("Film details saved.");
                } catch {
                  setMessage(
                    "Couldn’t save the details. Your existing information is unchanged.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                Title
                <input
                  name="title"
                  defaultValue={movie.title}
                  required
                  maxLength={300}
                />
              </label>
              <label>
                Year
                <input
                  name="year"
                  type="number"
                  min="1888"
                  max="2100"
                  defaultValue={movie.year}
                />
              </label>
              <label>
                Description
                <textarea
                  name="description"
                  defaultValue={movie.description}
                  maxLength={4000}
                />
              </label>
              <button className="primary" disabled={busy}>
                Save details
              </button>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
