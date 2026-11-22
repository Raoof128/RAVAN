export type ReadingFormat = "epub" | "pdf" | "cbz";
/**
 * The largest book held whole: an EPUB or CBZ, which the reader opens as one
 * archive, and any book prepared or warmed whole in the server's cache.
 */
export const MAX_READING_BYTES = 100 * 1024 * 1024;
/**
 * The largest PDF. PDF.js reads a PDF in pieces, page by page, and a PDF over
 * MAX_READING_BYTES is only ever read that way: never warmed or prepared
 * whole, so a 347 MB manga volume costs the cache only the pages read.
 */
export const MAX_PDF_READING_BYTES = 512 * 1024 * 1024;
/** How large a book of this format may be to open. */
export function readingLimit(format: ReadingFormat) {
  return format === "pdf" ? MAX_PDF_READING_BYTES : MAX_READING_BYTES;
}
/**
 * The largest book a shelf cover is made for. A cover reads at most 48 MiB
 * of a book (the worker's COVER_READ_BYTES), whatever its size, so this only
 * bounds what is believed: Drive's own limit for a file is far above it.
 * Books over the reading limit still get covers.
 */
export const MAX_COVER_BOOK_BYTES = 4 * 1024 * 1024 * 1024;
export type ReadingPosition = { section: number; fraction: number };
export type ReadingPreparation = {
  state: "on-demand" | "queued" | "preparing" | "ready" | "failed";
  percent: number;
};
export type ReadingItem = {
  id: string;
  title: string;
  name: string;
  format: ReadingFormat;
  generation: string;
  sizeBytes: string;
  position: ReadingPosition;
  preparation?: ReadingPreparation;
  /** The book's cover, made by the server from the book. */
  coverUrl?: string;
};
/** A Drive folder of books, shown as one card that opens to them. */
export type ReadingFolder = {
  id: string;
  name: string;
  /** Books in the folder and the folders inside it. */
  books: number;
  /** The cover of its first book that has one. */
  coverUrl?: string;
};
/** One page of the reading room, or of a folder in it. */
export type ReadingList = {
  items: ReadingItem[];
  nextOffset: number | null;
  /** Set when a folder is browsed. The top is "root". */
  folder?: {
    id: string;
    name: string;
    /** "root" for a folder at the top, null at the top itself. */
    parentId: string | null;
    parentName?: string;
  };
  /** The folders inside it, with the first page. */
  folders?: ReadingFolder[];
  /** Books being read anywhere, with the top's first page. */
  reading?: ReadingItem[];
};
export function readingFormat(
  name: string,
  mimeType: string,
): ReadingFormat | undefined {
  // Workspace documents require an export. Only binary Drive files have reader bytes.
  if (mimeType.startsWith("application/vnd.google-apps.")) return;
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "application/epub+zip") return "epub";
  if (
    mimeType === "application/vnd.comicbook+zip" ||
    mimeType === "application/x-cbz"
  )
    return "cbz";
  if (mimeType.startsWith("video/")) return;
  const extension = /\.(epub|pdf|cbz)$/i.exec(name)?.[1]?.toLowerCase();
  if (extension === "epub" || extension === "pdf" || extension === "cbz")
    return extension;
}

// PDF.js can request hundreds of small page dictionaries at once for a scan.
// Bundle these fixed-size slices in request order to avoid one HTTP trip per page.
export const PDF_SLICE_BYTES = 16 * 1024;
export const MAX_PDF_SLICES = 64;
