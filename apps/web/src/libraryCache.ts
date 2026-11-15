import type { ApiClient } from "../../../packages/client/src/api.js";
import type { MovieCard } from "../../../packages/contracts/src/index.js";
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
  at: number;
};
const lifetime = 5 * 60 * 1000;
const views = new WeakMap<ApiClient, Map<boolean, LibraryView>>();
export function recallLibrary(api: ApiClient, saved: boolean) {
  const view = views.get(api)?.get(saved);
  return view && Date.now() - view.at < lifetime ? view : undefined;
}
export function rememberLibrary(
  api: ApiClient,
  saved: boolean,
  view: Omit<LibraryView, "at">,
) {
  let own = views.get(api);
  if (!own) views.set(api, (own = new Map()));
  own.set(saved, { ...view, at: Date.now() });
}
/** A film was played, saved or edited: the lists are no longer current. */
export function forgetLibrary(api: ApiClient) {
  views.delete(api);
}
