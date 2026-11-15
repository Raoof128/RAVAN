// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  readableChoices,
  TrackPanel,
} from "../../apps/web/src/player/TrackPanel.js";

afterEach(cleanup);

it("names tracks in words and tells repeats apart", () => {
  expect(
    readableChoices([
      { id: "0", label: "eng", language: "eng" },
      { id: "1", label: "eng", language: "eng" },
      { id: "2", label: "cze", language: "cze" },
      { id: "3", label: "Persian · 5.1", language: "fas" },
      { id: "4", label: "Director's commentary", language: "eng" },
      { id: "5", label: "und", language: "und" },
    ]).map((o) => [o.label, o.detail]),
  ).toEqual([
    ["English 1", undefined],
    ["English 2", undefined],
    ["Czech", undefined],
    ["Persian", "5.1"],
    ["Director's commentary", undefined],
    ["und", undefined],
  ]);
});

it("applies a choice at once, keeps the panel open, and closes on Escape", () => {
  const audio = vi.fn();
  render(
    <TrackPanel
      summary="English · Subtitles off"
      audio={{
        options: [
          { id: "0", label: "English" },
          { id: "1", label: "Japanese" },
        ],
        selected: "0",
        onSelect: audio,
      }}
      subtitles={{
        options: [
          { id: "", label: "Off" },
          {
            id: "2",
            label: "French",
            detail: "picture, can’t be shown",
            disabled: true,
          },
        ],
        selected: "",
        onSelect: vi.fn(),
      }}
      picture={{
        options: [{ id: "auto", label: "Auto" }],
        selected: "auto",
        onSelect: vi.fn(),
      }}
    />,
  );
  const button = screen.getByRole("button", { name: /Audio & subtitles/ });
  expect(button.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(button);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  // Focus starts on the language playing.
  expect(document.activeElement).toBe(
    screen.getByRole("radio", { name: "English" }),
  );
  fireEvent.click(screen.getByRole("radio", { name: "Japanese" }));
  expect(audio).toHaveBeenCalledWith("1");
  // Shown at once, before the player confirms the switch.
  expect(
    (screen.getByRole("radio", { name: "Japanese" }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  expect(screen.getByRole("dialog")).toBeTruthy();
  // What cannot be shown is listed, and cannot be chosen.
  expect(
    (
      screen.getByRole("radio", {
        name: "French picture, can’t be shown",
      }) as HTMLInputElement
    ).disabled,
  ).toBe(true);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(button);
});
