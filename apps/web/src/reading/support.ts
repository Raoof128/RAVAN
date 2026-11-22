/**
 * PDF.js 6.5 calls `Promise.withResolvers` (Chromium 119), `Promise.try`
 * (Chromium 128) and `URL.parse` (Chromium 126) unguarded, and its worker file
 * is served as published. A browser without them, such as an LG C1's
 * Chromium 79, cannot open a PDF at all; say so instead of failing part way.
 */
export function pdfReaderSupported() {
  const promise = Promise as unknown as Record<string, unknown>;
  const url = URL as unknown as Record<string, unknown>;
  return (
    typeof promise.withResolvers === "function" &&
    typeof promise.try === "function" &&
    typeof url.parse === "function"
  );
}

export const PDF_NEEDS_NEWER_BROWSER =
  "PDF books need a newer browser than this one. Open this book on a phone or computer. EPUB and comic books open here.";
