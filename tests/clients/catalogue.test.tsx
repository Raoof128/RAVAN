// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Library } from "../../apps/web/src/pages/Library.js";
import { ApiContext, createApiClient } from "../../packages/client/src/api.js";
import type { MovieCard } from "../../packages/contracts/src/index.js";
afterEach(cleanup);
function setup(items: MovieCard[] = [], fails = false) {
  const api = createApiClient("");
  api.listMovies = vi.fn().mockImplementation(async () => {
    if (fails) throw new Error("network");
    return { items, nextCursor: null };
  });
  render(
    <ApiContext.Provider value={api}>
      <Library />
    </ApiContext.Provider>,
  );
  return api;
}
it("shows a useful empty library action", async () => {
  setup();
  expect(
    await screen.findByText("Your next favourite starts here."),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("link", { name: "Choose a Drive folder" })
      .getAttribute("href"),
  ).toBe("#/settings");
});
it("renders malicious titles as text and unavailable sources honestly", async () => {
  setup([
    { id: "a", title: "<img onerror=alert(1)>", resumeMs: 0, available: false },
  ]);
  expect(
    await screen.findByRole("heading", { name: "<img onerror=alert(1)>" }),
  ).toBeTruthy();
  expect(document.querySelector("img[onerror]")).toBeNull();
  expect(screen.getByText("Source unavailable")).toBeTruthy();
});
it("allows retry after a disconnected backend", async () => {
  const api = setup([], true);
  expect(
    await screen.findByText("We couldn’t load your library."),
  ).toBeTruthy();
  api.listMovies = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(screen.getByText("Your next favourite starts here.")).toBeTruthy(),
  );
});

it("keeps local details when editing fails and identifies ambiguous editions", async () => {
  const { Detail } = await import("../../apps/web/src/pages/Detail.js");
  const api = createApiClient("");
  api.detail = vi.fn().mockResolvedValue({
    id: "film",
    title: "Local title",
    description: "Local description",
    saved: false,
    resumeMs: 0,
    available: true,
    editions: [
      { id: "one", label: "Original", state: "source", available: true },
      { id: "two", label: "Second copy", state: "source", available: true },
    ],
    tracks: [],
  });
  api.editMovie = vi.fn().mockRejectedValue(new Error("offline"));
  render(
    <ApiContext.Provider value={api}>
      <Detail id="film" />
    </ApiContext.Provider>,
  );
  expect(
    await screen.findByText(/Multiple editions need a selection/),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit film details" }));
  fireEvent.click(screen.getByRole("button", { name: "Save details" }));
  expect(await screen.findByText(/Couldn’t save the details/)).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Local title" })).toBeTruthy();
  expect(screen.getByText("Local description", { selector: "p" })).toBeTruthy();
});

it("restricts artwork to bundled illustrations and local artwork IDs", async () => {
  const { artworkUrl, sampleArtwork, cinematicArtwork } =
    await import("../../packages/ui/src/artwork.js");
  expect(artworkUrl("/api/artwork/film_123")).toBe("/api/artwork/film_123");
  expect(artworkUrl(sampleArtwork[0])).toBe(sampleArtwork[0]);
  for (const bad of [
    "https://tracker.test/poster",
    "//tracker.test/a",
    "/api/artwork/../session",
    "/api/artwork/%2e%2e/session",
    "/api/artwork/a?url=https://tracker.test",
    "javascript:alert(1)",
  ])
    expect(artworkUrl(bad)).toBeUndefined();
  expect(cinematicArtwork("/api/artwork/film_123")).toBeUndefined();
});
