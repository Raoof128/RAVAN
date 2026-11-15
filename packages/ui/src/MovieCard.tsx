import { useState } from "react";
import { artworkUrl, sampleArtwork } from "./artwork.js";
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
      <span className="poster-orbit" />
      <span className="poster-lines" />
      <span className="poster-credit">RAVAN / PRIVATE CINEMA</span>
      <span className="poster-title">{movie.title}</span>
      <span className="poster-year">
        {movie.year ?? "RAVAN / PRIVATE CINEMA"}
      </span>
    </div>
  );
}
export function MovieCard({
  movie,
  index = 0,
}: {
  movie: Movie;
  index?: number;
}) {
  return (
    <article
      className="movie-card"
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
    >
      <a
        href={`#/movie/${encodeURIComponent(movie.id)}`}
        className="poster-link"
        aria-label={`View ${movie.title}`}
      >
        <Poster movie={movie} />
        <span className="poster-open" aria-hidden="true">
          ↗
        </span>
      </a>
      <div className="movie-caption">
        <h3>
          <a href={`#/movie/${encodeURIComponent(movie.id)}`}>{movie.title}</a>
        </h3>
        <span>{movie.year ?? "Film"}</span>
      </div>
      <p className="movie-meta">
        {!movie.available
          ? "Source unavailable"
          : movie.resumeMs > 0
            ? `Paused at ${Math.floor(movie.resumeMs / 60000)} min`
            : "Ready to discover"}
      </p>
      {movie.resumeMs > 0 && movie.available && (
        <div className="resume-mark" aria-label="Continue watching available" />
      )}
    </article>
  );
}
