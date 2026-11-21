import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, useApi } from "../../../../packages/client/src/api.js";
import {
  MAX_READING_BYTES,
  type ReadingItem,
  type ReadingPosition,
} from "../../../../packages/contracts/src/reading.js";
import { PreparationStatus } from "../reading/PreparationStatus.js";
import { Reader, type ReadingSource } from "../reading/Reader.js";
import { useTitle } from "../router.js";
import { artworkUrl } from "../../../../packages/ui/src/artwork.js";
import "../reading/reading.css";
type Selection = {
  item: ReadingItem;
  source: ReadingSource;
  save: (position: ReadingPosition) => Promise<void>;
};
export function Reading() {
  const api = useApi();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ReadingItem[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState("");
  const [selection, setSelection] = useState<Selection>();
  const [revision, setRevision] = useState(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const openedId = useRef("");
  const shelf = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selection || !openedId.current) return;
    const card = shelf.current?.querySelector<HTMLButtonElement>(
      `[data-book-id="${CSS.escape(openedId.current)}"]`,
    );
    card?.focus();
    openedId.current = "";
  }, [selection]);
  const generation = useRef(0);
  useTitle(selection?.source.title ?? "Reading room");
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const mine = ++generation.current;
    setLoading(true);
    setError("");
    setItems([]);
    setNext(null);
    const timer = setTimeout(() => {
      void api
        .reading(query)
        .then((result) => {
          if (mine !== generation.current) return;
          setItems(result.items);
          setNext(result.nextOffset);
        })
        .catch(() => {
          if (mine === generation.current)
            setError("Your Drive books could not be loaded. Try refreshing.");
        })
        .finally(() => {
          if (mine === generation.current) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [api, query, revision]);
  const hasWork = (item: ReadingItem) =>
    item.preparation?.state === "preparing" ||
    item.preparation?.state === "queued";
  const working = items.some(hasWork);
  // The planner may pick an untouched title after the shelf was opened.
  const pollingOffsets = [
    ...new Set(
      items.flatMap((item, i) => {
        const state = item.preparation?.state;
        return hasWork(item) ||
          (!working &&
            state === "on-demand" &&
            Number(item.sizeBytes) <= MAX_READING_BYTES)
          ? [Math.floor(i / 60) * 60]
          : [];
      }),
    ),
  ].join(",");
  const selectedStatus =
    selection &&
    items.find(
      (row) =>
        row.id === selection.item.id &&
        row.generation === selection.item.generation,
    )?.preparation;
  useEffect(() => {
    if (!pollingOffsets && !selection?.item.preparation) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (selection?.item.preparation) {
          const status = await api.readingPreparation(selection.item);
          if (stopped) return;
          setItems((rows) =>
            rows.map((row) =>
              row.id === selection.item.id &&
              row.generation === selection.item.generation
                ? { ...row, preparation: status }
                : row,
            ),
          );
          if (status.state !== "queued" && status.state !== "preparing") return;
        } else {
          for (const offset of pollingOffsets.split(",")) {
            const page = await api.reading(query, Number(offset));
            if (stopped) return;
            const refreshed = new Map(page.items.map((row) => [row.id, row]));
            setItems((rows) =>
              rows.map((row) => {
                const current = refreshed.get(row.id);
                return current?.generation === row.generation
                  ? { ...row, preparation: current.preparation }
                  : row;
              }),
            );
          }
        }
      } catch {
        /* A temporary network failure leaves the last measured value visible. */
      }
      if (!stopped)
        timer = setTimeout(poll, selection || working ? 2500 : 15000);
    };
    timer = setTimeout(poll, selection || working ? 1000 : 15000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, selection, query, pollingOffsets, working, selectedStatus?.state]);
  const close = useCallback(() => {
    controller.current?.abort();
    setSelection(undefined);
  }, []);
  const begin = () => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setError("");
    return next;
  };
  const openDrive = async (item: ReadingItem) => {
    const job = begin();
    setOpening(item.title);
    try {
      if (BigInt(item.sizeBytes) > BigInt(MAX_READING_BYTES))
        throw new Error("Choose a book up to 100 MB.");
      const blob = item.preparation
        ? api.readingRanges(item, job.signal)
        : await api.readingFile(item, job.signal);
      if (item.preparation) {
        // Opening a page does not wait for job admission or for the worker.
        void api
          .readingPreparation(item, true)
          .then((status) => {
            if (!job.signal.aborted)
              setItems((rows) =>
                rows.map((row) =>
                  row.id === item.id && row.generation === item.generation
                    ? { ...row, preparation: status }
                    : row,
                ),
              );
          })
          .catch(() => {
            /* The byte route independently verifies the current Drive generation. */
          });
      }
      if (job.signal.aborted) return;
      openedId.current = item.id;
      setSelection({
        item,
        source: {
          title: item.title,
          format: item.format,
          blob,
          position: item.position,
        },
        save: async (position) => {
          await api.saveReading(item, position);
          setItems((rows) =>
            rows.map((row) =>
              row.id === item.id && row.generation === item.generation
                ? { ...row, position }
                : row,
            ),
          );
        },
      });
    } catch (error) {
      if (!job.signal.aborted)
        setError(
          error instanceof Error &&
            error.message === "Choose a book up to 100 MB."
            ? error.message
            : error instanceof ApiError && [409, 410].includes(error.status)
              ? "This file changed or moved. Sync your Drive folder in Your cinema, then refresh the shelf."
              : error instanceof ApiError && error.status === 429
                ? "Other downloads are in progress. Try again shortly."
                : "This book could not be downloaded. Check your connection and try again.",
        );
    } finally {
      if (!job.signal.aborted) setOpening("");
    }
  };
  if (selection)
    return (
      <Reader
        source={selection.source}
        preparation={selectedStatus}
        onClose={close}
        onProgress={selection.save}
      />
    );
  return (
    <main id="main" className="reading-room">
      <header className="reading-intro">
        <div>
          <h1>
            Reading room<span>.</span>
          </h1>
          <p>Books and manga from your connected Google Drive folder.</p>
        </div>
        <div className="reading-drive">
          <a className="button primary" href="#/settings">
            Manage Drive folder
          </a>
          <small>EPUB, PDF & CBZ · Up to 100 MB</small>
        </div>
      </header>
      {opening && (
        <div className="reading-status" role="status">
          <span>Opening {opening}…</span>
          <button
            onClick={() => {
              controller.current?.abort();
              setOpening("");
            }}
          >
            Cancel
          </button>
        </div>
      )}
      {error && (
        <p className="reading-error" role="alert">
          {error}
        </p>
      )}
      <section aria-label="Books from Google Drive">
        <div className="reading-shelf-heading">
          <div>
            <h2>On your shelf</h2>
          </div>
          <div className="reading-search">
            <label htmlFor="reading-search">Search your books</label>
            <input
              id="reading-search"
              type="search"
              placeholder="Title or filename"
              maxLength={200}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              disabled={loading}
              onClick={() => setRevision((n) => n + 1)}
            >
              Refresh
            </button>
          </div>
        </div>
        {loading && !items.length ? (
          <p role="status">Loading your shelf…</p>
        ) : items.length ? (
          <div className="reading-shelf" ref={shelf}>
            {items.map((item, index) => (
              <button
                className={`reading-book reading-cover-${index % 4}`}
                data-book-id={item.id}
                key={item.id}
                disabled={Boolean(opening)}
                onClick={() => void openDrive(item)}
              >
                <BookCover item={item} />
                <span className="reading-book-caption">
                  <strong>{item.title}</strong>
                  <small>
                    <span className="reading-accessible-text">
                      {item.format.toUpperCase()} ·{" "}
                    </span>
                    {item.position.section || item.position.fraction
                      ? `Continue · ${item.format === "epub" ? "Chapter" : "Page"} ${item.position.section + 1}`
                      : item.format === "cbz"
                        ? "Open manga"
                        : "Start reading"}
                  </small>
                  <PreparationStatus status={item.preparation} />
                </span>
              </button>
            ))}
          </div>
        ) : !error ? (
          <div className="reading-empty">
            <div className="reading-empty-mark" aria-hidden="true">
              <span />
              <span />
            </div>
            <h3>
              {query ? "No matching titles." : "Make room for your next story."}
            </h3>
            <p>
              {query
                ? "Try another title or filename."
                : "Add EPUB, PDF or CBZ files to your connected Drive folder, then sync your library in Your cinema."}
            </p>
            {!query && (
              <a className="button" href="#/settings">
                Open library settings
              </a>
            )}
          </div>
        ) : null}
        {next !== null && (
          <button
            disabled={loading}
            onClick={() => {
              const mine = generation.current;
              setError("");
              setLoading(true);
              void api
                .reading(query, next)
                .then((result) => {
                  if (mine === generation.current) {
                    setItems((old) => [...old, ...result.items]);
                    setNext(result.nextOffset);
                  }
                })
                .catch(() => {
                  if (mine === generation.current)
                    setError("More books could not be loaded. Try again.");
                })
                .finally(() => {
                  if (mine === generation.current) setLoading(false);
                });
            }}
          >
            Load more books
          </button>
        )}
      </section>
    </main>
  );
}

/** The book's own cover when the server has made one, else a drawn one. */
function BookCover({ item }: { item: ReadingItem }) {
  const source = artworkUrl(item.coverUrl);
  const [failed, setFailed] = useState<string>();
  if (source && failed !== source)
    return (
      <span className="reading-cover reading-cover-picture" aria-hidden="true">
        <img
          src={source}
          width={480}
          height={720}
          decoding="async"
          alt=""
          loading="lazy"
          onError={() => setFailed(source)}
        />
      </span>
    );
  return (
    <span className="reading-cover" aria-hidden="true">
      <span className="reading-format">{item.format.toUpperCase()}</span>
      <strong>{item.title}</strong>
      <span className="reading-cover-rule" />
    </span>
  );
}
