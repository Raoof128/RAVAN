import { FilmStill } from "../../../../packages/ui/src/FilmStill.js";
import { useEffect, useRef, useState } from "react";
import { useApi } from "../../../../packages/client/src/api.js";
import {
  FolderCard,
  MovieCard,
  Poster,
} from "../../../../packages/ui/src/MovieCard.js";
import { StatusPanel } from "../../../../packages/ui/src/StatusPanel.js";
import {
  ActionButton,
  Line,
  Placeholder,
  PosterPlaceholders,
  useDelayed,
  usePending,
} from "../../../../packages/ui/src/Loading.js";
import {
  backdropUrl,
  cinematicArtwork,
} from "../../../../packages/ui/src/artwork.js";
import type {
  MovieCard as Movie,
  MovieList,
} from "../../../../packages/contracts/src/index.js";
import { Icon } from "../../../../packages/ui/src/Icon.js";
import { recallLibrary, rememberLibrary } from "../libraryCache.js";
import { returnTo, useTitle } from "../router.js";
const minutes = (ms: number) => Math.floor(ms / 60000);
/**
 * The collection, the watchlist, or one folder of the collection. The top of
 * the collection shows its folders as cards and the films filed directly in
 * it; a folder shows the same for itself. A search from the top looks through
 * every folder; a search inside a folder looks only there.
 */
export function Library({
  saved = false,
  folder,
}: {
  saved?: boolean;
  folder?: string;
}) {
  const api = useApi();
  const key = saved ? true : (folder ?? false);
  // Returning from a film finds the list as it was left.
  const [recalled] = useState(() => recallLibrary(api, key));
  const [items, setItems] = useState<Movie[]>(recalled?.items ?? []),
    [place, setPlace] = useState<MovieList["folder"]>(recalled?.folder),
    [folders, setFolders] = useState<MovieList["folders"]>(recalled?.folders),
    [resuming, setResuming] = useState<MovieList["resume"]>(recalled?.resume),
    [query, setQuery] = useState(recalled?.query ?? ""),
    [shown, setShown] = useState(recalled?.query ?? ""),
    [cursor, setCursor] = useState<string | null>(recalled?.cursor ?? null),
    [loaded, setLoaded] = useState(recalled !== undefined),
    [loading, setLoading] = useState(recalled === undefined),
    [error, setError] = useState(false),
    [moreError, setMoreError] = useState(false),
    [retry, setRetry] = useState(0);
  const [moreLoading, runMore] = usePending();
  // Each list request is numbered. An answer is used only if nothing newer has
  // been asked for, so a slow page of results can never land in another search.
  const request = useRef(0);
  const search = useRef<HTMLInputElement>(null);
  const kept = useRef(recalled ? recalled.query : null);
  useTitle(
    saved ? "Watchlist" : folder ? (place?.name ?? "Folder") : undefined,
  );
  // Which folder a request browses: none for the watchlist or a search from
  // the top, which look through the whole collection.
  const within = (q: string) =>
    saved ? undefined : folder ? folder : q ? undefined : "root";
  useEffect(() => {
    // A recalled view is shown as it is. Asking starts with the first change.
    if (kept.current === query && retry === 0) return;
    kept.current = null;
    const id = ++request.current;
    setLoading(true);
    setError(false);
    setMoreError(false);
    const timer = setTimeout(
      () => {
        api
          .listMovies(undefined, query, saved, within(query))
          .then((data) => {
            if (request.current !== id) return;
            setItems(data.items);
            setCursor(data.nextCursor);
            // A folder keeps its name while it is searched.
            if (data.folder) setPlace(data.folder);
            setFolders(data.folders);
            setResuming(data.resume);
            setShown(query);
            setLoaded(true);
          })
          .catch(() => {
            if (request.current === id) setError(true);
          })
          .finally(() => {
            if (request.current === id) setLoading(false);
          });
      },
      query ? 200 : 0,
    );
    return () => clearTimeout(timer);
  }, [api, query, retry, saved, folder]);
  useEffect(
    () => () => {
      request.current = -1;
    },
    [],
  );
  useEffect(() => {
    if (loaded && !error)
      rememberLibrary(api, key, {
        query: shown,
        items,
        cursor,
        folder: place,
        folders,
        resume: resuming,
      });
  }, [api, key, loaded, error, shown, items, cursor, place, folders, resuming]);
  // "/" reaches the search from anywhere on the page, as on most catalogues.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      )
        return;
      event.preventDefault();
      search.current?.focus();
      search.current?.scrollIntoView({ block: "center" });
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);
  function more() {
    if (!cursor) return;
    const id = request.current;
    void runMore(async () => {
      setMoreError(false);
      try {
        const data = await api.listMovies(cursor, query, saved, within(query));
        if (request.current !== id) return;
        setItems((old) => [
          ...old,
          ...data.items.filter((m) => !old.some((o) => o.id === m.id)),
        ]);
        setCursor(data.nextCursor);
      } catch {
        if (request.current === id) setMoreError(true);
      }
    });
  }
  // First visit: placeholders stand in. Later searches keep the last results
  // on screen, quietened, until the new ones arrive.
  const first = loading && !loaded;
  const placeholders = useDelayed(first);
  const refreshing = useDelayed(loading && loaded, 250);
  const home = !saved && !folder && !shown;
  const shelves = shown ? [] : (folders ?? []);
  const resume = resuming ?? items.filter((m) => m.available && m.resumeMs > 0);
  const featured = home ? (resume[0] ?? items.find((m) => m.available)) : null;
  const others = home ? resume.filter((m) => m !== featured) : [];
  const backdrop = featured ? backdropUrl(featured) : undefined;
  const still = cinematicArtwork(backdrop);
  // The hero carries the page's first heading. Without one, the list's does.
  const hero = featured !== null && featured !== undefined;
  const Heading = hero || (!saved && !folder && !query && first) ? "h2" : "h1";
  const cardHeading = Heading === "h1" ? "h2" : "h3";
  const parentHref =
    !place?.parentId || place.parentId === "root"
      ? "#/library"
      : `#/folder/${encodeURIComponent(place.parentId)}`;
  return (
    <main id="main" className="library-page">
      {folder && (
        <a
          className="back-link"
          href={parentHref}
          onClick={(event) => {
            // Folder ids are letters, digits, "-" and "_": safe in a pattern.
            const parent =
              place?.parentId && place.parentId !== "root"
                ? new RegExp(`^/folder/${place.parentId}$`)
                : /^\/library$/;
            if (returnTo(parent)) event.preventDefault();
          }}
        >
          <Icon name="arrow-left" />
          {place?.parentName
            ? `Back to ${place.parentName}`
            : "Back to the collection"}
        </a>
      )}
      {!saved && !folder && !query && first ? (
        <Placeholder
          label="Opening your collection"
          className="feature feature-plain"
        >
          <div className="feature-copy">
            <Line width="180px" />
            <Line width="min(520px, 80%)" strong className="sk-title" />
            <Line width="260px" />
            <span className="sk sk-button" />
          </div>
        </Placeholder>
      ) : featured ? (
        <section
          className={`feature${still ? "" : " feature-plain"}`}
          aria-label={
            featured.resumeMs ? "Continue watching" : "From your collection"
          }
        >
          <FilmStill url={backdrop} priority />
          <div className="feature-shade" />
          <div className="feature-copy">
            <p className="eyebrow">
              <span className="live-dot" />{" "}
              {featured.resumeMs
                ? "PICK UP WHERE YOU LEFT OFF"
                : "FROM YOUR COLLECTION"}
            </p>
            <h1 data-long={featured.title.length > 24 || undefined}>
              {featured.title}
            </h1>
            <p className="feature-subtitle">
              {featured.resumeMs ? (
                <>
                  Paused at {minutes(featured.resumeMs)} min
                  {featured.year ? `, from ${featured.year}` : ""}
                </>
              ) : (
                <>
                  {featured.year ? (
                    <>
                      {featured.year}
                      <br />
                    </>
                  ) : null}
                  Some stories stay with you. Make tonight one of them.
                </>
              )}
            </p>
            <div className="button-row">
              <a
                className="button primary"
                href={`#/${featured.resumeMs ? "player" : "movie"}/${encodeURIComponent(featured.id)}`}
              >
                <Icon name="play" />
                {featured.resumeMs ? "Continue watching" : "Explore film"}
              </a>
              <a
                className="feature-detail-link"
                href={`#/movie/${encodeURIComponent(featured.id)}`}
              >
                Film details
              </a>
            </div>
          </div>
          {!still && (
            <div className="feature-poster">
              <Poster movie={featured} large />
            </div>
          )}
        </section>
      ) : null}
      {others.length > 0 && (
        <section className="in-progress" aria-labelledby="in-progress-title">
          <h2 id="in-progress-title">Also in progress</h2>
          <ul>
            {others.slice(0, 4).map((movie) => (
              <li key={movie.id}>
                <a
                  className="resume-ticket"
                  href={`#/player/${encodeURIComponent(movie.id)}`}
                  aria-label={`Resume ${movie.title}, paused at ${minutes(movie.resumeMs)} minutes`}
                >
                  <span className="resume-ticket-art">
                    <Poster movie={movie} />
                  </span>
                  <span className="resume-ticket-copy">
                    <strong title={movie.title}>{movie.title}</strong>
                    <span className="resume-ticket-time">
                      Paused at {minutes(movie.resumeMs)} min
                    </span>
                  </span>
                  <span className="resume-ticket-action">
                    <Icon name="play" size={18} />
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="collection" id="collection">
        <div className="section-heading">
          <Heading className="section-title">
            {saved
              ? "Your watchlist"
              : shown
                ? "Search results"
                : folder
                  ? (place?.name ?? "Folder")
                  : "The collection"}
            {loaded && items.length > 0 && (
              <span>
                <span aria-hidden="true">
                  {items.length}
                  {cursor ? "+" : ""}
                </span>
                <span className="sr-only">
                  {" "}
                  {items.length}
                  {cursor ? " or more" : ""}{" "}
                  {items.length === 1 ? "film" : "films"}
                </span>
              </span>
            )}
          </Heading>
          <label className="search">
            <Icon name="search" size={18} />
            <input
              ref={search}
              type="search"
              aria-keyshortcuts="/"
              enterKeyHint="search"
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.preventDefault();
                  setQuery("");
                }
              }}
              placeholder={
                folder ? "Find a film in this folder…" : "Find a film…"
              }
              aria-label={folder ? "Search this folder" : "Search your movies"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <kbd aria-hidden="true">/</kbd>
          </label>
        </div>
        <p className="sr-only" role="status">
          {loaded && shown && !loading
            ? items.length
              ? `${items.length}${cursor ? " or more" : ""} ${items.length === 1 ? "film" : "films"} found for ${shown}.`
              : `No films found for ${shown}.`
            : ""}
        </p>
        {first ? (
          placeholders ? (
            <Placeholder label="Loading your films" className="grid-wait">
              <div className="poster-grid">
                <PosterPlaceholders count={12} />
              </div>
            </Placeholder>
          ) : (
            <div className="grid-wait" aria-busy="true" />
          )
        ) : error ? (
          <StatusPanel
            tone="error"
            title="We couldn’t load your library."
            action={
              <button onClick={() => setRetry((n) => n + 1)}>Try again</button>
            }
          >
            Your collection is safe. Check the connection and try again.
          </StatusPanel>
        ) : !items.length && !shelves.length ? (
          <StatusPanel
            title={
              shown
                ? "No films found."
                : saved
                  ? "A good film is worth saving."
                  : folder
                    ? "This folder is empty."
                    : "Your next favourite starts here."
            }
            action={
              shown ? (
                <button onClick={() => setQuery("")}>Clear search</button>
              ) : folder ? (
                <a className="button" href="#/library">
                  Browse the collection
                </a>
              ) : !saved ? (
                <a className="button primary" href="#/settings">
                  Choose a Drive folder
                </a>
              ) : (
                <a className="button" href="#/library">
                  Browse the collection
                </a>
              )
            }
          >
            {shown
              ? `Nothing in your collection matches “${shown}”. Try a different title.`
              : saved
                ? "Open a film and add it to your watchlist."
                : folder
                  ? "There are no films in this folder in Google Drive."
                  : "Connect your movie folder to make this space your own."}
          </StatusPanel>
        ) : (
          <>
            <div
              className={`poster-grid${refreshing ? " is-refreshing" : ""}`}
              aria-busy={loading || undefined}
            >
              {shelves.map((f) => (
                <FolderCard
                  folder={f}
                  heading={cardHeading}
                  key={`folder-${f.id}`}
                />
              ))}
              {items.map((movie) => (
                <MovieCard movie={movie} heading={cardHeading} key={movie.id} />
              ))}
            </div>
            {cursor && (
              <div className="load-more">
                <ActionButton
                  pending={moreLoading}
                  pendingLabel="Loading more films"
                  onClick={more}
                >
                  More from your collection
                </ActionButton>
                {moreError && (
                  <p className="notice" role="alert">
                    The next films didn’t load. Check the connection and try
                    again.
                  </p>
                )}
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
