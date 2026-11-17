export type ReadingFormat = "epub" | "pdf" | "cbz";
export const MAX_READING_BYTES = 100 * 1024 * 1024;
export type ReadingPosition = { section: number; fraction: number };
export type ReadingItem = {
  id: string;
  title: string;
  name: string;
  format: ReadingFormat;
  generation: string;
  sizeBytes: string;
  position: ReadingPosition;
};
export function readingFormat(name: string): ReadingFormat | undefined {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "epub" || extension === "pdf" || extension === "cbz")
    return extension;
}
