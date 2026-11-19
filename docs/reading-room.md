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
- After sync, the existing backend worker prepares one book at a time in its own job queue lane. Idle preparation uses up to 512 MiB of the shared source cache. Opening a book prioritizes its job and starts interactive reads immediately. EPUB and CBZ fetch archive entries as needed. PDFs can batch small reads for their page directory. The amount needed for a first page depends on how the publisher arranged the file.
- The shelf and reading settings show preparation status. Its percentage is the share of source bytes currently cached for this Drive generation. Verified blocks survive worker restarts. Cache eviction can lower that percentage, and opening the book requests the missing blocks again. The page and scroll bookmark are saved separately.
- Each byte request checks live Drive access and the requested generation. As for films, Drive's answer may be reused for five seconds, never after bytes were just read from Drive, so a change or revoked access takes effect within five seconds. The worker warms three blocks at a time. Opening a book also has the API fetch that book's missing blocks, four at a time, starting with both ends of the file; opening a third book cancels the oldest such warming. Each 4 MiB book block is downloaded from Drive as four parallel requests, because a single Drive connection from the production host gave about 1 MiB/s. The browser fetches up to four 1 MiB ranges and four PDF slice batches at once, asks for a whole archive entry before inflating it, and loads the next page (two for manga) or chapter while the current one is read. For PDFs it renders the next page in advance and requests the end of the file, where the cross-reference table usually sits, together with the start.
- Source blocks use the same storage budget, disk reserve and eviction rules as video. Reopening a fully prepared book reads its bytes from this cache while still checking Drive access.
- Reading is available in the authenticated browser client. The experimental television client has no reader interface.

The new database migration preserves film data and requests a fresh library scan so previously skipped books can be discovered. Replaced book bytes reset progress; a rename alone preserves it when Drive supplies a stable checksum or revision. All reading positions are stored on the server; there is no device-file import or browser-local reading history.

## Implementation references

The implementation choices were checked on 17 November 2026 against primary documentation: [PDF.js browser examples](https://mozilla.github.io/pdf.js/examples/), [zip.js streaming extraction options](https://gildas-lormeau.github.io/zip.js/api/interfaces/EntryGetDataOptions.html), and [DOMPurify's sanitizer configuration](https://github.com/cure53/DOMPurify). Versions are pinned in the package lock. EPUB chapters use a restricted DOMPurify allowlist and only reader-created image URLs; untrusted book markup is never served as an HTML document by the API.

The worker-backed reader uses [PDF.js range transport](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFDataRangeTransport.html) for PDF page requests and a [zip.js range reader](https://gildas-lormeau.github.io/zip.js/api/classes/Reader.html) for EPUB and CBZ entries.

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
