import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../../../../packages/client/src/api.js";
import {
  MAX_READING_BYTES,
  type ReadingItem,
  type ReadingPosition,
} from "../../../../packages/contracts/src/reading.js";
import { Reader, type ReadingSource } from "../reading/Reader.js";
import { useTitle } from "../router.js";
import "../reading/reading.css";
type Selection = {
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
  const close = useCallback(() => {
    setSelection(undefined);
    setRevision((n) => n + 1);
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
      const blob = await api.readingFile(item, job.signal);
      if (job.signal.aborted) return;
      setSelection({
        source: {
          title: item.title,
          format: item.format,
          blob,
          position: item.position,
        },
        save: (position) => api.saveReading(item, position),
      });
    } catch (error) {
      if (!job.signal.aborted)
        setError(
          error instanceof Error &&
            error.message === "Choose a book up to 100 MB."
            ? error.message
            : "This book could not be downloaded. Refresh the library and try again.",
        );
    } finally {
      if (!job.signal.aborted) setOpening("");
    }
  };
  if (selection)
    return (
      <Reader
        source={selection.source}
        onClose={close}
        onProgress={selection.save}
      />
    );
  return (
    <main id="main" className="reading-room">
      <header className="reading-intro">
        <div>
          <p className="eyebrow">A QUIETER KIND OF STORY</p>
          <h1>
            Reading room<span>.</span>
          </h1>
          <p>Your books, your manga, a little time to yourself.</p>
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
            <p>Books and manga from your connected Drive folder.</p>
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
          <div className="reading-shelf">
            {items.map((item, index) => (
              <button
                className={`reading-book reading-cover-${index % 4}`}
                key={item.id}
                disabled={Boolean(opening)}
                onClick={() => void openDrive(item)}
              >
                <span className="reading-cover">
                  <span className="reading-format">
                    {item.format.toUpperCase()}
                  </span>
                  <strong>{item.title}</strong>
                  <span className="reading-cover-rule" />
                  <span className="reading-cover-bottom">
                    RAVĀN / READING ROOM
                  </span>
                </span>
                <span className="reading-book-caption">
                  <strong>{item.title}</strong>
                  <small>
                    {item.position.section || item.position.fraction
                      ? `Continue · ${item.format === "epub" ? "Chapter" : "Page"} ${item.position.section + 1}`
                      : item.format === "cbz"
                        ? "Open manga"
                        : "Start reading"}
                  </small>
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
