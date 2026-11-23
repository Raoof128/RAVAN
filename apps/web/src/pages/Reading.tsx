import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, useApi } from "../../../../packages/client/src/api.js";
import {
  MAX_READING_BYTES,
  readingLimit,
  type ReadingFolder,
  type ReadingItem,
  type ReadingList,
  type ReadingPosition,
} from "../../../../packages/contracts/src/reading.js";
import { PreparationStatus } from "../reading/PreparationStatus.js";
import { Reader, type ReadingSource } from "../reading/Reader.js";
import { useTitle } from "../router.js";
import { artworkUrl } from "../../../../packages/ui/src/artwork.js";
import { Icon } from "../../../../packages/ui/src/Icon.js";
import "../reading/reading.css";
/** A book too large to open, with the reason in the reader's words. */
class TooLarge extends Error {}
type Selection = {
  item: ReadingItem;
  source: ReadingSource;
  save: (position: ReadingPosition) => Promise<void>;
};
/**
 * The reading room, browsed by Drive folder as the films are: the top shows
 * the books being read, its folders as cards and its own books; a folder
 * shows the folders in it and its books. From the top a search looks through
 * every book; in a folder, through that folder and the folders inside it.
 */
export function Reading({
  folder,
  readerOnly = false,
}: { folder?: string; readerOnly?: boolean } = {}) {
  const api = useApi();
  const [query, setQuery] = useState("");
  const scope = folder ?? (query ? undefined : "root");
  const [items, setItems] = useState<ReadingItem[]>([]);
  const [place, setPlace] = useState<ReadingList["folder"]>();
  const [folders, setFolders] = useState<ReadingFolder[]>([]);
  const [reading, setReading] = useState<ReadingItem[]>([]);
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
  useTitle(
    selection?.source.title ??
      (folder && place ? place.name : undefined) ??
      "Reading room",
  );
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const mine = ++generation.current;
    setLoading(true);
    setError("");
    setItems([]);
    setNext(null);
    const timer = setTimeout(() => {
      void api
        .reading(query, 0, scope)
        .then((result) => {
          if (mine !== generation.current) return;
          setItems(result.items);
          setNext(result.nextOffset);
          setPlace(result.folder);
          setFolders(result.folders ?? []);
          setReading(result.reading ?? []);
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
  }, [api, query, revision, scope]);
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
            const page = await api.reading(query, Number(offset), scope);
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
  }, [
    api,
    selection,
    query,
    scope,
    pollingOffsets,
    working,
    selectedStatus?.state,
  ]);
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
      if (BigInt(item.sizeBytes) > BigInt(readingLimit(item.format)))
        throw new TooLarge(
          item.format === "pdf"
            ? "This PDF is over 512 MB, the largest RAVAN opens."
            : "EPUB and comic books open up to 100 MB. This one is larger.",
        );
      // A PDF over the whole-book limit is only ever read in pieces.
      const blob =
        item.preparation || BigInt(item.sizeBytes) > BigInt(MAX_READING_BYTES)
          ? api.readingRanges(item, job.signal)
          : await api.readingFile(item, job.signal);
      if (item.preparation && !readerOnly) {
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
          error instanceof TooLarge
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
  const bookCard = (item: ReadingItem, index: number) => (
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
  );
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
      {folder && (
        <a
          className="back-link"
          href={
            place?.parentId && place.parentId !== "root"
              ? `#/reading/folder/${encodeURIComponent(place.parentId)}`
              : "#/reading"
          }
        >
          <Icon name="arrow-left" />
          {place?.parentName
            ? `Back to ${place.parentName}`
            : "Back to the reading room"}
        </a>
      )}
      <header className="reading-intro">
        <div>
          {folder ? (
            <h1 className="reading-folder-title">{place?.name ?? " "}</h1>
          ) : (
            <h1>
              Reading room<span>.</span>
            </h1>
          )}
          <p>
            {folder
              ? "A folder of your connected Google Drive."
              : "Books and manga from your connected Google Drive folder."}
          </p>
        </div>
        <div className="reading-drive">
          {!readerOnly && (
            <a className="button primary" href="#/settings">
              Manage Drive folder
            </a>
          )}
          <small>PDF up to 512 MB · EPUB & CBZ up to 100 MB</small>
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
      {!folder && !query && reading.length > 0 && (
        <section
          className="reading-continue"
          aria-labelledby="reading-continue"
        >
          <h2 id="reading-continue">Continue reading</h2>
          <div className="reading-shelf">
            {reading.map((item, index) => bookCard(item, index))}
          </div>
        </section>
      )}
      <section aria-label="Books from Google Drive">
        <div className="reading-shelf-heading">
          <div>
            <h2>{folder ? "In this folder" : "On your shelf"}</h2>
          </div>
          <div className="reading-search">
            <label htmlFor="reading-search">Search your books</label>
            <input
              id="reading-search"
              type="search"
              placeholder={folder ? "Search this folder" : "Title or filename"}
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
        {loading && !items.length && !folders.length ? (
          <p role="status">Loading your shelf…</p>
        ) : items.length || folders.length ? (
          <div className="reading-shelf" ref={shelf}>
            {!query &&
              folders.map((f, index) => (
                <FolderStack folder={f} index={index} key={`folder-${f.id}`} />
              ))}
            {items.map((item, index) => bookCard(item, index + folders.length))}
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
                : readerOnly
                  ? "Books appear here when the owner adds them to the connected Drive folder and syncs the website."
                  : "Add EPUB, PDF or CBZ files to your connected Drive folder, then sync your library in Your cinema."}
            </p>
            {!query && !readerOnly && (
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
                .reading(query, next, scope)
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

/**
 * A folder of books, drawn as a stack of volumes: the cover of its first book
 * in front, the edges of the rest behind it. It opens to the folder's books.
 */
function FolderStack({
  folder,
  index,
}: {
  folder: ReadingFolder;
  index: number;
}) {
  const source = artworkUrl(folder.coverUrl);
  const [failed, setFailed] = useState<string>();
  const count = `${folder.books} ${folder.books === 1 ? "book" : "books"}`;
  return (
    <a
      className={`reading-book reading-folder reading-cover-${index % 4}`}
      href={`#/reading/folder/${encodeURIComponent(folder.id)}`}
      aria-label={`Open the folder ${folder.name}, ${count}`}
    >
      <span className="reading-stack" aria-hidden="true">
        <span className="reading-stack-edge" />
        <span className="reading-stack-edge" />
        {source && failed !== source ? (
          <span className="reading-cover reading-cover-picture">
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
        ) : (
          <span className="reading-cover">
            <span className="reading-format">Folder</span>
            <strong>{folder.name}</strong>
            <span className="reading-cover-rule" />
          </span>
        )}
      </span>
      <span className="reading-book-caption">
        <strong>{folder.name}</strong>
        <small>{count}</small>
      </span>
    </a>
  );
}
