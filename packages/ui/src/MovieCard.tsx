import { useState } from "react";
import { artworkUrl, sampleArtwork } from "./artwork.js";
import { Icon } from "./Icon.js";
import type {
  FolderCard as Folder,
  MovieCard as Movie,
} from "../../contracts/src/index.js";
export function Poster({
  movie,
  large = false,
  source,
}: {
  movie: Movie;
  large?: boolean;
  /**
   * The picture already loaded by the caller, as a local object URL. The TV
   * fetches pictures with its device credential, which an img cannot send.
   */
  source?: string;
}) {
  const [failed, setFailed] = useState<string>();
  const artwork =
    source && source.startsWith("blob:") ? source : artworkUrl(movie.posterUrl);
  // A sample's artwork and a frame from the film carry no title: set one.
  const illustrated =
    artwork !== undefined &&
    (sampleArtwork.includes(artwork) || movie.posterTitled === true);
  const hasArtwork = artwork !== undefined && failed !== artwork;
  const tone =
    Array.from(movie.id).reduce((n, c) => n + c.charCodeAt(0), 0) % 6;
  return (
    <div
      className={`poster tone-${tone}${large ? " poster-large" : ""}${hasArtwork ? " poster-photographic" : ""}${illustrated ? " poster-illustrated" : ""}`}
      aria-hidden="true"
    >
      {hasArtwork ? (
        <img
          src={artwork}
          width={480}
          height={720}
          decoding="async"
          alt=""
          loading="lazy"
          onError={() => setFailed(artwork)}
        />
      ) : null}
      <span className="poster-scrim" />
      <span className="poster-credit">RAVAN / PRIVATE CINEMA</span>
      <span
        className="poster-title"
        data-long={movie.title.length > 28 || undefined}
      >
        {movie.title}
      </span>
      {movie.year ? <span className="poster-year">{movie.year}</span> : null}
    </div>
  );
}
/**
 * A folder of the library, such as a series with its episodes inside: one
 * card, one link, opening to the folder's own screen.
 */
export function FolderCard({
  folder,
  heading: Heading = "h3",
}: {
  folder: Folder;
  heading?: "h2" | "h3";
}) {
  const count = `${folder.films} ${folder.films === 1 ? "film" : "films"}`;
  return (
    <article className="movie-card folder-card">
      <div className="card-art">
        <Poster
          movie={{
            id: folder.id,
            title: folder.name,
            resumeMs: 0,
            available: true,
            ...(folder.posterUrl ? { posterUrl: folder.posterUrl } : {}),
            ...(folder.posterTitled ? { posterTitled: true } : {}),
          }}
        />
        <span className="folder-badge">
          <Icon name="folder" size={14} />
          Folder
        </span>
      </div>
      <div className="movie-caption">
        <Heading className="card-title" aria-label={folder.name}>
          <a
            className="poster-link"
            href={`#/folder/${encodeURIComponent(folder.id)}`}
            aria-label={`Open the folder ${folder.name}, ${count}`}
          >
            {folder.name}
          </a>
        </Heading>
        <span>{count}</span>
      </div>
    </article>
  );
}
/**
 * One film in a grid. The title is the card's only link and covers the whole
 * card, so a keyboard or switch user stops once per film rather than twice.
 */
export function MovieCard({
  movie,
  heading: Heading = "h3",
}: {
  movie: Movie;
  heading?: "h2" | "h3";
}) {
  const paused = movie.available && movie.resumeMs > 0;
  return (
    <article className="movie-card">
      <div className="card-art">
        <Poster movie={movie} />
        <span className="poster-open">
          <Icon name="arrow-up-right" />
        </span>
      </div>
      <div className="movie-caption">
        <Heading className="card-title" aria-label={movie.title}>
          <a
            className="poster-link"
            href={`#/movie/${encodeURIComponent(movie.id)}`}
            aria-label={`View ${movie.title}`}
          >
            {movie.title}
          </a>
        </Heading>
        {movie.year ? <span>{movie.year}</span> : null}
      </div>
      {!movie.available ? (
        <p className="movie-meta movie-meta-warning">Source unavailable</p>
      ) : paused ? (
        <p className="movie-meta">
          <span className="resume-mark" aria-hidden="true" />
          Paused at {Math.floor(movie.resumeMs / 60000)} min
        </p>
      ) : null}
    </article>
  );
}
