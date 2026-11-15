// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Library } from "../../apps/web/src/pages/Library.js";
import { Settings } from "../../apps/web/src/pages/Settings.js";
import { Preparing } from "../../apps/web/src/player/Preparing.js";
import {
  applyMotion,
  rememberMotion,
  restoreMotion,
} from "../../apps/web/src/motion.js";
import { ApiContext, createApiClient } from "../../packages/client/src/api.js";
import { ActionButton, usePending } from "../../packages/ui/src/Loading.js";
import { MovieCard } from "../../packages/ui/src/MovieCard.js";
import { StatusPanel } from "../../packages/ui/src/StatusPanel.js";
import type {
  MovieCard as Movie,
  PreparationPhase,
} from "../../packages/contracts/src/index.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete document.documentElement.dataset.motion;
  localStorage.clear();
});
const film = (id: string, extra: Partial<Movie> = {}): Movie => ({
  id,
  title: `Film ${id}`,
  resumeMs: 0,
  available: true,
  ...extra,
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("shows only the preparation step and progress the server reported", () => {
  const cases: Array<[PreparationPhase, string]> = [
    ["inspecting", "Read the file"],
    ["queued", "Wait for the server"],
    ["retrying", "Try again"],
    ["repackaging", "Repackage, picture untouched"],
    ["converting", "Convert for this screen"],
    ["buffering", "Start the film"],
  ];
  for (const [phase, label] of cases) {
    const view = render(<Preparing phase={phase} progress={40} reason="r" />);
    const current = view.container.querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain(label);
    // A percentage appears only while a worker is writing the film.
    const measured = ["repackaging", "converting", "buffering"].includes(phase);
    expect(view.container.querySelectorAll("progress").length).toBe(
      measured ? 1 : 0,
    );
    expect(view.queryByText("40% prepared") !== null).toBe(measured);
    view.unmount();
  }
});

it("never invents a percentage, a step or a time", () => {
  // An answer with no phase and no progress: a sentence and a moving line.
  const bare = render(<Preparing />);
  expect(bare.container.querySelector("progress")).toBeNull();
  expect(bare.container.querySelector(".prep-steps")).toBeNull();
  expect(bare.container.querySelector(".flow")).not.toBeNull();
  expect(bare.container.textContent).not.toMatch(
    /remaining|minutes? left|seconds? left|%|fps|speed/i,
  );
  bare.unmount();
  // Queued work reports progress 0; that is not shown as "0% prepared".
  const queued = render(<Preparing phase="queued" progress={0} />);
  expect(queued.container.textContent).not.toContain("%");
  queued.unmount();
  // Out-of-range and non-numeric values are clamped or ignored.
  const over = render(<Preparing phase="converting" progress={250.9} />);
  expect(over.getByRole("progressbar").getAttribute("value")).toBe("100");
  over.unmount();
  const broken = render(<Preparing phase="converting" progress={NaN} />);
  expect(broken.container.querySelector("progress")).toBeNull();
  // A phase from a newer server than this client still renders its reason.
  broken.unmount();
  const older = render(
    <Preparing progress={42} reason="Creating a compatible edition." />,
  );
  expect(older.getByRole("progressbar").getAttribute("value")).toBe("42");
  expect(older.getByText("Creating a compatible edition.")).toBeTruthy();
});

it("runs one action at a time and keeps the control focusable", async () => {
  const work = deferred<void>();
  const action = vi.fn(() => work.promise);
  function Example() {
    const [pending, run] = usePending();
    return (
      <ActionButton
        pending={pending}
        pendingLabel="Saving"
        onClick={() => void run(action)}
      >
        Save
      </ActionButton>
    );
  }
  render(<Example />);
  const button = screen.getByRole("button", { name: "Save" });
  button.focus();
  fireEvent.click(button);
  fireEvent.click(button);
  fireEvent.click(button);
  expect(action).toHaveBeenCalledTimes(1);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.hasAttribute("disabled")).toBe(false);
  expect(document.activeElement).toBe(button);
  // Announced through a region that outlives the button's own content.
  await waitFor(() =>
    expect(document.getElementById("announcer")?.textContent).toBe("Saving"),
  );
  expect(button.textContent).toBe("Save");
  await act(async () => {
    work.resolve();
    await work.promise;
  });
  expect(button.getAttribute("aria-busy")).toBeNull();
  fireEvent.click(button);
  expect(action).toHaveBeenCalledTimes(2);
});

it("gives each film one link and announces failures at once", () => {
  render(<MovieCard movie={film("a", { resumeMs: 600000, year: 1999 })} />);
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByRole("link", { name: "View Film a" })).toBeTruthy();
  expect(screen.getByText("Paused at 10 min")).toBeTruthy();
  cleanup();
  render(<MovieCard movie={film("b")} />);
  // Nothing is said about a film there is nothing to say about.
  expect(document.querySelector(".movie-meta")).toBeNull();
  cleanup();
  render(
    <StatusPanel tone="error" title="Failed">
      x
    </StatusPanel>,
  );
  expect(screen.getByRole("alert")).toBeTruthy();
  cleanup();
  render(<StatusPanel title="Empty">x</StatusPanel>);
  expect(screen.getByRole("status")).toBeTruthy();
});

it("keeps the last results on screen while searching and ignores a late answer", async () => {
  const api = createApiClient("");
  const slow = deferred<{ items: Movie[]; nextCursor: null }>();
  api.listMovies = vi.fn((_cursor, query) => {
    if (!query)
      return Promise.resolve({
        items: [film("one"), film("two")],
        nextCursor: null,
      });
    if (query === "o") return slow.promise;
    return Promise.resolve({ items: [film("only")], nextCursor: null });
  }) as typeof api.listMovies;
  render(
    <ApiContext.Provider value={api}>
      <Library />
    </ApiContext.Provider>,
  );
  expect(await screen.findByRole("heading", { name: "Film two" })).toBeTruthy();
  const search = screen.getByRole("searchbox");
  fireEvent.change(search, { target: { value: "o" } });
  // The grid is still there: no flash of placeholders between searches.
  expect(screen.getByRole("heading", { name: "Film two" })).toBeTruthy();
  fireEvent.change(search, { target: { value: "on" } });
  expect(
    await screen.findByRole("heading", { name: "Film only" }),
  ).toBeTruthy();
  // The answer to the abandoned search arrives last and is dropped.
  await act(async () => {
    slow.resolve({ items: [film("stale")], nextCursor: null });
    await slow.promise;
  });
  expect(screen.queryByRole("heading", { name: "Film stale" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Film only" })).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByText("1 film found for on.")).toBeTruthy(),
  );
});

it("keeps the films already shown when the next page fails", async () => {
  const api = createApiClient("");
  api.listMovies = vi.fn((cursor) =>
    cursor
      ? Promise.reject(new Error("offline"))
      : Promise.resolve({ items: [film("one")], nextCursor: "next" }),
  ) as typeof api.listMovies;
  render(
    <ApiContext.Provider value={api}>
      <Library />
    </ApiContext.Provider>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "More from your collection" }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "didn’t load",
  );
  expect(
    screen.getByRole("heading", { name: "Film one", level: 3 }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "More from your collection" }),
  ).toBeTruthy();
});

function settings(overrides: Partial<ReturnType<typeof createApiClient>> = {}) {
  const api = Object.assign(createApiClient(""), {
    library: vi.fn().mockResolvedValue({
      folderId: "folder",
      state: "succeeded",
      counts: { upserts: 3, unavailable: 1 },
    }),
    preferences: vi.fn().mockResolvedValue({
      audioLanguage: "en",
      subtitleLanguage: "off",
      quality: "original",
      reducedMotion: false,
    }),
    devices: vi.fn().mockResolvedValue([{ id: "tv", name: "Living room" }]),
    ...overrides,
  });
  render(
    <ApiContext.Provider value={api}>
      <Settings />
    </ApiContext.Provider>,
  );
  return api;
}

it("reports the library as the server describes it and confirms before removing a TV", async () => {
  const api = settings({ revokeDevice: vi.fn().mockResolvedValue(undefined) });
  expect(
    await screen.findByText(
      "Folder connected. 3 files read in the last update, 1 no longer available.",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove Living room" }));
  // The first press asks; nothing has been removed yet.
  expect(api.revokeDevice).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep" }));
  expect(api.revokeDevice).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Remove Living room" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove Living room" }));
  await waitFor(() => expect(api.revokeDevice).toHaveBeenCalledWith("tv"));
  expect(await screen.findByText(/Living room removed/)).toBeTruthy();
  expect(screen.getByText("No paired televisions yet.")).toBeTruthy();
});

it("applies the reduced-motion preference when it is saved, and only then", async () => {
  const save = deferred<void>();
  settings({ savePreferences: vi.fn(() => save.promise) as never });
  fireEvent.click(await screen.findByLabelText("Reduce interface motion"));
  expect(document.documentElement.dataset.motion).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
  expect(document.documentElement.dataset.motion).toBeUndefined();
  await act(async () => {
    save.resolve();
    await save.promise;
  });
  await waitFor(() =>
    expect(document.documentElement.dataset.motion).toBe("reduce"),
  );
  expect(screen.getByText("Preferences saved.")).toBeTruthy();
  expect(localStorage.getItem("ravan:motion")).toBe("reduce");
});

it("accepts a pasted Drive link, and offers a retry when settings cannot load", async () => {
  const api = settings({ setFolder: vi.fn().mockResolvedValue(undefined) });
  const field = (await screen.findByLabelText(
    "Drive folder ID",
  )) as HTMLInputElement;
  fireEvent.change(field, {
    target: {
      value: "https://drive.google.com/drive/folders/1AbC_d-9?usp=sharing",
    },
  });
  expect(field.value).toBe("1AbC_d-9");
  fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
  await waitFor(() => expect(api.setFolder).toHaveBeenCalledWith("1AbC_d-9"));
  cleanup();
  const failing = settings({
    library: vi.fn().mockRejectedValue(new Error("offline")),
  });
  const failure = await screen.findByText("Your settings couldn’t be loaded.");
  expect(failure.closest('[role="alert"]')).not.toBeNull();
  failing.library = vi.fn().mockResolvedValue({
    folderId: null,
    state: "idle",
    counts: {},
  });
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("No folder selected")).toBeTruthy();
});

it("stores nothing but the motion flag, and survives blocked storage", () => {
  rememberMotion(true);
  expect(document.documentElement.dataset.motion).toBe("reduce");
  expect(JSON.stringify(localStorage)).toBe('{"ravan:motion":"reduce"}');
  applyMotion(false);
  restoreMotion();
  expect(document.documentElement.dataset.motion).toBe("reduce");
  rememberMotion(false);
  expect(localStorage.length).toBe(0);
  expect(document.documentElement.dataset.motion).toBeUndefined();
  const blocked = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("denied");
    });
  expect(() => rememberMotion(true)).not.toThrow();
  expect(document.documentElement.dataset.motion).toBe("reduce");
  blocked.mockRestore();
});
