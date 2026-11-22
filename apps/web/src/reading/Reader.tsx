import type { ReadingRanges } from "../../../../packages/client/src/reading-ranges.js";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ReadingFormat,
  ReadingPosition,
  ReadingPreparation,
} from "../../../../packages/contracts/src/reading.js";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PreparationStatus } from "./PreparationStatus.js";
import { PageIndex } from "./PageIndex.js";
import { ReaderPanel } from "./ReaderPanel.js";
import { Icon } from "../../../../packages/ui/src/Icon.js";
import { openBook, type BookPage, type OpenBook } from "./book.js";
import { PageCache } from "./pages.js";
import { containSelection } from "./selection.js";
import { PDF_NEEDS_NEWER_BROWSER, pdfReaderSupported } from "./support.js";
const PdfReader = lazy(() =>
  import("./PdfPage.js").then((m) => ({ default: m.PdfReader })),
);
export type ReadingSource = {
  title: string;
  format: ReadingFormat;
  blob: Blob | ReadingRanges;
  position: ReadingPosition;
};

export function Reader({
  source,
  onClose,
  preparation,
  onProgress,
}: {
  source: ReadingSource;
  preparation?: ReadingPreparation;
  onClose: () => void;
  onProgress: (position: ReadingPosition) => Promise<void>;
}) {
  const [book, setBook] = useState<OpenBook>();
  const [section, setSection] = useState(source.position.section);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState<BookPage>();
  const [error, setError] = useState(() =>
    source.format === "pdf" && !pdfReaderSupported()
      ? PDF_NEEDS_NEWER_BROWSER
      : "",
  );
  const [ready, setReady] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [rtl, setRtl] = useState(source.format === "cbz");
  const [fontSize, setFontSize] = useState(20);
  const [theme, setTheme] = useState(
    source.format === "epub" ? "paper" : "night",
  );
  const viewport = useRef<HTMLDivElement>(null);
  const [panel, setPanel] = useState<"settings" | "index">();
  const opener = useRef<HTMLButtonElement>(null);
  const openPanel = (
    name: "index" | "settings",
    trigger: HTMLButtonElement,
  ) => {
    opener.current = trigger;
    setPanel(name);
  };
  useEffect(() => {
    if (!panel && opener.current) {
      opener.current.focus({ preventScroll: true });
      opener.current = null;
    }
  }, [panel]);
  // The open book owns the viewport; reading.css hides the site header on
  // this mark (Chromium 79 has no :has() to find the reader by itself).
  useEffect(() => {
    document.body.classList.add("reading-open");
    return () => document.body.classList.remove("reading-open");
  }, []);
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [fit, setFit] = useState("page");
  const position = useRef(source.position);
  const saving = useRef<Promise<boolean> | null>(null);
  const pending = useRef(false);
  const abandon = useRef(false);
  const save = useCallback((): Promise<boolean> => {
    if (saving.current) return saving.current;
    if (!pending.current || abandon.current) return Promise.resolve(true);
    // A slow request only needs the latest position that arrived while it was in flight.
    const flush = async () => {
      while (pending.current && !abandon.current) {
        pending.current = false;
        try {
          await onProgress({ ...position.current });
          setSaveError(false);
        } catch {
          pending.current = true;
          setSaveError(true);
          return false;
        }
      }
      return true;
    };
    saving.current = flush().finally(() => {
      saving.current = null;
    });
    return saving.current;
  }, [onProgress]);
  useEffect(() => {
    viewport.current?.focus();
  }, []);
  useEffect(
    () => (viewport.current ? containSelection(viewport.current) : undefined),
    [],
  );
  useEffect(() => {
    const timer = setInterval(save, 2000);
    const hidden = () => {
      if (document.visibilityState === "hidden") save();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", save);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", save);
      save();
    };
  }, [save]);
  useEffect(() => {
    if (source.format === "pdf") return;
    const controller = new AbortController();
    let opened: OpenBook | undefined;
    void openBook(source.blob, source.format, controller.signal)
      .then(async (value) => {
        if (controller.signal.aborted) {
          await value.close();
          return;
        }
        opened = value;
        setBook(value);
        setCount(value.sections.length);
        setRtl(value.rtl);
        setSection((old) => Math.min(old, value.sections.length - 1));
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : "This book could not be opened.",
          );
      });
    return () => {
      controller.abort();
      if (opened) void opened.close().catch(() => {});
    };
  }, [source]);
  const pages = useMemo(() => (book ? new PageCache(book) : undefined), [book]);
  useEffect(() => () => pages?.dispose(), [pages]);
  useEffect(() => {
    if (!pages) return;
    let alive = true;
    setReady(false);
    setError("");
    setPage(undefined);
    // Keep the pages either side, and the one after next for manga.
    pages.keep([section - 1, section, section + 1, section + 2]);
    void pages
      .get(section)
      .then((value) => {
        if (alive) setPage(value);
      })
      .catch((e: unknown) => {
        if (alive)
          setError(e instanceof Error ? e.message : "Page unavailable.");
      });
    return () => {
      alive = false;
    };
  }, [pages, section]);
  useEffect(() => {
    // Read ahead only once the page in view is showing, so it never waits.
    if (!pages || !ready) return;
    pages.prefetch(section + 1);
    if (source.format === "cbz") pages.prefetch(section + 2);
  }, [pages, ready, section, source.format]);
  useEffect(() => {
    if (page?.html === undefined || !viewport.current) return;
    let current = true;
    // Restore a saved fraction only after illustrations have their final dimensions.
    const images = Array.from(
      viewport.current.querySelectorAll("article img[src]"),
    );
    void Promise.allSettled(
      images.map((img) => (img as HTMLImageElement).decode()),
    ).then(() => {
      if (current) setReady(true);
    });
    return () => {
      current = false;
    };
  }, [page]);
  useEffect(() => {
    if (!ready || !viewport.current) return;
    const element = viewport.current;
    element.scrollTop =
      position.current.fraction *
      Math.max(0, element.scrollHeight - element.clientHeight);
  }, [ready, section]);
  const loaded = useCallback(() => setReady(true), []);
  const failed = useCallback((message: string) => {
    setError(message);
    setReady(false);
  }, []);
  const counted = useCallback((n: number) => {
    setCount(n);
    setSection((old) => Math.min(old, n - 1));
  }, []);
  const turn = useCallback(
    (next: number) => {
      if (!count || next < 0 || next >= count || next === section) return;
      position.current = { section: next, fraction: 0 };
      pending.current = true;
      setSection(next);
      void save();
      setReady(false);
      setError("");
    },
    [count, section, save],
  );
  const unit = source.format === "epub" ? "Chapter" : "Page";
  return (
    <main id="main" className={`reading-reader reading-theme-${theme}`}>
      <header className="reading-topbar">
        <button
          className="reading-back"
          aria-label="Back to reading room shelf"
          onClick={() => {
            void save().then((saved) => {
              if (saved) onClose();
            });
          }}
        >
          <Icon name="arrow-left" /> Shelf
        </button>
        <div className="reading-title">
          <span>
            <b>RAVĀN</b> / {source.format.toUpperCase()}
            {preparation?.state === "preparing" ||
            preparation?.state === "queued"
              ? ` · ${preparation.state === "queued" ? "Queued" : "Preparing"} ${preparation.percent}%`
              : ""}
          </span>
          <h1>{source.title}</h1>
        </div>
        <div className="reading-actions">
          {source.format !== "epub" && (
            <select
              aria-label="Page size"
              value={fit}
              onChange={(e) => setFit(e.target.value)}
            >
              <option value="page">Whole page</option>
              <option value="width">Fit width</option>
            </select>
          )}
          <button
            className="reading-settings-button"
            aria-label="Reading settings"
            aria-haspopup="dialog"
            onClick={(e) => openPanel("settings", e.currentTarget)}
          >
            <Icon name="settings" /> <span>Reading settings</span>
          </button>
        </div>
      </header>
      {panel === "settings" && (
        <ReaderPanel
          title="Reading settings"
          onDismiss={() => setPanel(undefined)}
        >
          <PreparationStatus status={preparation} />
          <div className="reading-tools">
            <label>
              Appearance
              <select value={theme} onChange={(e) => setTheme(e.target.value)}>
                <option value="paper">Paper</option>
                <option value="night">Night</option>
                <option value="sepia">Sepia</option>
              </select>
            </label>
            {source.format === "epub" && (
              <label>
                Text size
                <select
                  value={fontSize}
                  onChange={(e) => setFontSize(Number(e.target.value))}
                >
                  {[16, 18, 20, 24, 28, 32].map((n) => (
                    <option value={n} key={n}>
                      {n} px
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Reading direction
              <select
                value={rtl ? "rtl" : "ltr"}
                onChange={(e) => setRtl(e.target.value === "rtl")}
              >
                <option value="ltr">Left to right</option>
                <option value="rtl">Right to left</option>
              </select>
            </label>
          </div>
        </ReaderPanel>
      )}
      {panel === "index" && (
        <PageIndex
          count={count}
          section={section}
          unit={unit}
          rtl={rtl}
          pdf={pdf}
          book={book}
          onDismiss={() => setPanel(undefined)}
          onSelect={(next) => {
            setPanel(undefined);
            turn(next);
          }}
        />
      )}
      <div
        className="reading-viewport"
        data-fit={source.format === "epub" ? undefined : fit}
        ref={viewport}
        tabIndex={0}
        role="region"
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
            return;
          if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
          event.preventDefault();
          turn(section + ((event.key === "ArrowRight") !== rtl ? 1 : -1));
        }}
        aria-label={`${unit} ${section + 1}`}
        onScroll={() => {
          const element = viewport.current;
          if (!ready || !element) return;
          position.current = {
            section,
            fraction: Math.max(
              0,
              Math.min(
                1,
                element.scrollTop /
                  Math.max(1, element.scrollHeight - element.clientHeight),
              ),
            ),
          };
          pending.current = true;
        }}
      >
        {error ? (
          <div className="reading-message" role="alert">
            <h2>Unable to read this {unit.toLowerCase()}.</h2>
            <p>{error}</p>
          </div>
        ) : (
          <>
            {!ready && (
              <p role="status" className="reading-loading">
                Opening {unit.toLowerCase()}…
              </p>
            )}
            {source.format === "pdf" ? (
              <Suspense fallback={<p role="status">Loading PDF reader…</p>}>
                <PdfReader
                  blob={source.blob}
                  section={section}
                  onDocument={setPdf}
                  onCount={counted}
                  onReady={loaded}
                  onError={failed}
                />
              </Suspense>
            ) : page?.image ? (
              <img
                className="reading-manga"
                // A drag on a page selects nothing; it must not pick the image up.
                draggable={false}
                src={page.image}
                alt={`Page ${section + 1} of ${source.title}`}
                onLoad={loaded}
                onError={() =>
                  failed("This image format could not be decoded.")
                }
              />
            ) : page?.html !== undefined ? (
              <article
                className="reading-prose"
                lang={page.language}
                dir={page.direction ?? "auto"}
                style={{ fontSize }}
                dangerouslySetInnerHTML={{ __html: page.html }}
              />
            ) : null}
          </>
        )}
      </div>
      <footer className="reading-bottom">
        {count > 0 && (
          <progress
            aria-label="Reading progress"
            value={section + 1}
            max={count}
          />
        )}
        <div className="reading-pagination" dir={rtl ? "rtl" : "ltr"}>
          <button
            disabled={section === 0 || !count}
            onClick={() => turn(section - 1)}
          >
            <Icon name={rtl ? "arrow-right" : "arrow-left"} /> Previous
          </button>
          <button
            className="reading-index-trigger"
            dir="ltr"
            aria-haspopup="dialog"
            aria-label={`Browse ${unit.toLowerCase()} index, ${unit.toLowerCase()} ${section + 1} of ${count}`}
            disabled={!count}
            onClick={(e) => openPanel("index", e.currentTarget)}
          >
            <Icon name="index" />
            <span>
              {unit} <strong>{section + 1}</strong> of {count || "…"}
            </span>
          </button>
          <button
            disabled={!count || section >= count - 1}
            onClick={() => turn(section + 1)}
          >
            Next <Icon name={rtl ? "arrow-left" : "arrow-right"} />
          </button>
        </div>
        {saveError && (
          <p role="alert">
            Your place could not be saved. Keep this reader open to retry.
          </p>
        )}
        {saveError && (
          <button
            onClick={() => {
              abandon.current = true;
              onClose();
            }}
          >
            Leave without saving
          </button>
        )}
      </footer>
    </main>
  );
}
