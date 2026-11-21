import { PDF_SLICE_BYTES } from "../../../../packages/contracts/src/reading.js";
import {
  RANGE_BYTES,
  type ReadingRanges,
} from "../../../../packages/client/src/reading-ranges.js";
import { useEffect, useRef, useState } from "react";
import {
  getDocument,
  PDFDataRangeTransport,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentProxy,
  type PageViewport,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
GlobalWorkerOptions.workerSrc = workerUrl;

export function PdfReader({
  blob,
  section,
  onDocument,
  onCount,
  onReady,
  onError,
}: {
  blob: Blob | ReadingRanges;
  section: number;
  onDocument: (doc: PDFDocumentProxy | undefined) => void;
  onCount: (n: number) => void;
  onReady: () => void;
  onError: (message: string) => void;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const host = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(false);
  useEffect(() => {
    let alive = true;
    let task: ReturnType<typeof getDocument> | undefined;
    async function load() {
      let input;
      if (blob instanceof Blob) input = { data: await blob.arrayBuffer() };
      else {
        const ranges = blob;
        // PDF.js looks for the cross-reference table at the end of the file
        // next. Ask for the tail with the head instead of one trip later.
        if (ranges.size > RANGE_BYTES)
          ranges.pdfSlices.prefetch(
            Math.max(
              RANGE_BYTES,
              ranges.size -
                (ranges.size % PDF_SLICE_BYTES || PDF_SLICE_BYTES) -
                3 * PDF_SLICE_BYTES,
            ),
            ranges.size,
          );
        const initial = await ranges.read(
          0,
          Math.min(ranges.size, RANGE_BYTES),
        );
        const transport = new PDFDataRangeTransport(ranges.size, initial, true);
        transport.requestDataRange = (begin, end) => {
          void ranges.pdfSlices
            .read(begin, end)
            .then((bytes) => {
              if (!alive) return;
              try {
                transport.onDataRange(begin, bytes);
              } catch {
                // PDF.js asserts on a range it no longer waits for (its reader
                // was cancelled); a late answer is not a broken document.
              }
            })
            .catch(() => {
              if (alive) {
                onError(
                  "This PDF page could not be loaded. Reopen the book to try again.",
                );
                void task?.destroy().catch(() => {});
              }
            });
        };
        input = {
          range: transport,
          rangeChunkSize: PDF_SLICE_BYTES,
          disableStream: true,
          disableAutoFetch: true,
        };
      }
      if (!alive) return;
      task = getDocument({
        ...input,
        disableFontFace: true,
        useSystemFonts: true,
        cMapUrl: `${import.meta.env.BASE_URL}reader-assets/cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${import.meta.env.BASE_URL}reader-assets/standard_fonts/`,
        wasmUrl: `${import.meta.env.BASE_URL}reader-assets/wasm/`,
        maxImageSize: 20_000_000,
        canvasMaxAreaInBytes: 32 * 1024 * 1024,
      });
      const doc = await task.promise;
      if (doc.numPages > 10000) {
        await task.destroy();
        throw new Error("Too many PDF pages");
      }
      if (alive) {
        setPdf(doc);
        onDocument(doc);
        onCount(doc.numPages);
      }
    }
    void load().catch(() => {
      if (alive)
        onError(
          "This PDF could not be opened. It may be damaged or password protected.",
        );
    });
    return () => {
      alive = false;
      onDocument(undefined);
      if (task) void task.destroy().catch(() => {});
    };
  }, [blob, onCount, onDocument, onError]);
  // Rendered pages around the reader's place. A turn to a page drawn ahead
  // replaces the canvas at once instead of waiting for PDF.js.
  const rendered = useRef(
    new Map<
      number,
      { canvas: Promise<HTMLCanvasElement>; cancel: () => void }
    >(),
  );
  useEffect(() => {
    const pages = rendered.current;
    return () => {
      for (const entry of pages.values()) entry.cancel();
      pages.clear();
    };
  }, [pdf]);
  useEffect(() => {
    if (!pdf) return;
    let alive = true;
    const pages = rendered.current;
    const draw = (index: number) => {
      const existing = pages.get(index);
      if (existing) return existing.canvas;
      let task: { cancel: () => void } | undefined;
      let cancelled = false;
      let proxy: { cleanup: () => boolean } | undefined;
      const canvas = pdf.getPage(index + 1).then(async (page) => {
        proxy = page;
        if (cancelled) throw new Error("Cancelled");
        const natural = page.getViewport({ scale: 1 });
        const scale = Math.min(2, 1600 / natural.width, 2200 / natural.height);
        const viewport = page.getViewport({ scale });
        const element = document.createElement("canvas");
        element.setAttribute("aria-hidden", "true");
        element.width = Math.ceil(viewport.width);
        element.height = Math.ceil(viewport.height);
        const render = page.render({ canvas: element, viewport });
        task = render;
        await render.promise;
        return element;
      });
      const entry = {
        canvas,
        // Dropping a page frees what PDF.js keeps for it (its operator list
        // and images stay on the page until cleanup) and the canvas memory.
        cancel: () => {
          cancelled = true;
          task?.cancel();
          void canvas
            .then(
              (element) => {
                element.width = 0;
                element.height = 0;
              },
              () => {},
            )
            .finally(() => proxy?.cleanup());
        },
      };
      pages.set(index, entry);
      // A failed or cancelled drawing is not remembered.
      canvas.catch(() => {
        if (pages.get(index) === entry) pages.delete(index);
      });
      return canvas;
    };
    const current = Math.min(section, pdf.numPages - 1);
    const keep = new Set([current - 1, current, current + 1]);
    for (const [index, entry] of pages)
      if (!keep.has(index)) {
        entry.cancel();
        pages.delete(index);
      }
    setEmpty(false);
    host.current?.replaceChildren();
    let layer: TextLayer | undefined;
    let resize: ResizeObserver | undefined;
    let unguard: (() => void) | undefined;
    void draw(current)
      .then(async (canvas) => {
        if (!alive) return;
        host.current?.replaceChildren(canvas);
        onReady();
        // Draw the next page while this one is read.
        if (current + 1 < pdf.numPages) void draw(current + 1).catch(() => {});
        // Some image-only or damaged PDFs render even when the text layer fails.
        const page = await pdf.getPage(current + 1);
        const content = await page.getTextContent().catch(() => undefined);
        if (!alive) return;
        if (!content?.items.some((item) => "str" in item && item.str.trim())) {
          setEmpty(true);
          return;
        }
        // Selectable text over the drawing, laid out by PDF.js at the size
        // the canvas is shown, so it can be selected and copied.
        const container = document.createElement("div");
        container.className = "textLayer";
        const viewport = page.getViewport({ scale: 1 });
        layer = new TextLayer({
          textContentSource: content,
          container,
          viewport,
        });
        await layer.render();
        if (!alive || !host.current) return;
        unguard = guardSelection(container);
        host.current.append(container);
        resize = new ResizeObserver(() => place(container, canvas, viewport));
        resize.observe(canvas);
        place(container, canvas, viewport);
      })
      .catch(() => {
        if (alive) onError("This PDF page could not be rendered.");
      });
    return () => {
      alive = false;
      layer?.cancel();
      resize?.disconnect();
      unguard?.();
    };
  }, [pdf, section, onReady, onError]);
  return (
    <>
      <div className="reading-pdf" ref={host} />
      {empty && (
        <p className="reading-accessible-text">
          No text is available for this PDF page.
        </p>
      )}
    </>
  );
}

/** Lay the text over the canvas as the reader shows it. */
function place(
  layer: HTMLElement,
  canvas: HTMLCanvasElement,
  viewport: PageViewport,
) {
  if (!canvas.clientWidth) return;
  layer.style.left = `${canvas.offsetLeft}px`;
  layer.style.top = `${canvas.offsetTop}px`;
  layer.style.setProperty(
    "--total-scale-factor",
    String(canvas.clientWidth / viewport.width),
  );
}

let placing: boolean | undefined;
function selfPlacing() {
  if (placing !== undefined) return placing;
  const agent = navigator.userAgent;
  const chromium =
    (
      navigator as Navigator & {
        userAgentData?: { brands: Array<{ brand: string; version: string }> };
      }
    ).userAgentData?.brands.find((b) => b.brand === "Chromium")?.version ??
    /\bChrome\/(\d+)\b/.exec(agent)?.[1];
  placing =
    /\bFirefox\//.test(agent) || (!!chromium && parseInt(chromium, 10) >= 148);
  return placing;
}

/**
 * Text layer lines are positioned boxes with gaps between them. A pointer in
 * a gap, or past the end of a line, would select to the end of the page or
 * drop the selection. As PDF.js's own viewer does (TextLayerBuilder,
 * pdfjs-dist 6.5), a selectable block that covers the layer is kept just
 * after the moving end of the selection while a selection is being made.
 */
function guardSelection(layer: HTMLElement): () => void {
  const end = document.createElement("div");
  end.className = "endOfContent";
  layer.append(end);
  const controller = new AbortController();
  const { signal } = controller;
  let pointer = false;
  let previous: Range | undefined;
  const reset = () => {
    layer.append(end);
    end.style.width = "";
    end.style.height = "";
    end.style.userSelect = "";
    layer.classList.remove("selecting");
    previous = undefined;
  };
  layer.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button === 0) layer.classList.add("selecting");
    },
    { signal },
  );
  document.addEventListener("pointerdown", () => (pointer = true), {
    signal,
  });
  const release = () => {
    pointer = false;
    reset();
  };
  document.addEventListener("pointerup", release, { signal });
  document.addEventListener("pointercancel", release, { signal });
  window.addEventListener("blur", release, { signal });
  document.addEventListener(
    "keyup",
    () => {
      if (!pointer) reset();
    },
    { signal },
  );
  document.addEventListener(
    "selectionchange",
    () => {
      const selection = document.getSelection();
      if (!selection?.rangeCount) return reset();
      const range = selection.getRangeAt(0);
      if (
        (range.collapsed && !pointer) ||
        !range.intersectsNode(layer) ||
        !pointer
      )
        return;
      layer.classList.add("selecting");
      // Firefox and Chromium 148 or later place the end correctly over the
      // covering block; moving it there misplaces the end (PDF.js does the same).
      if (selfPlacing()) return;
      const moveStart =
        previous &&
        (range.compareBoundaryPoints(Range.END_TO_END, previous) === 0 ||
          range.compareBoundaryPoints(Range.START_TO_END, previous) === 0);
      let anchor: Node | null = moveStart
        ? range.startContainer
        : range.endContainer;
      if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
      if (!moveStart && range.endOffset === 0 && anchor) {
        // The end sits before a line: keep the block after the line before it.
        do {
          while (anchor && !anchor.previousSibling && anchor !== layer)
            anchor = anchor.parentNode;
          if (!anchor || anchor === layer) break;
          anchor = anchor.previousSibling;
        } while (anchor && !anchor.childNodes.length);
      }
      const parent = anchor?.parentElement;
      if (
        anchor &&
        anchor !== end &&
        parent &&
        parent.closest(".textLayer") === layer
      ) {
        end.style.width = layer.style.width;
        end.style.height = layer.style.height;
        end.style.userSelect = "text";
        parent.insertBefore(end, moveStart ? anchor : anchor.nextSibling);
      }
      previous = range.cloneRange();
    },
    { signal },
  );
  return () => {
    controller.abort();
    reset();
  };
}
