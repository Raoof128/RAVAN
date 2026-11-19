export type ReadingFormat = "epub" | "pdf" | "cbz";
export const MAX_READING_BYTES = 100 * 1024 * 1024;
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
