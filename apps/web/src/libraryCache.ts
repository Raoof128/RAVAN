import type { ApiClient } from "../../../packages/client/src/api.js";
import type {
  MovieCard,
  MovieList,
} from "../../../packages/contracts/src/index.js";
/**
 * What the library last showed, so that returning from a film finds the same
 * films, search and place on the page instead of a fresh first page. It is
 * held in memory per API client, for five minutes, and dropped whenever
 * something that the list shows may have changed.
 */
export type LibraryView = {
  query: string;
  items: MovieCard[];
  cursor: string | null;
  folder?: MovieList["folder"];
  folders?: MovieList["folders"];
  resume?: MovieList["resume"];
  at: number;
};
/** Which list a view is of: the watchlist (true), the top of the library (false), or a folder by id. */
export type LibraryKey = boolean | string;
const lifetime = 5 * 60 * 1000;
const views = new WeakMap<ApiClient, Map<LibraryKey, LibraryView>>();
export function recallLibrary(api: ApiClient, key: LibraryKey) {
  const view = views.get(api)?.get(key);
  return view && Date.now() - view.at < lifetime ? view : undefined;
}
export function rememberLibrary(
  api: ApiClient,
  key: LibraryKey,
  view: Omit<LibraryView, "at">,
) {
  let own = views.get(api);
  if (!own) views.set(api, (own = new Map()));
  own.set(key, { ...view, at: Date.now() });
}
/** A film was played, saved or edited: the lists are no longer current. */
export function forgetLibrary(api: ApiClient) {
  views.delete(api);
}
