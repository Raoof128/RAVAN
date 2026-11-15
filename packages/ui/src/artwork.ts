import coast from "./art/coast.webp";
import coastHero from "./art/coast-hero.webp";
import coastSmall from "./art/coast-small.webp";
import transit from "./art/transit.webp";
import skies from "./art/skies.webp";
import between from "./art/between.webp";
import rain from "./art/rain.webp";
import light from "./art/light.webp";

// Only explicit, bundled sample URLs receive fictional artwork. A real movie's
// identifier or title must never silently select a sample film's illustration.
export const sampleArtwork = [coast, transit, skies, between, rain, light];
export function artworkUrl(url?: string): string | undefined {
  if (!url) return undefined;
  if (sampleArtwork.includes(url)) return url;
  return /^\/api\/artwork\/[a-zA-Z0-9_-]+$/.test(url) ? url : undefined;
}
export function cinematicArtwork(url?: string) {
  if (!url || !sampleArtwork.includes(url)) return undefined;
  return url === coast
    ? { src: coastHero, srcSet: `${coastSmall} 840w, ${coastHero} 1672w` }
    : { src: url, srcSet: undefined };
}
