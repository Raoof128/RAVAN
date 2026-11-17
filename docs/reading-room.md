# Reading room

RAVĀN's browser client reads DRM-free EPUB books, PDFs and CBZ manga exclusively from the connected Google Drive folder. This feature is implemented locally; it has not been deployed or checked against the owner's live Drive collection.

## Use it

Run the API and web client as described in the README. Sign in, then choose **Reading room** in the navigation.

- **Google Drive:** put EPUB, PDF or CBZ files anywhere below the existing connected library folder. Sync in **Your cinema**. Search the shelf by title or filename and open a book. Reading positions are saved on the server and available when opening the same book on another browser. Simultaneous readers use the last saved position.
- Use **Next**, **Previous**, or the chapter/page selector. Arrow keys work while focus is in the reading area; right-to-left mode reverses their direction and the page controls. CBZ starts in right-to-left mode.
- EPUB text size is adjustable. Paper, night and sepia change the reading surface; PDF and manga artwork keep their original colors.

The development preview at `http://127.0.0.1:5173/?preview=1#/reading` shows an empty reading shelf. Reading requires an authenticated Drive connection; the preview never accesses the production API.

## Scope and limits

- Maximum input: 100 MiB. ZIP archives: 5,000 entries, 32 MiB per extracted entry and 512 MiB declared total. EPUB chapters: 4 MiB markup, 40 MiB of raster images, at most 100 images per chapter. Extraction also checks actual output, rather than trusting declared sizes.
- EPUB uses the publication's spine order and saves chapter plus scroll fraction. It preserves basic text structure, tables and local raster images, while removing publisher CSS, scripts, forms, hyperlinks, external resources and SVG. Fixed layouts, interactive content, footnote links and publisher pagination are not preserved. EPUBs with encrypted resources, including obfuscated fonts, are rejected. Custom/external XML document declarations are unsupported.
- CBZ supports PNG, JPEG, WebP, GIF and AVIF pages in natural filename order. Image decoding depends on the browser. CBR/RAR, MOBI/AZW and DRM are not supported.
- PDFs use PDF.js with a local worker, fonts, character maps and image decoders. The interface renders pages and exposes extracted text to assistive technology. It does not execute document JavaScript or interactive forms. Password-protected documents are rejected; scanned pages without text have no built-in OCR.
- Files download before opening. Reading does not use FFmpeg or the video preparation queue. Drive downloads recheck source membership and generation and stream in bounded blocks; at most two downloads run at once. There is no new server disk cache.
- Reading is available in the authenticated browser client. The experimental television client has no reader interface.

The new database migration preserves film data and requests a fresh library scan so previously skipped books can be discovered. Replaced book bytes reset progress; a rename alone preserves it when Drive supplies a stable checksum or revision. All reading positions are stored on the server; there is no device-file import or browser-local reading history.

## Implementation references

The implementation choices were checked on 17 November 2026 against primary documentation: [PDF.js browser examples](https://mozilla.github.io/pdf.js/examples/), [zip.js streaming extraction options](https://gildas-lormeau.github.io/zip.js/api/interfaces/EntryGetDataOptions.html), and [DOMPurify's sanitizer configuration](https://github.com/cure53/DOMPurify). Versions are pinned in the package lock. EPUB chapters use a restricted DOMPurify allowlist and only reader-created image URLs; untrusted book markup is never served as an HTML document by the API.

## Verify

```sh
npm run check
npm test
npm run build
npm run build:web
npx playwright test tests/e2e/reading.spec.ts
```

The reader tests cover private routes, CSRF, source replacement and moves, sanitization, archive-local resource paths, server-saved resume, right-to-left navigation, PDF rendering and the Drive browser workflow with fixtures. Live Drive files and physical mobile devices require separate verification.
