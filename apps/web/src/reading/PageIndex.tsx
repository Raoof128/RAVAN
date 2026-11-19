import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { OpenBook } from "./book.js";
import { ReaderPanel } from "./ReaderPanel.js";
import { Icon } from "../../../../packages/ui/src/Icon.js";

const BATCH = 6;
type Art = { pdf?: PDFDocumentProxy; book?: OpenBook };
async function preview({ pdf, book }: Art, index: number, signal: AbortSignal) {
  const canvas = document.createElement("canvas");
  if (pdf) {
    const page = await pdf.getPage(index + 1);
    signal.throwIfAborted();
    const natural = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({
      scale: 240 / Math.max(natural.width, natural.height),
    });
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const task = page.render({ canvas, viewport });
    const cancel = () => task.cancel();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      await task.promise;
    } finally {
      signal.removeEventListener("abort", cancel);
      // A preview should not keep the page's full-size resources alive.
      void task.promise.catch(() => {}).finally(() => page.cleanup());
    }
  } else if (book?.format === "cbz") {
    const page = await book.page(index, signal);
    try {
      signal.throwIfAborted();
      if (!page.image) return;
      const image = new Image();
      image.src = page.image;
      await image.decode();
      signal.throwIfAborted();
      const scale = 240 / Math.max(image.naturalWidth, image.naturalHeight);
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas
        .getContext("2d")
        ?.drawImage(image, 0, 0, canvas.width, canvas.height);
    } finally {
      page.release();
    }
  } else return;
  return canvas;
}

export function PageIndex({
  section,
  count,
  unit,
  rtl,
  pdf,
  book,
  onSelect,
  onDismiss,
}: Art & {
  section: number;
  count: number;
  unit: "Page" | "Chapter";
  rtl: boolean;
  onSelect: (section: number) => void;
  onDismiss: () => void;
}) {
  const [start, setStart] = useState(Math.floor(section / BATCH) * BATCH);
  const grid = useRef<HTMLDivElement>(null);
  const end = Math.min(count, start + BATCH);
  const illustrated = Boolean(pdf || book?.format === "cbz");
  useEffect(() => {
    if (!illustrated) return;
    const controller = new AbortController();
    const slots = grid.current!.querySelectorAll<HTMLElement>(".reader-thumb");
    // Large scans are decoded one at a time, and only while this group is open.
    async function paint() {
      for (const [offset, slot] of slots.entries()) {
        if (controller.signal.aborted) break;
        try {
          const art = await preview(
            { pdf, book },
            start + offset,
            controller.signal,
          );
          if (art && !controller.signal.aborted) slot.replaceChildren(art);
        } catch {
          // A missing preview still has a numbered button that opens the page.
        }
      }
    }
    void paint();
    return () => controller.abort();
  }, [start, book, pdf, illustrated]);
  return (
    <ReaderPanel
      title={unit === "Page" ? "Page index" : "Chapter index"}
      onDismiss={onDismiss}
    >
      <form
        className="reader-jump"
        onSubmit={(event) => {
          event.preventDefault();
          const n = Number(new FormData(event.currentTarget).get("number"));
          if (Number.isInteger(n) && n >= 1 && n <= count) onSelect(n - 1);
        }}
      >
        <label htmlFor="reading-number">Go to {unit.toLowerCase()}</label>
        <input
          id="reading-number"
          name="number"
          type="number"
          inputMode="numeric"
          min={1}
          max={count}
          required
          defaultValue={section + 1}
        />
        <span>of {count}</span>
        <button type="submit">Go</button>
      </form>
      <div className="reader-index-grid" ref={grid} dir={rtl ? "rtl" : "ltr"}>
        {Array.from({ length: end - start }, (_, offset) => {
          const i = start + offset;
          return (
            <button
              type="button"
              key={i}
              onClick={() => onSelect(i)}
              aria-label={`Open ${unit.toLowerCase()} ${i + 1}`}
              aria-current={i === section ? "page" : undefined}
            >
              {illustrated && (
                <span className="reader-thumb" aria-hidden="true">
                  <span>{i + 1}</span>
                </span>
              )}
              <span>
                {unit} {i + 1}
              </span>
            </button>
          );
        })}
      </div>
      <div className="reader-index-range">
        <button
          className="reader-icon-button"
          aria-label="Previous group"
          disabled={start === 0}
          onClick={() => setStart(start - BATCH)}
        >
          <Icon name="arrow-left" />
        </button>
        <span role="status">
          {unit === "Page" ? "Pages" : "Chapters"} {start + 1}–{end} of {count}
        </span>
        <button
          className="reader-icon-button"
          aria-label="Next group"
          disabled={end >= count}
          onClick={() => setStart(end)}
        >
          <Icon name="arrow-right" />
        </button>
      </div>
    </ReaderPanel>
  );
}
