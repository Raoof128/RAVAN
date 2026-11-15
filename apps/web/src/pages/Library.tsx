import { FilmStill } from "../../../../packages/ui/src/FilmStill.js";
import { useEffect, useState } from "react";
import { useApi } from "../../../../packages/client/src/api.js";
import { MovieCard } from "../../../../packages/ui/src/MovieCard.js";
import { StatusPanel } from "../../../../packages/ui/src/StatusPanel.js";
import type { MovieCard as Movie } from "../../../../packages/contracts/src/index.js";
export function Library({ saved = false }: { saved?: boolean }) {
  const api = useApi();
  const [items, setItems] = useState<Movie[]>([]),
    [query, setQuery] = useState(""),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(false),
    [retry, setRetry] = useState(0),
    [moreLoading, setMoreLoading] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    const timer = setTimeout(
      () => {
        api
          .listMovies(undefined, query, saved)
          .then((data) => {
            if (active) {
              setItems(data.items);
              setCursor(data.nextCursor);
            }
          })
          .catch(() => {
            if (active) setError(true);
          })
          .finally(() => {
            if (active) setLoading(false);
          });
      },
      query ? 200 : 0,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, query, retry, saved]);
  async function more() {
    if (!cursor || moreLoading) return;
    setMoreLoading(true);
    try {
      const data = await api.listMovies(cursor, query, saved);
      setItems((old) => [
        ...old,
        ...data.items.filter((m) => !old.some((o) => o.id === m.id)),
      ]);
      setCursor(data.nextCursor);
    } catch {
      setError(true);
    } finally {
      setMoreLoading(false);
    }
  }
  const resume = items.filter((m) => m.available && m.resumeMs > 0);
  const featured = resume[0] ?? items.find((m) => m.available);
  return (
    <main id="main" className="library-page">
      {!saved && !query && featured && (
        <section className="feature">
          <FilmStill url={featured.posterUrl} priority />
          <div className="feature-shade" />
          <div className="feature-edition" aria-hidden="true">
            <span>THE RAVAN PICTURE HOUSE</span>
            <span>YOUR PRIVATE COLLECTION</span>
          </div>
          <div className="feature-copy">
            <p className="eyebrow">
              <span className="live-dot" />{" "}
              {featured.resumeMs
                ? "PICK UP WHERE YOU LEFT OFF"
                : "FROM YOUR COLLECTION"}
            </p>
            <div className="feature-metadata">
              <span>{featured.year ?? "YOUR LIBRARY"}</span>
              <span className="metadata-rule" />
              <span>A FILM FROM YOUR COLLECTION</span>
            </div>
            <h1>{featured.title}</h1>
            <p className="feature-subtitle">
              Some stories stay with you.
              <br />
              Make tonight one of them.
            </p>
            <div className="button-row">
              <a
                className="button primary"
                href={`#/${featured.resumeMs ? "player" : "movie"}/${encodeURIComponent(featured.id)}`}
              >
                <span aria-hidden="true">▶</span>{" "}
                {featured.resumeMs ? "Continue watching" : "Explore film"}
              </a>
              <a
                className="feature-detail-link"
                href={`#/movie/${encodeURIComponent(featured.id)}`}
              >
                Film details <span aria-hidden="true">↗</span>
              </a>
            </div>
          </div>
          <span className="feature-number" aria-hidden="true">
            <span>01</span> / YOUR NEXT SCREENING
          </span>
        </section>
      )}
      {!saved && !query && featured?.resumeMs && !loading && !error ? (
        <a
          className="resume-ticket"
          href={`#/player/${encodeURIComponent(featured.id)}`}
        >
          <div className="resume-ticket-art">
            <FilmStill url={featured.posterUrl} />
            <span aria-hidden="true">▶</span>
          </div>
          <div className="resume-ticket-copy">
            <span className="eyebrow">THE STORY CONTINUES</span>
            <strong>{featured.title}</strong>
          </div>
          <span className="resume-ticket-time">
            Paused at {Math.floor(featured.resumeMs / 60000)} min
          </span>
          <span className="resume-ticket-action">
            Resume film <span aria-hidden="true">↗</span>
          </span>
        </a>
      ) : null}
      <section className="collection" id="collection">
        <div className="page-top">
          <p className="eyebrow">YOUR PRIVATE SCREENING ROOM</p>
          <label className="search">
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              placeholder="Find a film…"
              aria-label="Search your movies"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>

        <div className="section-heading">
          <div>
            <p className="eyebrow">
              {saved
                ? "SAVED FOR ANOTHER NIGHT"
                : "GOOD FILMS. YOUR OWN COLLECTION."}
            </p>
            <h2 className="section-title">
              {saved
                ? "Your watchlist"
                : query
                  ? "Search results"
                  : "The collection"}
              <span>
                {items.length ? String(items.length).padStart(2, "0") : ""}
              </span>
            </h2>
          </div>
          <span className="collection-note">
            {saved
              ? "Make time for a good story."
              : "A world worth getting lost in."}
          </span>
        </div>
        {loading ? (
          <div
            className="poster-grid"
            aria-label="Loading movies"
            role="status"
          >
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <div key={n} className="skeleton" />
            ))}
          </div>
        ) : error ? (
          <StatusPanel
            title="We couldn’t load your library."
            action={
              <button onClick={() => setRetry((n) => n + 1)}>Try again</button>
            }
          >
            Your collection is safe. Check the connection and try again.
          </StatusPanel>
        ) : !items.length ? (
          <StatusPanel
            title={
              query
                ? "No films found."
                : saved
                  ? "A good film is worth saving."
                  : "Your next favourite starts here."
            }
            action={
              !query && !saved ? (
                <a className="button primary" href="#/settings">
                  Choose a Drive folder
                </a>
              ) : undefined
            }
          >
            {query
              ? "Try a different title."
              : saved
                ? "Open a film and add it to your watchlist."
                : "Connect your movie folder to make this space your own."}
          </StatusPanel>
        ) : (
          <>
            <div className="poster-grid">
              {items.map((movie, index) => (
                <MovieCard movie={movie} index={index} key={movie.id} />
              ))}
            </div>
            {cursor && (
              <div className="load-more">
                <button onClick={() => void more()} disabled={moreLoading}>
                  {moreLoading ? "Loading…" : "More from your collection"}
                </button>
              </div>
            )}
          </>
        )}
      </section>
      <footer className="page-footer">
        <span>RAVĀN</span>
        <p>EVERY STORY FLOWS.</p>
        <span>Made for movie nights.</span>
      </footer>
    </main>
  );
}
