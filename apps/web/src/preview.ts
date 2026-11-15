import { sampleArtwork } from "../../../packages/ui/src/artwork.js";
import { createApiClient } from "../../../packages/client/src/api.js";
import type { MovieDetail } from "../../../packages/contracts/src/index.js";
const titles = [
  "The Quiet Coast",
  "Night Transit",
  "Other Skies",
  "A Place Between",
  "After the Rain",
  "Slow Light",
];
export function previewApi() {
  const api = createApiClient("");
  const movies: MovieDetail[] = titles.map((title, i) => ({
    id: `sample-${i}`,
    title,
    year: 2021 + (i % 5),
    posterUrl: sampleArtwork[i],
    resumeMs: i === 0 ? 1320000 : 0,
    available: true,
    description:
      "A sample film created for the RAVAN interface preview. Your own titles and descriptions will appear here when you connect your library.",
    saved: i === 2,
    editions: [
      {
        id: `source-${i}`,
        label: "Original",
        state: "source",
        sourceId: `fixture-${i}`,
        available: true,
      },
    ],
    tracks: [],
  }));
  api.session = async () => ({ authenticated: true, configured: true });
  api.listMovies = async (_cursor, q = "", saved = false) => ({
    items: movies.filter(
      (m) =>
        (!saved || m.saved) && m.title.toLowerCase().includes(q.toLowerCase()),
    ),
    nextCursor: null,
  });
  api.detail = async (id) => {
    const m = movies.find((m) => m.id === id);
    if (!m) throw new Error("Missing sample");
    return { ...m };
  };
  api.saveMovie = async (id, saved) => {
    const movie = movies.find((m) => m.id === id);
    if (movie) movie.saved = saved;
  };
  api.editMovie = async (id, value) => {
    const m = movies.find((m) => m.id === id);
    if (!m) throw new Error("Missing sample");
    Object.assign(m, value);
    return { ...m };
  };
  api.playback = async () => ({
    kind: "unsupported",
    reason:
      "This is an interface preview. Connect your own library to play a film.",
  });
  api.library = async () => ({ folderId: null, state: "idle", counts: {} });
  api.preferences = async () => ({
    audioLanguage: "en",
    subtitleLanguage: "en",
    reducedMotion: false,
  });
  api.devices = async () => [];
  const previewOnly = async () => {
    throw new Error("Preview only");
  };
  api.logout = previewOnly;
  api.enrollMfa = previewOnly;
  api.verifyMfa = previewOnly;
  api.cancelMfa = previewOnly;
  api.setFolder = previewOnly;
  api.sync = previewOnly;
  api.approvePairing = previewOnly;
  api.savePreferences = previewOnly;
  return api;
}
