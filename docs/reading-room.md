# Reading room

RAVĀN's browser client reads DRM-free EPUB books, PDFs and CBZ manga exclusively from the connected Google Drive folder.

## Use it

Run the API and web client as described in the README. Sign in, then choose **Reading room** in the navigation.

- **Google Drive:** put EPUB, PDF or CBZ files anywhere below the existing connected library folder. Sync in **Your cinema**. Search the shelf by title or filename and open a book. Reading positions are saved on the server and available when opening the same book on another browser. Simultaneous readers use the last saved position.
- Use **Next** or **Previous** to turn. Select the page counter to browse six pages at a time or type a page number. PDF and CBZ previews appear on demand. Closing the index keeps your place. Arrow keys work while focus is in the reading area; right-to-left mode reverses their direction and the page controls. CBZ starts in right-to-left mode.
- PDFs and manga open in **Whole page**, which fits the complete page in the space between the title and navigation controls. Choose **Fit width** to enlarge the artwork and scroll through a page.
- Open **Reading settings** for appearance, direction, and EPUB text size. Close the panel with its close button or Escape. Paper, night and sepia change the reading surface; PDF and manga artwork keep their original colors.

The development preview at `http://127.0.0.1:5173/?preview=1#/reading` shows an empty reading shelf. Reading requires an authenticated Drive connection; the preview never accesses the production API.

## Scope and limits

- Maximum input: 100 MiB. ZIP archives: 5,000 entries, 32 MiB per extracted entry and 512 MiB declared total. EPUB chapters: 4 MiB markup, 40 MiB of raster images, at most 100 distinct images per chapter (an image used twice is extracted once). Extraction also checks actual output, rather than trusting declared sizes.
- EPUB uses the publication's spine order and saves chapter plus scroll fraction. It preserves basic text structure, tables and local raster images, while removing publisher CSS, scripts, forms, hyperlinks, external resources and SVG. Fixed layouts, interactive content, footnote links and publisher pagination are not preserved. EPUBs with encrypted resources, including obfuscated fonts, are rejected. Custom/external XML document declarations are unsupported.
- CBZ supports PNG, JPEG, WebP, GIF and AVIF pages in natural filename order. Image decoding depends on the browser. CBR/RAR, MOBI/AZW and DRM are not supported.
- PDFs use PDF.js with a local worker, fonts, character maps and image decoders. The interface renders pages and exposes extracted text to assistive technology. It does not execute document JavaScript or interactive forms. Password-protected documents are rejected; scanned pages without text have no built-in OCR.
- Reading is available in the authenticated browser client. The experimental television client has no reader interface.

Migration 9 added the reading catalogue and requested a fresh library scan, so previously skipped books are discovered; film data is preserved. Migration 10 adds an index for the shelf's preparation figures. Replaced book bytes reset progress; a rename alone preserves it when Drive supplies a stable checksum or revision. All reading positions are stored on the server; there is no device-file import or browser-local reading history.

## Preparation

- After a sync, the backend worker prepares one book at a time in its own job queue lane, three 4 MiB blocks at a time. Idle preparation uses up to 512 MiB of the shared source cache. A restarted worker resumes from the blocks already stored.
- The shelf and reading settings show preparation status. The percentage is the share of the book's bytes currently stored for this Drive generation. Cache eviction can lower it, and opening the book fetches the missing blocks again.
- Book blocks use the same storage budget, disk reserve and eviction rules as films. A fully prepared book reopens from this cache.
- The page and scroll bookmark are saved separately from preparation.

## How it stays fast

- **Opening.** The reader does not wait for the worker. Opening a book has the API fetch that book's missing blocks four at a time, both ends of the file first, because PDF and ZIP readers start at the end. Opening a third book cancels the oldest such warming.
- **Drive downloads.** Each book block is fetched as four parallel 1 MiB requests. A single Drive connection from the production host gave about 1 MiB/s, so a block in one request took about four seconds. At most 24 book downloads run at once: the reader's own requests first, then the warming of an opened book, then the worker. Each download costs 200 Drive quota units of 325,000 per user per minute. A rate-limited request waits as Google recommends (1 second, doubling, up to 32 seconds, five attempts), and the other downloads pause with it.
- **Drive checks.** Every byte request checks live Drive access and the requested generation. As for films, Drive's answer may be reused for five seconds, but never after bytes were just read from Drive. A change to the file or revoked access therefore takes effect within five seconds.
- **In the browser.** Up to four 1 MiB ranges and four PDF slice batches are in flight at once. A whole archive entry is requested before it is inflated. PDFs request the end of the file, where the cross-reference table usually sits, together with the start.
- **Turning pages.** The next page (two for manga) or chapter is extracted and decoded while the current one is read, and the next PDF page is rendered off screen. A turn shows a finished page.
- **Measured.** In a local benchmark of a cold 38.6 MiB, 223-page PDF with Drive at 1 MiB/s per connection, the first page took 3.2 seconds (26 seconds before these changes). A stored book reopened in about 0.3 seconds, and page turns took 30 to 50 ms. How much a first page needs depends on how the publisher arranged the file.

## Implementation references

The implementation was checked on 19 November 2026 against current primary documentation:

- [PDF.js API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html) and [range transport](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFDataRangeTransport.html), against the installed 6.5.438 types and source. Pages render with the `canvas` parameter; a page the reader drops is released with `page.cleanup()`. No document JavaScript, XFA or eval is used; version 6.5 is past the 2026 scripting advisory (CVE-2026-16633).
- [zip.js range reader](https://gildas-lormeau.github.io/zip.js/api/classes/Reader.html) and [extraction options](https://gildas-lormeau.github.io/zip.js/api/interfaces/EntryGetDataOptions.html). Reads past the end are truncated, CRC32 checks use `checkCrc32`, and at most four entries of a chapter are extracted at once.
- [DOMPurify](https://github.com/cure53/DOMPurify), 3.4.18. Chapters use a restricted allowlist and only reader-created image URLs. `lang`, `dir`, `colspan` and `rowspan` are marked URI-safe, because a custom URI pattern otherwise removes them. Untrusted book markup is never served as an HTML document by the API.
- Google Drive [usage limits](https://developers.google.com/workspace/drive/api/guides/limits), [error handling](https://developers.google.com/workspace/drive/api/guides/handle-errors) and [downloads](https://developers.google.com/workspace/drive/api/guides/manage-downloads). Rate limits are recognised in both of Google's error shapes (`usageLimits` and `RESOURCE_EXHAUSTED`) and are never read as a removed file.

Versions are pinned in the package lock.

## Verify

```sh
npm run check
npm test
npm run build
npm run build:web
npx vitest run tests/backend/end-to-end.test.ts
npx playwright test tests/e2e/reading.spec.ts
```

The reader tests cover private routes, CSRF, source replacement and moves, sanitization, archive-local resource paths, server-saved resume, right-to-left navigation, PDF rendering and the Drive browser workflow with fixtures. Live Drive files and physical mobile devices require separate verification.
