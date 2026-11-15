import { useEffect, useId, useRef, useState } from "react";
import { languageName } from "./languages.js";

/** One row in a list: what it is called, and a quieter word about it. */
export type TrackChoice = {
  id: string;
  label: string;
  /** "5.1", "for the hard of hearing", "can't be shown"… */
  detail?: string;
  disabled?: boolean;
};
export type TrackList = {
  options: TrackChoice[];
  selected?: string;
  onSelect: (id: string) => void;
  /** A sentence under the list, when the list needs one. */
  note?: string;
};

/**
 * Track names as people read them. A bare language code ("cze") becomes its
 * name ("Czech"); repeated names are told apart by number.
 */
export function readableChoices(
  options: Array<TrackChoice & { language?: string }>,
): TrackChoice[] {
  const named = options.map((o) => {
    const bare = /^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(o.label.trim());
    const [name, ...rest] = o.label.split(" · ");
    const label =
      (bare ? languageName(o.label) : undefined) ??
      (name && o.language && name.trim().toLowerCase() === o.language
        ? languageName(o.language)
        : undefined) ??
      name ??
      o.label;
    return {
      ...o,
      label,
      detail: o.detail ?? (rest.length ? rest.join(" · ") : undefined),
    };
  });
  const seen = new Map<string, number>();
  return named.map((o) => {
    const count = (seen.get(o.label) ?? 0) + 1;
    seen.set(o.label, count);
    const repeated = named.filter((n) => n.label === o.label).length > 1;
    return repeated ? { ...o, label: `${o.label} ${count}` } : o;
  });
}

function List({
  name,
  legend,
  list,
  autoFocus,
}: {
  name: string;
  legend: string;
  list: TrackList;
  autoFocus?: boolean;
}) {
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) first.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  const noteId = useId();
  // A choice shows at once; the player's report replaces it when it comes
  // (a language switch completes a moment later).
  const [pending, setPending] = useState<string>();
  useEffect(() => setPending(undefined), [list.selected]);
  const current = pending ?? list.selected;
  const focusIndex = Math.max(
    0,
    list.options.findIndex((o) => o.id === current && !o.disabled),
  );
  return (
    <fieldset
      className="track-list"
      aria-describedby={list.note ? noteId : undefined}
    >
      <legend>{legend}</legend>
      <div className="track-rows">
        {list.options.map((option, i) => (
          <label
            key={option.id}
            className={`track-option${option.disabled ? " is-disabled" : ""}`}
          >
            <input
              ref={i === focusIndex ? first : undefined}
              className="track-input"
              type="radio"
              name={name}
              value={option.id}
              checked={option.id === current}
              disabled={option.disabled}
              onChange={() => {
                setPending(option.id);
                list.onSelect(option.id);
              }}
            />
            <span className="track-row">
              <span className="track-name">{option.label}</span>
              {/* A space, so the radio's spoken name keeps the words apart. */}{" "}
              {option.detail && (
                <span className="track-detail">{option.detail}</span>
              )}
            </span>
          </label>
        ))}
      </div>
      {list.note && (
        <p className="track-note" id={noteId}>
          {list.note}
        </p>
      )}
    </fieldset>
  );
}

/**
 * Audio, subtitles and picture in one place, styled as the rest of RAVAN.
 * Lists are radio groups: arrow keys move within one, Tab between them, and
 * a choice applies at once. Escape, the close button or a click outside
 * closes the panel and returns focus to the button that opened it.
 */
export function TrackPanel({
  audio,
  subtitles,
  picture,
  summary,
}: {
  audio?: TrackList;
  subtitles?: TrackList;
  picture: TrackList;
  summary: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const panelId = useId();
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !panel.current?.contains(target) &&
        !trigger.current?.contains(target)
      )
        close(false);
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", outside, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [open]);
  return (
    <div className="track-picker">
      <button
        ref={trigger}
        type="button"
        className="track-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          className="icon"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M7 12h4M13 12h4M7 15.5h7" />
        </svg>
        <span className="track-trigger-text">
          <span>Audio &amp; subtitles</span>
          <span className="track-summary">{summary}</span>
        </span>
      </button>
      {open && (
        // On a phone the panel is a sheet; the dimmed page behind it closes it.
        <div
          className="track-scrim"
          aria-hidden="true"
          onClick={() => close()}
        />
      )}
      {open && (
        <section
          ref={panel}
          id={panelId}
          className="track-panel"
          role="dialog"
          aria-label="Audio, subtitles and picture"
        >
          <header className="track-head">
            <h2>Audio &amp; subtitles</h2>
            <button
              type="button"
              className="track-close"
              aria-label="Close"
              onClick={() => close()}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </header>
          <div className="track-columns">
            {audio && (
              <List name="audio" legend="Audio" list={audio} autoFocus />
            )}
            {subtitles && (
              <List
                name="subtitles"
                legend="Subtitles"
                list={subtitles}
                autoFocus={!audio}
              />
            )}
            <List name="picture" legend="Picture" list={picture} />
          </div>
        </section>
      )}
    </div>
  );
}
