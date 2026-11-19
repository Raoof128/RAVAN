import type { BookPage, OpenBook } from "./book.js";

/**
 * Pages of an open EPUB or CBZ, kept around the reader's place so a turn shows
 * a page already extracted. The cache owns every page it hands out: callers
 * never release one, and a page leaves (aborted if still loading, its object
 * URLs revoked once loaded) only when `keep` drops it or the book closes.
 */
export class PageCache {
  private entries = new Map<
    number,
    { controller: AbortController; promise: Promise<BookPage> }
  >();
  constructor(private readonly book: OpenBook) {}
  get(index: number): Promise<BookPage> {
    let entry = this.entries.get(index);
    if (!entry) {
      const controller = new AbortController();
      const promise = this.book.page(index, controller.signal);
      const created = { controller, promise };
      entry = created;
      this.entries.set(index, created);
      // A failure is not remembered: asking again retries the page.
      promise.catch(() => {
        if (this.entries.get(index) === created) this.entries.delete(index);
      });
    }
    return entry.promise;
  }
  /** Start loading a page nobody is waiting for yet. */
  prefetch(index: number) {
    if (index < 0 || index >= this.book.sections.length) return;
    void this.get(index)
      .then((page) => {
        // Decode ahead too, so the turn does not wait for the image decoder.
        if (!page.image) return;
        const image = new Image();
        image.src = page.image;
        return image.decode();
      })
      .catch(() => {});
  }
  /** Drop every page not listed. */
  keep(indices: Iterable<number>) {
    const wanted = new Set(indices);
    for (const [index, entry] of this.entries) {
      if (wanted.has(index)) continue;
      this.entries.delete(index);
      entry.controller.abort();
      void entry.promise.then(
        (page) => page.release(),
        () => {},
      );
    }
  }
  dispose() {
    this.keep([]);
  }
}
