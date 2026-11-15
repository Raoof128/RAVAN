import { useState } from "react";
import { cinematicArtwork } from "./artwork.js";

export function FilmStill({
  url,
  priority = false,
}: {
  url?: string;
  priority?: boolean;
}) {
  const art = cinematicArtwork(url);
  const [failed, setFailed] = useState<string>();
  if (!art || failed === art.src)
    return <div className="film-still-fallback" aria-hidden="true" />;
  return (
    <img
      className="film-still"
      src={art.src}
      srcSet={art.srcSet}
      sizes="100vw"
      width={1672}
      height={941}
      alt=""
      aria-hidden="true"
      fetchPriority={priority ? "high" : "auto"}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      onError={() => setFailed(art.src)}
    />
  );
}
