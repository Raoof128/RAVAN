import { useState } from "react";
import { cinematicArtwork } from "./artwork.js";

export function FilmStill({
  url,
  priority = false,
  source,
}: {
  url?: string;
  priority?: boolean;
  /** A picture already loaded by the caller (the TV), as a local object URL. */
  source?: string;
}) {
  const art =
    source && source.startsWith("blob:")
      ? { src: source, srcSet: undefined }
      : cinematicArtwork(url);
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
