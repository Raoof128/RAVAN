import { useState } from "react";
import { artworkUrl, sampleArtwork } from "./artwork.js";
import { Icon } from "./Icon.js";
import type { MovieCard as Movie } from "../../contracts/src/index.js";
export function Poster({
  movie,
  large = false,
}: {
  movie: Movie;
  large?: boolean;
}) {
  const [failed, setFailed] = useState<string>();
  const artwork = artworkUrl(movie.posterUrl);
  const illustrated = artwork !== undefined && sampleArtwork.includes(artwork);
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
 * One film in a grid. The poster is the card's only link and covers the whole
 * card, so a keyboard or switch user stops once per film rather than twice.
 */
export function MovieCard({ movie }: { movie: Movie }) {
  const paused = movie.available && movie.resumeMs > 0;
  return (
    <article className="movie-card">
      <a
        href={`#/movie/${encodeURIComponent(movie.id)}`}
        className="poster-link"
        aria-label={`View ${movie.title}`}
      >
        <Poster movie={movie} />
        <span className="poster-open">
          <Icon name="arrow-up-right" />
        </span>
      </a>
      <div className="movie-caption">
        <h3>{movie.title}</h3>
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
