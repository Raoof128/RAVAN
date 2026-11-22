# Changelog

## Raouf: 2026-11-22 (Australia/Sydney) · cover reads release

**Scope:** release `98762ef4a832` and publish, approved by the owner.

- Live: backend `98762ef4a832-74b72b75` (schema 11). Web client and Worker unchanged. Record: the maintainer's private notes.
- Rehearsal made the cover of the largest failed production PDF (50.9 MB) in 1.6 seconds from 0.45 MB of reads. After activation all 13 PDF books have covers; the 9 new jobs completed on their first attempt; zero worker restarts.
- Verification: 9 of 9 edge checks, Sentinel host checks, clean journal, no rollback.

## Raouf: 2026-11-22 (Australia/Sydney) · book covers stopped after four of thirteen

**Scope:** the owner reported that only a few covers had been made. Branch `audit/backend-2026-11-16`. Not released.

- **Found on production (read-only):** 4 of 13 PDF books had covers; 9 cover jobs had failed three times and were never queued again. `ravan-worker` had crashed 12 times with `Error: Worker was terminated` from PDF.js. A timed replay in the worker's sandbox showed the cause: PDF.js asked the API for 64 KiB just before the file's tail, and the API never answered.
- **Bug, API (`apps/api/src/media/raw-route.ts`):** when a response's source finished, its `finally` aborted the response controller, whose listener destroys the body. A last chunk that filled the body's 64 KiB buffer was still unwritten, so the response stopped after its headers and never ended. PDF.js reads in 64 KiB pieces, so nearly every cover read past the first hung for the worker's 120 second limit. Any range response could hit it. The controller is now aborted only when the response did not finish.
- **Bug, worker (`apps/worker/src/book-cover.ts`):** PDF.js 6.5 throws into a promise nobody handles when a document is destroyed while it loads (`pdfManagerReady` in `pdf.worker.mjs`). Node ends the process for that, so a failed or cancelled read during loading ended the whole worker service, with any film encode it was running, and charged the cover job an attempt. The PDF page is now drawn in its own thread; reads are asked of the worker, which keeps the 48 MiB limit and passes each read's own error to the job (a busy API returns the job to the queue). The thread is ended when the cover is made, fails or is cancelled.
- **Covers asked for again:** `BOOK_COVER_VERSION` is 2, so every book without a cover gets a new job; books with covers keep them.
- **Tests:** `tests/backend/raw-route.test.ts` (new): range responses through the real block cache, including exactly 64 KiB fresh and cached; it times out on the old route. `tests/backend/book-covers.test.ts`: a read that fails while a PDF loads, and a job cancelled mid-load, each end the cover with their own error and no unhandled rejection; both hung on the old code.
- Verification: see the AGENT.md entry.

### Files changed

`apps/api/src/media/raw-route.ts`, `apps/worker/src/book-cover.ts`, `apps/worker/src/main.ts`, `tests/backend/raw-route.test.ts` (new), `tests/backend/book-covers.test.ts`, `CHANGELOG.md`, `AGENT.md`.

## Raouf: 2026-11-21 (Australia/Sydney) · book covers release

**Scope:** release `98e7ee592a7b`, then the scan fix `7bd893135c64`, and publish, approved by the owner.

- Live: backend `7bd893135c64-09f29870` (schema 11), Cloudflare Worker version `6a997e30-2dd1-4727-8330-b96810b08a00`. Record: the maintainer's private notes.
- Verification: rehearsal in the worker's sandbox on a copy of the live database, covers made by the staged code, 12 release tests, 9 of 9 edge checks twice, Sentinel host checks, clean journal, no rollback.
- Production covers take two to four minutes each for the 13 PDF books; not yet explained.
- Published: sanitized snapshot of private `bcf099e` as public `50c572d` on `public/book-covers-2026-11-21`; secret scan clean.

## Raouf: 2026-11-21 (Australia/Sydney) · book covers on the shelf, selectable PDF text, manga pages stay put

**Scope:** the owner asked to fix the two findings of the drag audit and to give books thumbnails like the films' pictures, made on the server, checked against current documentation. Branch `audit/backend-2026-11-16`. Not released.

- **Book covers:** a new worker job (`book-cover`, pictures lane) makes each book's cover from the book: an EPUB's cover image (EPUB 3 `cover-image`, EPUB 2 cover meta, an image named "cover", or the picture on the first page), a CBZ's first page in reading order, or a PDF's first page drawn by PDF.js in Node with `@napi-rs/canvas`. It reads only those parts, at most 48 MiB, through the API's verified cache at the new key-only route `/_worker/book/:id/:generation`. FFmpeg makes a 480 × 720 JPEG (`posterFromImage`). Migration 11 adds `reading_covers`, one row per book and generation, including "no cover". `/api/reading` lists `coverUrl`, served by `/api/artwork/:id`. The hourly sweep keeps cover files, a restore clears their records, and covers of departed books are forgotten. The shelf shows the cover and falls back to the drawn one if there is none or it fails to load.
- **PDF text:** pages carry PDF.js 6.5's `TextLayer` over the canvas, sized with `--total-scale-factor` as the canvas is shown, with the selection guard of PDF.js's own viewer (`endOfContent`, `selecting`; the end is moved only outside Firefox and Chromium 148+, as PDF.js does). Words can be selected and copied, and the highlight sits on the drawn words. The hidden text copy is kept only for pages with no text.
- **Manga:** pages are `draggable="false"`, so a drag no longer picks up the picture.
- **Security, found by review after the first release:** the EPUB package was scanned with a pattern that backtracked; a malformed 1.2 MB package with many `<item` openings and no `>` took 74 seconds and would have held the worker. Tags are now found by a linear scan from each `<` to the next `>`, at most 20,000 tags of at most 16 KiB. A test fails on the old scan and passes in well under two seconds. Production had no EPUB books waiting for covers when the first release went out.
- **Documentation checked:** PDF.js 6.5.438 source and types (`TextLayer`, `TextLayerBuilder`, `NodeCanvasFactory`, `canvasFactory`); `isEvalSupported` no longer exists and was not used. `TextLayerBuilder` is not imported: it needs a `globalThis.pdfjsLib` and the whole viewer module.
- **Tests:** `tests/backend/book-covers.test.ts` (10, including the malformed package): each EPUB cover rule with decoys, path escapes refused, CBZ order, a large PDF read in ranges, the read limit, replacing and refusing covers, the sweep, and a real worker job against a live API (key-only route, `coverUrl`, owner-only picture, made once). Browser: PDF words selected and copied, manga drag, shelf covers at desktop and phone widths with fallbacks. Each new test was seen failing without its change.
- Verification: `npm run check` clean. `npm test`: 60 files, 374 passed, 1 skipped. `npm run build` (migration 11 ships) and `npm run build:web` pass; the built cover code makes a PDF cover under plain Node. All 198 browser tests pass in three engines.
- Release note: the server needs `@napi-rs/canvas-linux-x64-gnu` in `node_modules`. It is already in the lock file as an optional dependency of `pdfjs-dist`; without it PDF books keep the drawn cover and the job fails cleanly.

### Files changed

`apps/worker/src/book-cover.ts` (new), `apps/worker/src/artwork.ts`, `apps/worker/src/main.ts`, `apps/worker/src/leases.ts`, `apps/api/src/app.ts`, `apps/api/src/library/reading.ts`, `apps/api/src/library/routes.ts`, `packages/contracts/src/reading.ts`, `packages/db/migrations/011_reading_covers.sql` (new), `packages/db/src/migrate.ts`, `packages/db/src/backup.ts`, `apps/web/src/pages/Reading.tsx`, `apps/web/src/reading/PdfPage.tsx`, `apps/web/src/reading/Reader.tsx`, `apps/web/src/reading/reading.css`; `tests/backend/book-covers.test.ts` (new), `tests/e2e/reading.spec.ts`; `docs/reading-room.md`, the maintainer's private notes, `docs/2026-source-register.md`, `CHANGELOG.md`, `AGENT.md`.

## Raouf: 2026-11-21 (Australia/Sydney) · reader text selection no longer jumps while dragging

**Scope:** the owner reported that dragging the mouse over text in the reader made it glitch. Branch `audit/backend-2026-11-16`. Not released.

- **Bug, reader:** the chapter scrolls inside `.reading-viewport`, and the top bar and footer sit outside it. When a mouse drag crossed onto either bar, Chromium, Firefox and WebKit all moved the selection end to the end of the chapter or into the bar's text ("Chapter 1 of 2", "Shelf"). The highlight jumped from a few lines to the whole chapter and back as the pointer crossed the edge, while the page auto-scrolled at full speed. A probe measured the selection going from 381 to 10,767 characters in one step.
- **Fix:** `apps/web/src/reading/selection.ts` (`containSelection`, started by `Reader.tsx`). While a mouse drag that began on the page is outside it, the selection end is moved once a frame, before paint, to the line under the nearest point inside the page. The start read on the first frame is kept. The browser's own drag scrolling still runs, and the selection follows it line by line. Touch selection and scroll bar presses are left alone.
- Tried first and rejected: `user-select: none` on the bars only hid their text, and the jump to the end of the chapter remained in every engine. `pointer-events: none` on the bars fixed Firefox only.
- **Test:** `tests/e2e/reading.spec.ts` "keeps a text selection on the page when the pointer is dragged past it". It drags over the footer, then over the top bar, then back onto the page. It fails in all three engines without the fix.
- Seen during the audit: manga pages could be dragged as images, and PDF pages had no selectable text. Both are fixed in the entry above.
- Verification: `npm run check` clean. `npm test`: 59 files, 364 passed, 1 skipped. The new test passed 15 of 15 serially and 12 of 12 in parallel across three engines. Reader, UX and loading browser suites pass. Two Firefox loading tests failed only when three suites ran at once on a loaded machine, and pass alone with or without this change.

### Files changed

`apps/web/src/reading/selection.ts` (new), `apps/web/src/reading/Reader.tsx`, `tests/e2e/reading.spec.ts`, `CHANGELOG.md`, `AGENT.md`.

## Raouf: 2026-11-19 (Australia/Sydney) · reading documentation audit release

**Scope:** release `92019068e456` and publish it, approved by the owner.

- Live: backend `92019068e456-84496e2c` (schema 10), Cloudflare Worker version `eafcdd9d-e2f8-4b74-9f03-e92c417d7448`. Record: the maintainer's private notes.
- Verification: rehearsal on a copy of the live database; 12 release tests; 9 of 9 edge checks; Sentinel host checks; clean journal; no rollback.
- No book has been downloaded on production since the parallel-parts release, so that gain is still unmeasured there.
- Published: sanitized snapshot of private `b614d9c` as public `de19838` on `public/fast-reader-2026-11-19`; secret scan clean.

## Raouf: 2026-11-19 (Australia/Sydney) · reading room checked against current documentation

**Scope:** the owner asked for the reading room to be checked against current 2026 documentation, audited, polished and improved. Branch `audit/backend-2026-11-16`. Not released.

- **Bug, EPUB:** DOMPurify removed `lang`, `dir`, `colspan` and `rowspan`. A custom `ALLOWED_URI_REGEXP` is applied to every attribute outside DOMPurify's URI-safe list. Right-to-left runs and table cell spans were lost. They are now marked URI-safe, with a regression test.
- **Drive rate limits:** they used to be retried three times within about 1.3 seconds. They now follow Google's backoff (1 second, doubling, up to 32 seconds, five attempts), and one limited download pauses the others. Server errors keep the short retry, so film playback recovers quickly. Metadata requests follow the same rule. Google's newer `RESOURCE_EXHAUSTED` error shape is read as a limit, so it can never be mistaken for a removed file.
- **Drive quota:** a download costs 200 units of 325,000 per user per minute. Book downloads are capped at 24 in flight, in priority order: the open reader, then the warming of a book just opened, then the worker. The local benchmark keeps its 3.2 second first page at this cap; at 16 it was 4.2 seconds.
- **PDF.js:** dropped pages are released with `page.cleanup()`, and their canvases are emptied. Previews release their pages. A range answer that arrives after PDF.js stopped waiting no longer fails the whole document.
- **zip.js:** a read past the end is truncated instead of failing. `checkCrc32` replaces the deprecated `checkSignature`. A chapter's images are extracted four at a time.
- **Docs:** `docs/reading-room.md` has new Preparation and "How it stays fast" sections and refreshed references. `docs/2026-source-register.md` lists the reading-room sources checked today.
- Not adopted: PDF.js worker rendering (`rendererSrc`, new in 6.5) and `enableHWA`. Page turns already take 30 to 50 ms, and both are untested in WebKit and Firefox. zip.js `checkOverlappingEntry` is also left off until real EPUBs are tested with it. Resource keys are not needed for the owner's own files.
- Verification: `npm run check` clean; 59 files, 364 passed, 1 skipped; `npm run build` and `npm run build:web` pass; reader browser suite 30 passed in three engines.

### Files changed

`apps/api/src/media/source-stream.ts`, `apps/api/src/media/cache.ts`, `apps/api/src/drive/client.ts`, `apps/api/src/library/reading.ts`, `apps/api/src/app.ts`, `apps/web/src/reading/book.ts`, `apps/web/src/reading/archive.ts`, `apps/web/src/reading/PdfPage.tsx`, `apps/web/src/reading/PageIndex.tsx`; `tests/backend/reading-speed.test.ts`, `tests/backend/second-audit.test.ts`, `tests/backend/sync.test.ts`, `tests/clients/reading-security.test.ts`; `docs/reading-room.md`, `docs/2026-source-register.md`, `CHANGELOG.md`, `AGENT.md`.

## Raouf: 2026-11-19 (Australia/Sydney) · public snapshot

**Scope:** push, approved by the owner with the parallel book downloads release.

- A sanitized snapshot of private `7e3be95` is on the public repository as branch `public/fast-reader-2026-11-19`, commit `9cd19a8`, on top of `public/google-drive-reader-2026-11-17` (`ee9202c`). It has 245 files; 78 private records are excluded, and the private branch was not pushed.
- Before the push, the secret scan found nothing. One rule in `AGENT.md` named a file outside the repository; it now describes the timing harness without its path.
- The documentation audit that followed (`63f4d30`) is not in this snapshot.

## Raouf: 2026-11-19 (Australia/Sydney) · parallel book downloads release

**Scope:** release `ff6678f01250`, approved by the owner.

- Live: backend `ff6678f01250-e3f57cff` (schema 10), Cloudflare Worker version `17e64b55-4166-4cad-8ec6-c3c34156dc37`. Record: the maintainer's private notes.
- Verification: rehearsal on a copy of the live database; 12 release tests; 9 of 9 edge checks; Sentinel host checks; clean journal; no rollback.

## Raouf: 2026-11-19 (Australia/Sydney) · reading room, second speed pass

**Scope:** the owner asked for more speed after the fast reader release. Branch `audit/backend-2026-11-16`. Not released.

- Production block timings showed each Drive download connection giving about 1 MiB/s: a 4 MiB block took about four seconds, even the first one of a book. Book blocks are now downloaded as four parallel 1 MiB requests (films are unchanged). Any part that fails fails the block, which keeps its fresh check after the read.
- Opening a book has the API fetch its missing blocks, four at a time, both ends first, so PDF.js's one-at-a-time lookups join downloads already in flight. A full cache or a Drive refusal stops it quietly; at most two books warm at once.
- A PDF slice request reads its spans in different blocks side by side, and the browser keeps four slice batches in flight instead of two.
- Tried and removed: serving small reads of cold blocks straight from Drive. It made five times the Drive calls and the first page slower (4.5 s against 3.2 s).
- Local benchmark, 38.6 MiB 223-page PDF, cold, no worker. At 1 MiB/s per Drive connection (production's observed rate) the first page went from 26.2 s on the live release to 3.2 s. At 25 MB/s it went from 3.2 s to 1.2 s. Reopening a stored book takes about 0.3 s, and page turns 30 to 50 ms.
- Verification: `npm run check` clean; 59 files, 361 passed, 1 skipped; `npm run build` and `npm run build:web` pass; reader browser suite 30 passed in Chromium, Firefox and WebKit.

### Files changed

`apps/api/src/library/reading.ts`, `apps/api/src/library/reading-slices.ts`, `apps/api/src/media/source-stream.ts`, `apps/api/src/app.ts`, `packages/client/src/pdf-slices.ts`; `tests/backend/reading-speed.test.ts`, `tests/clients/reading-speed.test.ts`; `docs/reading-room.md`, `CHANGELOG.md`, `AGENT.md`.

## Raouf: 2026-11-19 (Australia/Sydney) · fast reader release

**Scope:** release `3653ae1075d7`, approved by the owner.

- Live: backend `3653ae1075d7-35f5e79f` (schema 10), Cloudflare Worker version `a918a3ca-2bb5-495b-a85a-94790d617742`. Record: the maintainer's private notes.
- Verification: rehearsal on a copy of the live database (counts preserved, schema 10, a book job planned); 12 release tests; 9 of 9 edge checks; Sentinel host checks; no rollback. The worker prepared three books from Drive within two minutes, 13 to 15 seconds each.
- Local benchmark on a 223-page PDF with simulated Drive latency: first page 4.0 s to 3.2 s, Drive metadata calls 62 to 22; page turns 30 to 50 ms.

## Raouf: 2026-11-19 (Australia/Sydney) · Reading room audit and speed

**Scope:** the owner asked for a full audit of the reading room, improvements, and maximum speed. Branch `audit/backend-2026-11-16`, on top of the uncommitted worker-backed reading work above. Not committed, released or pushed.

- Book byte requests now reuse a Drive check for five seconds, as films already did. Each range used to make three full checks (book, folder and the walk up to the library folder), so a cold block cost about twice the lookups it needs and a warm repeat still went to Drive. A fresh check after every Drive read is unchanged. A change or revoked access now takes effect within five seconds instead of on the next request.
- The worker warms three book blocks at a time instead of one. The first block to fail cancels the others, and the job resumes from the cache rows as before.
- The browser fetches the blocks of a long read together (up to four requests, below the API's eight), keeps 12 blocks instead of 6, and asks for a whole archive entry before inflating it instead of one block per inflate step. EPUB chapter images are extracted together, and an image used twice is extracted once.
- CBZ and EPUB keep the pages around the reader's place. The next page (two for manga) is extracted and decoded while the current one is read, so a turn shows a finished page. PDFs draw the next page off screen in the same way and ask for the end of the file together with the start.
- Verification: `npm run check` clean; 59 files, 357 passed, 1 skipped; `npm run build` and `npm run build:web` pass; `tests/e2e/reading.spec.ts` 30 passed across Chromium, Firefox and WebKit. The two new Drive-check tests fail on the previous code. No real Drive or device measurements were taken.

### Files changed

`apps/api/src/drive/sync.ts`, `apps/api/src/app.ts`, `apps/worker/src/reading.ts`, `apps/worker/src/main.ts`, `packages/client/src/reading-ranges.ts`, `packages/client/src/pdf-slices.ts`, `apps/web/src/reading/archive.ts`, `apps/web/src/reading/book.ts`, `apps/web/src/reading/pages.ts` (new), `apps/web/src/reading/Reader.tsx`, `apps/web/src/reading/PdfPage.tsx`; `tests/backend/reading-speed.test.ts` (new), `tests/clients/reading-speed.test.ts` (new), `tests/backend/reading.test.ts`, `tests/backend/end-to-end.test.ts`; `docs/reading-room.md`, `CHANGELOG.md`, `AGENT.md`.

## 18 November 2026 · Worker-backed reading

- Drive sync makes books eligible for background preparation. The worker uses a dedicated queue lane and stores verified blocks in the existing bounded source cache. Opening a title raises its priority. A restarted worker reads its checkpoints from SQLite and skips blocks already present.
- The shelf and reader show measured preparation progress. Page turns save immediately, and scroll position is flushed when the reader leaves. Preparation and bookmarks follow separate records keyed to the Drive content generation.
- PDFs fetch page data and small batches of directory entries. EPUB and CBZ fetch the archive ranges needed for the current chapter or page. A prepared book can reopen from server storage while Drive access is still checked.

- Verification covered a worker restart at 55% preparation, bookmark recovery, range delivery, and cache eviction boundaries. The full browser suite passed 186 tests and the release suite passed 12. The unit and integration suite passed 350 tests with one conditional skip.

## 18 November 2026 · Reader layout and page navigation

- Whole page fits an entire PDF or manga page between the title and navigation. Fit width enlarges the artwork for scrolling. Opening settings preserves the page dimensions.
- The page counter opens an index with six previews at a time for PDF and CBZ, a chapter list for EPUB and a direct jump by number. Browsing the index preserves the bookmark until a page is chosen. Closing either panel returns keyboard focus to its opener.
- All 183 end-to-end tests passed in Chromium, Firefox and WebKit. All 12 release tests passed. The unit and integration suite finished with 348 passes and one conditional skip. A 223-page PDF was checked locally at 1440, 390 and 320 pixels, including the wide cover, portrait artwork, final page and saved position.

## Raouf: 2026-11-17 (Australia/Sydney) · Google Drive reading room

**Scope:** the owner requested a book and manga reader, selected Google Drive only, then authorized commit, publication and redeployment.

- EPUB, PDF and CBZ files are discovered below the connected Drive folder and shown in a separate searchable reading room. The browser supports chapter/page navigation, saved server positions, text sizing, appearance choices and right-to-left manga navigation. There is no device-file import or local reading history.
- Migration 9 adds the reading catalogue and requests a fresh scan. Downloads require authentication and live source checks, are capped at 100 MiB, and do not enter the video worker queue. EPUB content is sanitized and archive extraction is bounded. PDF assets are bundled locally.
- Mobile navigation makes room for the reader. The existing worker-yield test now waits for the first source read instead of assuming FFmpeg starts within 400 ms.
- Verification: type checks and builds pass; 348 unit/integration tests pass with one conditional HDR skip; the final Drive-only reader suite passes 15 tests across Chromium, Firefox and WebKit. The broader browser pass had 166 passes and two WebKit video timing failures; all five WebKit track tests passed on focused rerun. Production-shaped rendering and desktop/mobile interactions were checked with fixture data, with no console errors.
- Released application `96ff90bb4a16` with migration 9, API, worker and frontend together. Nine edge checks, anonymous reader access denials, 252 asset checksums and three host checks pass. Record: the maintainer's private notes. Format limitations are in the reader usage guide.

## Raouf: 2026-11-17 (Australia/Sydney) · web title release

**Scope:** commit `9fe667d593e1`, approved by the owner. Web client only.

- Live: Cloudflare Worker version `3991d07d-25de-448b-9785-7e9fa05d728d`. The backend stays at `e72a31ab2fc8-02085f79`: no API, worker or schema change since then, so the server was not touched. Record: the maintainer's private notes.
- Verification: 12 release tests on a local Worker; live title `RAVAN. Every Story Flows.` with no em dash in the page or its scripts; 9 of 9 edge checks.

## Raouf: 2026-11-17 (Australia/Sydney) · no em dashes

**Scope:** the owner asked for a stop-slop pass over the repository and the live site, with no em dashes. Branch `audit/backend-2026-11-16`. Released the same day (above).

- The browser title is `RAVAN. Every Story Flows.`, matching the page description, and a page adds its own name as `Pluto · RAVAN`. The empty TV pairing code shows `· · · ·`.
- Every em dash in tracked text is gone: changelog headings use `·`, plan tasks use `B1:`, release records use `, 16 November 2026`. En dashes in number ranges stay.
- A scan for stock phrases (delve, robust, seamless, moreover and similar) found none in the docs or on screen. The on-screen taglines stay as the owner wrote them.
- Verification: `npm run check` clean; Playwright `artwork`, `folders` and `loading` specs 69 passed.

### Files changed

`apps/web/index.html`, `apps/web/src/router.tsx`, `apps/tv/src/main.tsx`; `tests/e2e/artwork.spec.ts`, `folders.spec.ts`, `loading.spec.ts`, `tests/release/frontend.spec.ts`; `CHANGELOG.md`, `docs/implementation-status.md`, `docs/visual-design.md`, `docs/superpowers/plans/2026-11-15-0{1,2,3}-*.md`, `docs/testing/*-2026-11-1{5,6}.md`.

## Raouf: 2026-11-16 (Australia/Sydney) · folders release

**Scope:** release `e72a31ab2fc8`, approved by the owner.

- Live: backend `e72a31ab2fc8-02085f79` (schema 8), Cloudflare Worker version `4f94bda8-f4ac-4e75-bc9b-2ab66d307ff2`. Record: the maintainer's private notes.
- The first scheduled check after the switch scanned Drive in full and recorded the folders.
- Verification: rehearsal on a copy of the live database; 9 of 9 edge checks; 12 release tests; Sentinel host checks; no rollback; no failed requests in the journal.

## Raouf: 2026-11-16 (Australia/Sydney) · browse the library by folder

**Scope:** the owner asked for a folder such as a series ("Pluto") to show as one folder they can open, instead of every file at once. Branch `audit/backend-2026-11-16`. Released the same day (above).

- The top of the library shows each folder of the Drive folder as one card ("Folder", with its film count and the first film's poster), followed by the films filed directly at the top. A card opens `#/folder/<id>`, which shows that folder's own folders and films by title, with a way back to the folder above it. Back from a film returns to its folder.
- A search from the top still looks through every folder. A search inside a folder looks only in that folder. The watchlist is unchanged.
- Films in progress anywhere, including inside a folder, still lead the top of the library.
- A scan records each folder's name and parent (migration `008_folders.sql`, table `library_folders`). Until a scan has recorded them, the library is listed as before. The first scheduled check after upgrading does a full scan, so the folders appear without waiting for the hourly scan.
- API: `GET /api/movies?folder=root|<id>` returns `folder`, `folders` and, at the top, `resume`, with films ordered by title and a checked cursor. Without `folder` it behaves as before, so the television is unchanged and still lists every film.
- Verification: `npm run check` clean; `npm test` 341 passed, 1 skipped; Playwright 156 passed (Chromium, WebKit, TV); screenshots of the top and of a folder checked by eye.

### Files changed

`packages/db/migrations/008_folders.sql` (new), `packages/db/src/migrate.ts`; `apps/api/src/drive/sync.ts`, `apps/api/src/library/routes.ts`; `packages/contracts/src/index.ts`, `packages/client/src/api.ts`; `packages/ui/src/MovieCard.tsx`, `Icon.tsx`, `tokens.css`; `apps/web/src/pages/Library.tsx`, `Detail.tsx`, `main.tsx`, `libraryCache.ts`, `preview.ts`. Tests: `tests/backend/folders.test.ts`, `tests/e2e/folders.spec.ts` (new). Documentation: `docs/backend-usage.md`, `AGENT.md`, `README.md`; release record the maintainer's private notes, the maintainer's private notes.

## Raouf: 2026-11-16 (Australia/Sydney) · red-team release

**Scope:** release `b0dab6b8d873`, approved by the owner.

- Live: backend `b0dab6b8d873-c4619299`, Cloudflare Worker version `53ad7734-be82-476c-ba81-7483f5cf00f3`, and one rule added to the origin's Nginx. Record: the maintainer's private notes.
- The crafted addresses that reached the API past the origin key now give `404` on the live origin, and the API refuses them itself when they come through the public site.
- Verification: rehearsal on a copy of the live database; 9 of 9 edge checks; 12 release tests; sign-in page in Chromium and WebKit; Sentinel host checks; no rollback.
- Published: the sanitized snapshot of `e38b0be` is on the public repository's branch as `6f4deda` (213 files; the reports and release records stay private; secret scan clean).
- Follow-ups: sign in on production (the sign-in path changed); rebuild the television package; clear old rollback material.

## Raouf: 2026-11-16 (Australia/Sydney) · red-team exercise

**Scope:** the owner asked for the whole project to be attacked. Branch `audit/backend-2026-11-16`, from the released `905086c`. Report: the maintainer's private notes.

### Result

Nobody without the owner's sign-in reached a film, a title or any private data, and no attack ran script in the owner's browser. Eleven attacks worked in lesser ways; ten are fixed here, each with a test that failed first. Nothing is released.

### What worked, and the fix

- **Origin key walked round (confirmed on the live origin).** `/api/movies/..%2f..%2fmedia%2fx/pictures` entered the proxy's open media rule and reached the API and the worker's private routes. The API's own checks held. The API now answers only plainly written paths, and the proxy template passes on only `/media/s/<ticket>/<file>` as written.
- **Sign-in knocked out by strangers.** A hundred anonymous requests from ten networks pushed any sign-in in progress out of a table of one hundred. An attempt is now sealed into its own browser's cookie; there is no table.
- **A paired screen could queue 65 conversions a minute**, each at viewer priority. A screen may now have three waiting.
- **A 750 KB cover image cost FFmpeg about 1 GB**, enough to get the worker killed mid-conversion. Covers are held to 40 megapixels, and frames are scaled down before the filter that holds 24 of them.
- **FFmpeg ran with the service's secrets in its environment.** It now gets a path, a temporary directory and a locale.
- **"Disconnect this TV" left the credential valid on the server.** A screen can now revoke itself (`POST /api/pairing/forget`), and the television does.
- **A caption track of thousands of overlapping cues froze the player.** Such a track is left out of the edition.
- **A link ending in a stray `%` blanked the web app.** The id in the address is read without throwing.
- **The public demo called the real API** for methods its stand-in did not cover. It now refuses them without touching the network.
- `.gitignore` covers backups, key stores and stray media; the site's policy gains `form-action 'self'`.

### Open

- One finding, about how paired screens are approved and kept, needs a product decision, a migration and changes to both clients. Several lower ones are left open with their reasons. All are in section 5 of the report.

### Files changed

`apps/api/src/app.ts`, `auth/routes.ts`, `media/planner.ts`, `sessions/playback.ts`, `sessions/routes.ts`; `apps/worker/src/artwork.ts`, `browser-prepare.ts`, `process.ts`; `apps/web/src/main.tsx`, `router.tsx`, `preview.ts`; `apps/tv/src/main.tsx`; `packages/client/src/api.ts`; `deploy/nginx/ravan-origin.conf.template`; `scripts/build-cloudflare.mjs`; `.gitignore`. Tests: `tests/backend/red-team.test.ts`, `tests/clients/route-params.test.ts`, `tests/clients/preview-api.test.ts` (new); `tests/backend/oauth-capacity.test.ts` (its second test asserted the eviction that was the sign-in attack, and now asserts that an attempt cannot be pushed out); `tests/release/frontend.spec.ts`. Documentation: the maintainer's private notes (new), the maintainer's private notes, `README.md`, `AGENT.md`.

### Verification

- `npm run check`: passed. `npm test`: 53 files, 337 passed, 1 skipped (was 50 files, 326). `npm run build`, `build:web`, `build:tv`, `build:cloudflare`: passed. `npm run test:e2e`: 153 passed (an earlier run, made while the reviewers were also driving browsers, had one Firefox playback timeout). Release tests: 12 passed.
- Each attack was run against the code as it was and worked; each test failed before its fix.
- On the live site: about sixty harmless unauthenticated requests, which is how the origin-key finding was confirmed. No sign-in or pairing attempt, and nothing that could lock out or load the server.

## Raouf: 2026-11-16 (Australia/Sydney) · second-audit release

**Scope:** release `89ed78bc12ad`, approved by the owner.

- Live: backend `89ed78bc12ad-7de5ef21`, Cloudflare Worker version `2ccce3c7-df8e-402c-93ce-29840d957315`. Record: the maintainer's private notes.
- The rehearsal on a copy of the live database showed the defect had been hit that morning: a failed start on a two-language film led to a forced re-encode, and making room for it removed the 4K film's copy. With the staged code, all three two-language films gave a session and every playlist and segment checked was served.
- Verification: 9 of 9 edge checks; 12 release tests; sign-in page in Chromium and WebKit; Sentinel host checks; all five films inspected again under probe version 4; no rollback.
- Follow-ups: play a two-language film signed in; the 4K film is prepared again when next played; clear old rollback material; the public repository has not received this revision.

## Raouf: 2026-11-16 (Australia/Sydney) · second backend audit

**Scope:** the owner asked for a full audit of the backend, with fixes and improvements. Branch `audit/backend-2026-11-16`, from `b6067e7`. Report: the maintainer's private notes.

### The main finding

- **Films with more than one audio track could not be played in the web player.** The worker wrote all-languages editions and the planner offered them, but the media route admitted only the one-language layout's file names: `index.m3u8` was served, then `video.m3u8` answered `403`. In every release since `712c59b`. Each side's tests passed alone. Both gates now use the one list, `HLS_FILE`.

### Also fixed

- One failed or slow Drive lookup when a session's access was renewed stopped the film. Renewal now starts at half-time and is tried again on later heartbeats; a heartbeat waits eight seconds for Drive, not thirty; a verdict that the film is gone still ends the session at once.
- A Drive usage limit, which arrives as `403`, was read as "gone": it could end playback, charge a conversion an attempt and close the library until the next scan. It is now retried and reported as a rate limit.
- The saved audio language was matched by exact code on the server and by language in the players. With `en` saved, a film tagged `eng` was planned in its first language. One shared rule, `sameLanguage`.
- A film whose sound runs on after its picture was converted in full, refused at the final check and tried twice more. The probe records the picture's own length (`PROBE_VERSION` 4) and editions are measured against it.
- Stopping the API waited on anyone watching until systemd killed it. It now closes connections and then the database, in order.
- A fault inside the server left no trace. A 5xx answer writes its method, route pattern and error class; never the address, a header, a message or data.
- A screen's credential that was approved but never collected is revoked after its one-minute window.
- Smaller: tickets of lapsed sessions are forgotten; `/api/artwork-credits` is counted by the rate limiter; pressing sync during the schedule's change check is no longer dropped.

### Files changed

`apps/api/src/app.ts`, `drive/client.ts`, `drive/sync.ts`, `library/import.ts`, `media/planner.ts`, `media/source-stream.ts`, `sessions/pairing.ts`, `sessions/playback.ts`, `sessions/routes.ts`; `apps/worker/src/browser-prepare.ts`, `prepared-store.ts`, `probe.ts`; `packages/contracts/src/languages.ts` (new); `apps/web/src/player/languages.ts` (now takes `sameLanguage` from the shared package). Tests: `tests/backend/second-audit.test.ts` and `tests/backend/end-to-end.test.ts` (new); `capabilities.test.ts`, `prepared-sessions.test.ts` and `worker-yield.test.ts` use `PROBE_VERSION` where they wrote `3`. Documentation: the maintainer's private notes (new), the maintainer's private notes, `docs/backend-usage.md`, `README.md`, `AGENT.md`.

### Verification

- `npm run check`: passed. `npm test`: 50 files, 326 passed, 1 skipped (was 48 files, 309). `npm run build`, `build:web`, `build:tv`, `fixtures`: passed. `npm run test:e2e`: 153 passed. `npm audit`: 0 vulnerabilities.
- Every new test failed before its fix. The new end-to-end test runs the real API, worker and FFmpeg and fetches a two-language film as a player does.
- Two independent reviews: one of the diff, one looking for more places where the API and the worker disagree. Five of the fixes above came from them.

### Not done

- Nothing is committed, released or changed on the server. The main finding is in the release that is live; releasing needs the owner's approval. After release: remove queued forced re-encodes of multi-language films from the job queue, and play a two-language film signed in.
- Left open, with reasons, in section 6 of the report: the web player asks for a full re-encode after any failed start (R-20); the packaged television app may be unable to load media because of its `null` origin (R-26, needs a physical television); no continuous integration (R-25).

## Raouf: 2026-11-16 (Australia/Sydney) · logs and long-term memory

**Scope:** the owner asked for every log and Zurvan to be brought up to date.

- the maintainer's private notes now explains how editions are shared between pictures, how room is made, what the Picture list reports, and how long preparation takes on the production server.
- Zurvan: the five release records of 15–16 November and the operations guide are ingested; five evidence-backed claims, a release decision and a decision on shared editions are recorded under `mov`; the earlier open question on eviction is marked answered.
- No code changed.

## Raouf: 2026-11-16 (Australia/Sydney) · same-copy and room release

**Scope:** release `e49e0c964e69`, approved by the owner.

- Live: backend `e49e0c964e69-9f306da6`, Cloudflare Worker version `a019a0f0-5726-4782-8798-8092e3ca8c80`. Record: the maintainer's private notes.
- Rehearsed on a copy of the live database: 2160p, Original and Auto on the 4K film all play its one existing copy; the Picture list's figures match each film's state.
- Verification: 9 of 9 edge checks; the new route refuses visitors who are not signed in; 12 release tests; sign-in page in Chromium and WebKit; Sentinel host checks; no rollback.

## Raouf: 2026-11-16 (Australia/Sydney) · no copy made twice; room checked before films are removed

**Scope:** the owner asked for the two follow-ups from the panel release, and for faster preparation. Same branch.

### What the live server showed

- Copies were quick: a film repackaged with every language took 95 to 117 seconds; the 4K film's 15 GB copy took about 5 minutes. The server was otherwise idle.
- The "2160p" choice on the 4K film was not an encode. That film is already 2160p, so it made a second copy identical to the one that was ready, and removed every other prepared film to make room for it. The three removed films then had to be prepared again.

### What changed

- **The same edition is never made twice.** When two pictures would give the same result (on a 4K film, Auto, Original and 2160p all keep the original picture), a copy made under either name plays at once, and a copy being made is joined instead of started again. Identities are unchanged, so every existing copy still counts.
- **Room is checked before anything is removed.** The worker first works out whether removing finished copies could make enough room; if not, it stops without removing any.
- **The Picture list says what a choice would do,** from the server's own disk figures: "ready to play", "removes 2 prepared films", or unavailable, "no room while other films play". The note under the list explains how room is made. Owner-only `GET /api/movies/:id/pictures`.
- The worker and the server share one estimate of the room an edition needs (`editionBytes`, `roomPlan` in `apps/worker/src/prepared-store.ts`).

### Files changed

`apps/worker/src/prepared-store.ts`, `apps/worker/src/main.ts`, `apps/api/src/media/planner.ts`, `apps/api/src/sessions/routes.ts`, `packages/contracts/src/index.ts`, `packages/client/src/api.ts`, `apps/web/src/pages/Player.tsx`. Tests: `tests/backend/picture-costs.test.ts` (new); additions to `tests/backend/streaming-playback.test.ts`, `tests/backend/prepared-sessions.test.ts` and `tests/e2e/tracks.spec.ts`.

### Verification

- `npm run check`: passed. `npm test`: 48 files, 309 passed, 1 skipped. `npx playwright test`: 153 passed in Chromium, Firefox and WebKit.

### Speed: where the time goes

- Copies (most films) take one to two minutes and run in the background before anyone presses play. Duplicate work was the real waste, and it is removed.
- A true encode (a smaller picture, or a format no browser plays) is limited by the server's two shared CPUs; the encoder already uses its fastest measured setting. Making those faster needs a larger server; nothing in the code would.

## Raouf: 2026-11-15 (Australia/Sydney) · panel release

**Scope:** release the Audio & subtitles panel and background all-languages editions, approved by the owner.

- Live: backend `75c9f12bd716-e9092872`, Cloudflare Worker version `7e63af83-7e39-4f88-beb6-5f223c05c86b`. Record: the maintainer's private notes.
- Found while rehearsing, under the previous release: a 2160p encode of the 4K film made the worker evict every other prepared film, because the room it frees before an encode is the estimate, nearly the whole 20 GB volume for 4K. Activation waited for that encode to finish. The three two-language films are being prepared again, now with every language.
- Verification: rehearsal on a copy of the live database; 9 of 9 edge checks; 12 release tests; sign-in page in Chromium and WebKit; Sentinel host checks; the first all-languages edition finished after the switch.
- Follow-ups: check the room that can be freed before evicting; say in the Picture list that a 4K encode replaces other prepared films; signed-in check on production; clear old rollback material.

## Raouf: 2026-11-15 (Australia/Sydney) · Audio & subtitles panel

**Scope:** the owner asked for the language picker to be audited and made to look like the rest of the site. Same branch.

### Audit of the picker it replaces

- Three browser-drawn menus (Quality, Audio, Subtitles), each drawn differently by Chrome, Firefox and Safari, and unlike anything else on the site.
- The 4K film's subtitles were one menu of about forty entries, many shown as bare codes ("bul", "cze") and four as the same word ("English").
- A one-language film showed a disabled menu, which read as locked.
- Choosing a picture quality prepares the film again; nothing said so.
- The menus did not come along into the browser's full screen.

### What replaces it

- One **Audio & subtitles** button showing what is playing ("English · English 1 subtitles"), which opens a panel of three short lists: Audio, Subtitles and Picture. The current choice in each carries the copper line used for a paused film. Notes under a list say what applies: the only language in this film; subtitles available after preparation; picture subtitles from a Blu-ray or DVD cannot be shown; a different picture is prepared again and never larger than the original.
- Language codes become names (Czech, Bulgarian); repeated names are numbered; channel layouts sit beside the name in quieter type.
- Lists are radio groups: arrow keys within a list, Tab between lists, a choice applies at once and shows at once, Escape or a click outside closes and returns focus to the button. Each row is a full-width 44 px target.
- In full screen the panel opens downward from the menus at the top; on a phone it is a sheet from the bottom of the screen with the page dimmed behind it.

### Files changed

`apps/web/src/player/TrackPanel.tsx` (new), `apps/web/src/player/languages.ts`, `apps/web/src/pages/Player.tsx`, `apps/web/src/cinema.css`. Tests: `tests/clients/track-panel.test.tsx` (new); `tests/e2e/tracks.spec.ts`, `playback.spec.ts` and `loading.spec.ts` now drive the panel, with the same checks and two added (Escape returns focus; a one-language copy says that choosing another language prepares the film again).

### Verification

- `npm run check`: passed. `npm test`: 47 files, 304 passed, 1 skipped. `npm run test:e2e`: 150 passed in Chromium, Firefox and WebKit, under a load average between 35 and 50. In an earlier run under a load average of 108, two tests timed out; both passed 18 of 18 when repeated.

## Raouf: 2026-11-15 (Australia/Sydney) · every language ready before it is needed

**Scope:** the owner reported the audio option was locked. Same branch.

### What was wrong

- Two of the films opened have one language, and the menu showed it disabled, which read as locked.
- The film with English and Japanese had been prepared before all-languages editions existed, so it carried English only. Choosing Japanese prepared the film again before it could play.

### What changed

- Background planning now builds the all-languages edition of any film with several languages that has only one-language copies, so switching is instant by the time someone tries. A viewer is still given a finished one-language copy at once while it is built.
- A film with one language states it ("Audio English · 5.1, the only language in this film") instead of showing a disabled menu.

### Verification

- `npm run check`: passed. `npm test`: 301 of 302 passed, 1 skipped; the failure was `tests/backend/cache.test.ts` under a load average near 16, which passed 5 of 5 when repeated and is untouched by this change. `npm run test:e2e`: 150 passed.

## Raouf: 2026-11-15 (Australia/Sydney) · prepared films kept; audio menu always shown

**Scope:** two problems the owner reported on the live site: the audio choice was missing, and films the server had already prepared were prepared again. Same branch. Not yet released.

### What was wrong

- **Prepared films were thrown away.** A film's generation included Google Drive's `version` number. Drive raises it for any change to the file's record, not only its content, and on the live server it rose several times an hour on films no one had touched. Each rise made the server treat the film as new. It prepared the film again (one film had four finished copies from 30 minutes), and source verification closed the source and ended playback in progress.
- **No audio choice.** The two films played after the release each have one language, and the menu was hidden for one-language films. It was also out of reach in full screen, which belonged to the video element alone.

### What changed

- **Generations follow content.** A film keeps its generation while its MD5 checksum and size are unchanged, or its head revision when Drive gives no checksum. `version` is used only when Drive gives neither. Library scans and source verification both use this. Editions made for content that has since changed are removed hourly, never one in use.
- **Audio menu for every film.** One-language films show their single language and say so. Films with several languages list them all.
- **Full screen keeps the menus.** A Full screen button (and F) puts the picture and the Audio, Subtitles and Quality menus on screen together. The menus fade after three seconds of playing and return when the pointer moves. On iPhone the video's own full screen is used, which has its own language menus. The browser's full-screen button is hidden where it would leave the menus behind.

### Files changed

`apps/api/src/drive/membership.ts`, `drive/sync.ts`, `drive/client.ts`; `apps/worker/src/prepared-store.ts`, `main.ts`; `apps/web/src/pages/Player.tsx`, `cinema.css`. Tests: `tests/backend/sync.test.ts`, `streaming-playback.test.ts`, `tests/e2e/tracks.spec.ts`; `tests/backend/drive-efficiency.test.ts` now changes the recorded content, not only the generation, to simulate unconfirmed content.

### Verification

- `npm run check`: passed.
- `npm test`: 46 files, 302 passed, 1 skipped.
- `npm run test:e2e`: 150 passed in Chromium, Firefox and WebKit.

### Follow-ups

- Released the same evening as `e58d8f59578d` (record: the maintainer's private notes). Six editions of content that had since changed were removed on start; every remaining edition matches its film.

## Raouf: 2026-11-15 (Australia/Sydney) · languages and pictures released

**Scope:** publish and release the language, subtitle and picture work, as the owner asked. Record: the maintainer's private notes.

### What was done

- **Published.** A sanitized snapshot was pushed to the public repository's audit branch; its default branch was not touched.
- **Backend released.** Release `aae2f72c0a54-a680efab` replaced `29d3e328524b`. Migration 007 ran; the schema is now 7. Units and Nginx were unchanged.
- **Frontend released.** The same revision on Cloudflare (Worker version `a06b7838-b162-4d40-9ca9-3a715438dee2`).
- **Pictures made.** Within a minute the worker had made a poster and a still for every film in the library (five of five), from frames of the films.

### Verification

- Rehearsed on the server before switching: migration 007 on a copy of the live database (`integrity_check` `ok`); a two-language film, one track much shorter than the picture, prepared as an all-languages edition with the release's code and the server's FFmpeg; pictures made from its frames.
- No rollback was needed. Both services have not restarted since.
- Edge checks: 9 of 9, version `aae2f72c0a54`. The new picture routes refuse unauthenticated access.
- Host checks: Nginx, SSH and the host's other service passed.
- Sign-in page: loaded in Chromium and WebKit four of four times. One earlier attempt, seconds after the frontend deploy, timed out before the page appeared, most likely while the new files reached Cloudflare's edge.
- Before deploying: 300 unit tests passed, 1 skipped; 147 browser tests; 12 release tests.

### Follow-ups

- Sign in and try a film with two languages, and the subtitle menu.
- Films already prepared get the language switch the next time another language is chosen.
- Optional TMDB: needs a token on the server and TMDB's logo in the credits first.
- Remove the older rollback material when satisfied.

## Raouf: 2026-11-15 (Australia/Sydney) · switch language and subtitles; automatic film pictures

**Scope:** two owner requests: change audio and subtitles in films that have several, and show good pictures for films automatically. Same branch, `audit/frontend-2026-11-15`. Nothing was pushed or deployed.

### What changed

- **Languages switch at once.** A film with several audio tracks is now prepared for the web player as one edition carrying every language: the picture as one HLS stream, each language as its own, and a top-level playlist written by RAVAN. The player's Audio menu switches with HLS.js (or Safari's own audio tracks) without preparing the film again, and starts in the saved audio language. Each language is made exactly the picture's length. Older one-language editions still play; choosing another language on one prepares the all-languages edition. A failure, or more than 16 tracks, falls back to one language per edition.
- **Subtitles menu.** Off, or any text subtitle track; it starts in the saved subtitle language (`fa`, `fas` and `per` are all Persian), keeps the viewer's choice when captions arrive late, and lists Blu-ray and DVD picture subtitles as ones browsers cannot show. C steps through the tracks. The film page lists subtitles and audio in words ("Persian · 5.1").
- **TV.** Subtitles and Audio buttons. The TV still plays one language per edition, so Audio waits for presses to stop before preparing the next one.
- **Pictures for every film.** After a film is inspected, the worker makes a poster and a wide still: from a cover the file carries (Matroska attachment or MP4 cover), or from the most detailed of several moments in the film, with the title set over the poster. The library hero, film page and player show the still; cards show the poster. No external service is used.
- **Optional TMDB.** With `MOV_TMDB_TOKEN` set, the API looks films up on The Movie Database and downloads real posters and backdrops when the title (and any known year) match. Off by default; when on, film titles and years are sent to TMDB, and Your cinema and the privacy page say so with TMDB's required notice.
- **Database.** Migration 007: picture kind, generation and time on `artwork`, and `artwork_lookups`.

### Found by review and fixed

An independent reviewer read the diff and reported 14 findings; all were fixed with tests:

- the player switched audio back after the viewer chose another language;
- a commentary track of a different length, more than 16 tracks, or a long non-Latin title could make a film unplayable;
- picture jobs could delay inspecting a film being opened;
- a restore left picture records without files;
- a TMDB error locked a film out for a month;
- an unreadable film finished its picture job with nothing and was never retried;
- the saved audio language was ignored in all-languages editions;
- each TV Audio press queued a conversion;
- repeated track names were numbered wrongly;
- titles with a year in them ("Blade Runner 2049") and same-title films ("Dune") were mismatched;
- picture records and files could get out of step;
- a download without a stated length was not size-limited;
- some tests did not check what they claimed.

### Files changed

Source: `apps/worker/src/hls.ts`, `browser-prepare.ts`, `tracks.ts` (new), `artwork.ts` (new), `main.ts`, `leases.ts`; `apps/api/src/media/planner.ts`, `media/tmdb.ts` (new), `sessions/routes.ts`, `library/routes.ts`, `auth/routes.ts`, `app.ts`, `config.ts`; `packages/db/migrations/007_artwork.sql`, `packages/db/src/migrate.ts`, `packages/db/src/backup.ts`; `packages/contracts/src/index.ts`; `packages/client/src/api.ts`; `packages/ui/src/MovieCard.tsx`, `FilmStill.tsx`, `artwork.ts`; `apps/web/src/player/BrowserAdapter.ts`, `player/languages.ts` (new), `pages/Player.tsx`, `pages/Detail.tsx`, `pages/Library.tsx`, `pages/Settings.tsx`, `cinema.css`, `public/privacy/index.html`; `apps/tv/src/main.tsx`, `tv.css`; `scripts/generate-media.mjs`; `.env.example`.

Tests added: `tests/backend/audio-tracks.test.ts`, `artwork.test.ts`, `tmdb.test.ts`, `tests/e2e/tracks.spec.ts`, `tests/e2e/artwork-pictures.spec.ts`. Extended: `tests/backend/streaming-playback.test.ts`. `tests/backend/capabilities.test.ts` now counts conversion jobs separately from the new picture jobs, and asserts the picture job.

Docs: the maintainer's private notes (Languages and subtitles, Pictures), `AGENT.md`, this file.

### Verification

- `npm run check`: passed.
- `npm test`: 46 files, 300 passed, 1 skipped, 0 failed.
- `npm run build`, `build:web`, `build:tv`, `build:cloudflare`: passed. Release suite: 12 passed.
- `npm run test:e2e`: 146 of 147 passed in Chromium, Firefox and WebKit. The one failure was a Firefox TV test that timed out under a load average near 15; it passed 36 of 36 when repeated.
- Multi-language editions, covers, frames and the orphan sweep were tested with real FFmpeg on synthetic films; TMDB only against a fake, so no real lookup was made.

### Follow-ups

- Needs a release to reach the server: migration 007, API, worker and frontend together.
- Films already prepared keep their one-language editions until a language change asks for the new kind.
- To use TMDB: get an API Read Access Token at themoviedb.org and add `MOV_TMDB_TOKEN` to the server's environment. TMDB's terms also ask for its logo in the credits, which is not added yet.
- Pictures are not cached by browsers until the edge and Nginx pass the API's cache header for `/api/artwork/`.

## Raouf: 2026-11-15 (Australia/Sydney) · released to production

**Scope:** publish and deploy everything on `audit/frontend-2026-11-15`: the backend audit, the preparation work, the frontend audit and the UI/UX audit. The owner approved a full redeploy on the production server. Record: the maintainer's private notes.

### What was done

- **Published.** A sanitized snapshot of the branch was pushed to the public repository as a branch; its default branch was not touched and the private history stays local.
- **Backend released.** Release `29d3e328524b-bdc52186` replaced `d16f9443377f` on the server. Migrations 005 and 006 ran; the schema is now 6. The hardened units are installed; the worker may use two CPUs at low priority.
- **Nginx.** `Strict-Transport-Security` added to the RAVAN origin host. Nothing else in that file changed.
- **Frontend released.** The same revision was deployed to Cloudflare (Worker version `5fb3f1aa-8987-4e4d-ab25-22b3b48fdb86`).
- **Operations document.** the maintainer's private notes gains a Releasing section with the procedure followed, and the unit limits are corrected.

### Verification

- Before switching, on the server: the release's configuration loaded from the server's environment; the prepared-volume check passed; both migrations applied to a copy of the live database with `integrity_check` `ok`; FFmpeg wrote and FFprobe read an HLS edition inside the new sandbox.
- The switch needed no rollback. Both services are active with no restarts.
- Edge checks: 9 of 9 passed, version `29d3e328524b`.
- The authorization fix is live: `/%61pi/movies` returns 404.
- The sign-in page loaded in Chromium and WebKit against production with no errors.
- The host's other health checks passed after the change: Nginx, SSH and the existing subscription service.
- Before deploying: `npm run check`; 278 unit tests passed, 1 skipped; 132 browser tests in three engines; 12 release tests against this commit's production build.

### Follow-ups

- Sign in and use it: nothing behind the sign-in was exercised against production by this deployment.
- Open the player once, so the server learns what this browser plays and stops preparing editions it does not need.
- Rollback material is kept on the server (previous units, Nginx file and the pre-migration database). Remove it once the release has been used for a while.
- The TV package was not rebuilt.

## Raouf: 2026-11-15 (Australia/Sydney) · UI and UX audit against the rule set

**Scope:** check the interface rule by rule against the UI/UX Pro Max rule set and the frontend-design guidance, measure what can be measured, and fix what is found. Same branch, `audit/frontend-2026-11-15`. Nothing was pushed or deployed. Report: the maintainer's private notes.

### What changed

- **Back returns to where you were.** History entries are numbered and their scroll position is restored once the content is there. The library keeps its last view (films, search, next-page cursor) for five minutes, so returning from a film asks the server for nothing. "Back to the collection" goes back rather than opening a second copy.
- **Fields no longer zoom the page on iOS.** They are 16 px wherever a finger is the pointer.
- **The folder field validates.** Its `pattern` had an unescaped hyphen, which browsers reject under the `v` flag, so the pattern was being ignored. Messages now say what is needed.
- **The TV header's spacing works on Chromium 79.** It used flex `gap`.
- **Icons are drawn** (`packages/ui/src/Icon.tsx`) instead of typed as characters.
- **Type follows the reader's text-size setting.** Every size in the web stylesheets is in rem.
- **Six named text colours** replace 32 raw ones.
- **One `h1` on every screen**, 44 px touch targets on phones, `/` to search and Escape to clear, a line when the device is offline, a destructive style for removing a TV, a landscape layout for phones.
- **Copy:** labels that said nothing, arrows appended to links and facts joined with dots are gone.

### Files changed

Source: `apps/web/src/router.tsx`, `libraryCache.ts` (new), `main.tsx`, `cinema.css`, `pages/Library.tsx`, `Detail.tsx`, `Player.tsx`, `Settings.tsx`, `Setup.tsx`, `Mfa.tsx`; `apps/tv/src/main.tsx`, `tv.css`; `packages/ui/src/Icon.tsx` (new), `MovieCard.tsx`, `StatusPanel.tsx`, `tokens.css`, `loading.css`.

Tests added: `tests/e2e/ux.spec.ts`, `tests/clients/design-rules.test.ts`. One assertion added earlier today in `tests/clients/loading.test.tsx` follows the reworded library status. No older test was edited.

Docs: the maintainer's private notes with screens in the maintainer's private notes, `AGENT.md`, this file.

### Verification

- `npm run check`: passed.
- `npm test`: 43 files, 278 passed, 1 skipped, 0 failed.
- `npm run build`, `build:web`, `build:tv`, `build:cloudflare`: passed.
- `npm run test:e2e`: 132 passed across Chromium, Firefox and WebKit on one of two final runs. The other had 1 Chromium timeout in the streamed-playback test under a load average of about 20; that file passed 18 of 18 alone.
- Release suite: 12 passed.

### Follow-ups

- Check the iOS zoom fix, landscape layout and touch targets on a real iPhone, and the TV header on the LG C1.
- The TV stylesheet still carries its own raw colours.
- Preload the two display fonts once the build can write their hashed names into `index.html`.

## Raouf: 2026-11-15 (Australia/Sydney) · frontend audit: loading, preparation states, accessibility

**Scope:** audit every frontend file and fix what was found, on `audit/frontend-2026-11-15` (created from `audit/backend-2026-11-15`). The visual identity is kept. Nothing was pushed or deployed. Report: the maintainer's private notes.

### What changed

- **One loading language.** `packages/ui/src/Loading.tsx` and `loading.css` add the copper line (moving for an unknown wait, filled only to a percentage the server sent), an opening mark, placeholders in the final layout, and buttons that stay focusable while their action runs. `index.html` shows a CSS-only opening screen until the session is known and never holds the page back for it.
- **Preparation shows what the server is doing.** The API's preparing answer gains an optional `phase` (`inspecting`, `queued`, `retrying`, `repackaging`, `converting`, `buffering`). The web player and the TV show that step and the worker's percentage. No time, speed or estimate is displayed.
- **The saved "Reduce interface motion" preference is applied.** It was stored and ignored.
- **The library no longer jumps.** Placeholders hold the hero and grid; later searches keep the current results on screen; every list request is numbered so a late answer is dropped; a failed next page keeps the grid.
- **Films without artwork** get one typographic poster family, and a real library's hero shows the film's poster beside its title.
- **Player:** one stage for connecting, preparing, unsupported, in use elsewhere, failed, paused, buffering and ended; the same keyboard shortcuts in every browser. The browser's own controls are kept for the picture.
- **Settings:** placeholders and retry, a pending state and message per panel, confirmation before removing a TV, paired screens that refresh, the library's real counts, a pasted Drive link accepted.
- **TV:** placeholders, a pairing wait state, a full-screen player whose transport steps aside while the film plays, the remote's transport keys, position and duration.
- **Shell:** film page, player and settings are fetched when first opened; each screen names the tab and takes focus; a session that ends mid-visit returns to sign-in; a screen whose code fails to load says so; "Sign out" is a labelled button.
- **Accessibility:** control outlines raised to at least 3:1; three targets under 24 px fixed; text floor of 11 px; one link per film card; failures announced with `role="alert"`.
- **Removed:** 98 CSS rules for classes nothing used, the fake sequence markers ("01 / YOUR NEXT SCREENING", "01 02 03"), and the per-card entrance animation.

### Measured

- Library layout shift: 0.6277 to 0.0000 at 1440 px, 0.7203 to 0.0002 at 390 px.
- Web entry script: 91.40 kB to 74.24 kB gzip. Web stylesheet: 9.19 kB to 10.74 kB gzip. First screen overall: 15.6 kB gzip less.
- TV entry script: 77.51 kB to 79.53 kB gzip.

### Files changed

Source: `apps/web/index.html`, `apps/web/public/privacy/index.html`, `apps/web/src/main.tsx`, `router.tsx`, `motion.ts` (new), `cinema.css`, `pages/Library.tsx`, `Detail.tsx`, `Player.tsx`, `Settings.tsx`, `Mfa.tsx`, `player/Preparing.tsx` (new); `apps/tv/src/main.tsx`, `tv.css`; `packages/ui/src/Loading.tsx` (new), `loading.css` (new), `MovieCard.tsx`, `StatusPanel.tsx`, `tokens.css`; `packages/contracts/src/index.ts`; `apps/api/src/media/planner.ts`, `apps/api/src/sessions/playback.ts`.

Tests added: `tests/clients/loading.test.tsx`, `tests/e2e/loading.spec.ts`. Extended: `tests/backend/streaming-playback.test.ts`. No existing test was edited.

Docs: the maintainer's private notes with before and after screenshots in the maintainer's private notes, `docs/visual-design.md`, `AGENT.md`, this file. `docs/testing/screenshots/` regenerated by the suites.

### Verification

- `npm run check`: passed.
- `npm test`: 42 files, 274 passed, 1 skipped, 0 failed. Baseline was 41 files, 263 passed, 1 skipped.
- `npm run build`, `build:web`, `build:tv`, `build:cloudflare`: passed.
- `npm run test:e2e`: 114 passed across Chromium, Firefox and WebKit on two of three final runs. The third had 2 Chromium playback timeouts while the machine's load average was near 40; the same tests passed 12 of 12 alone and in the next full run. Baseline was 57.
- Release suite (`playwright.release.config.ts`): 12 passed against the production build.
- The one skipped test needs FFmpeg's `zscale` filter, which this machine lacks.
- An independent reviewer read the diff and reported 14 findings; all were fixed and are listed in section 12 of the report.

### Follow-ups

- Not verified on a physical LG C1 or with a screen reader.
- The TV's focus move to Play when a film becomes ready is not covered by a test.
- The API and the web client should ship together: an older API simply sends no `phase`, and the panel then shows the server's sentence and a moving line.
- Film cards cannot show progress through a film until the catalogue returns each film's length.

## Raouf: 2026-11-15 (Australia/Sydney) · watch a film while it is prepared

**Scope:** remove the last large wait, finish the remaining improvements, and check current documentation for what the tools support. Same branch, `audit/backend-2026-11-15`. Nothing was pushed or deployed. Report: the maintainer's private notes.

### What changed

- **A film can be watched while it is still being prepared.** Editions for the web player are written as HLS segments. Playback starts once the first segments exist when preparation outpaces playback, and otherwise as soon as the converter is sure to stay ahead of the viewer.
- **The prepared volume size is a setting** (`MOV_PREPARED_CAPACITY_BYTES`), and the largest edition and the copy limit follow it. Enlarging the volume on the server is a separate step.
- **The player uses HLS.js before native HLS**, starts an unfinished playlist at the beginning or the saved position, recovers once from a decode error, and adds captions when the edition completes without reloading.
- **Codec detection also asks the Media Capabilities API** whether decoding is smooth, and withdraws a codec the device would stutter on.
- Sideways (phone) footage is sized for the picture as shown.
- The superseded TS-segment HLS module is removed.

### From the documentation

- HLS.js 1.7.4 advises checking `Hls.isSupported()` before native playback because recent Chromium claims native HLS but does not play every stream. The player did the opposite. Playwright's Chromium confirmed it: native playback of the growing playlist loaded and never advanced.
- HLS.js starts an unfinished playlist at its newest segment unless `startPosition` is set.
- FFmpeg's `temp_file` flag makes a segment and the playlist appear only when complete.

### Found by testing in real browsers

- WebKit stalled at the first frame of a streamed edition in about half its runs. A small start-of-playback watchdog in the player fixed it: twelve of twelve afterwards.

### Files changed

Source: `apps/worker/src/hls.ts` (new), `browser-prepare.ts`, `main.ts`, `leases.ts`, `prepared-store.ts`, `probe.ts`, `compatibility.ts`; `apps/api/src/config.ts`, `app.ts`, `media/planner.ts`, `sessions/playback.ts`, `sessions/routes.ts`; `apps/web/src/player/BrowserAdapter.ts`, `PlayerController.ts`, `capabilities.ts`, `pages/Player.tsx`; `packages/contracts/src/index.ts`; `packages/db/src/migrate.ts`, `migrations/006_streaming.sql` (new); `scripts/generate-media.mjs`; `.env.example`. Removed `apps/worker/src/prepare.ts` and `output-validation.ts`.

Tests added: `tests/backend/streaming-edition.test.ts`, `streaming-playback.test.ts`, `tests/clients/browser-adapter.test.tsx`, and a streamed-edition test in `tests/e2e/playback.spec.ts`. Extended: `bootstrap.test.ts`, `tests/clients/capabilities.test.ts`, `player.test.ts`. `jobs.test.ts` lost the two tests of the removed module and kept their probe assertions. The three tests that assert the migration count now derive it from the migrations folder.

### Verification

- `npm run check`: passed.
- `npm test`: 41 files, 263 passed, 1 skipped, 0 failed. Before this change: 38 files, 235 passed, 1 skipped.
- `npm run build`, `build:web`, `build:tv`, `fixtures`: passed.
- `npm run test:e2e`: 57 passed across Chromium, Firefox and WebKit, on two consecutive runs.
- `npm audit`: 0 vulnerabilities.
- An independent reviewer found no way for a ticket to reach a file outside its own edition and no way for a served playlist to point elsewhere, and six behaviour problems, all fixed with tests. An automated review found the size limit on streamed output depended on FFmpeg's progress reports; it now runs on its own timer.

### Follow-ups

- Not tested in real Safari or on the LG television. Playwright's WebKit is the closest that could be run.
- Captions appear when an edition completes, not while it grows.
- A 4K HDR conversion for a browser without HEVC is slower than playback, so it starts part-way through.
- Enlarging the prepared volume on the server, and the deployment itself, are the owner's steps.

## Raouf: 2026-11-15 (Australia/Sydney) · faster preparation and the remaining audit findings

**Scope:** make films playable sooner, accept more formats, and close what the backend audit left open. Same branch, `audit/backend-2026-11-15`. Nothing was pushed or deployed. Reports: the maintainer's private notes and the maintainer's private notes.

### Faster playback

- The player reports what the browser can decode. The server then plays the original directly, repackages it with the picture untouched, or re-encodes it, in that order. HEVC (including 4K HDR), AV1, Matroska and WebM originals no longer need an hours-long conversion on a browser that plays them.
- The film a viewer opens is prepared before background work, and its inspection no longer waits behind a running conversion.
- The encoder defaults to `superfast` and one thread per CPU: 1.8× faster on the SDR benchmark, with no measurable quality loss.
- Source blocks are read from Drive up to three at a time instead of one.
- Background preparation plans for the browser the owner last used and drops conversions that this made pointless.
- A failed preparation can be retried by asking to play again.

### Formats

- MXF, WTV, DV, IVF and raw MPEG video and VC-1 are accepted; more file extensions are recognized.
- Anamorphic sources are no longer encoded squeezed; interlaced sources are deinterlaced.
- Sixteen container and codec combinations are converted from real files in the test suite.

### Audit findings closed

- The worker key no longer appears on FFmpeg's command line; each job uses a grant for one file that expires.
- A mistyped library folder is rejected before it replaces the working one.
- Drive edits outside the library no longer trigger scans.
- Dead sessions are pruned; anonymous pairing requests cannot crowd out a real TV; the origin sends HSTS; the worker validates stored probes; both service units gain sandbox options.

### Measurements

- 4K HDR to 1080p SDR: 11.0 fps with the previous settings; the tone-mapping chain is the limit and tuning gains at most 1.1×. Repackaging avoids it.
- 1080p HEVC to H.264: 19.6 fps before, 35.2 fps with the new defaults.
- `superfast` against `veryfast`: 1.6× faster, 8% more bits, PSNR 31.12 against 31.17 dB.

### Files changed

Source: `apps/api/src/app.ts`, `config.ts`, `drive/client.ts`, `drive/sync.ts`, `library/import.ts`, `media/cache.ts`, `media/planner.ts`, `sessions/pairing.ts`, `sessions/routes.ts`; `apps/worker/src/browser-prepare.ts`, `compatibility.ts`, `leases.ts`, `main.ts`, `prepared-store.ts`, `probe.ts`; `apps/web/src/player/capabilities.ts` (new), `pages/Player.tsx`, `preview.ts`; `packages/contracts/src/index.ts`, `schemas.ts`; `packages/db/src/migrate.ts`, `migrations/005_job_priority.sql` (new); `deploy/nginx/ravan-origin.conf.template`, `deploy/systemd/ravan-api.service`, `ravan-worker.service`; `.env.example`.

Tests added: `tests/backend/job-priority.test.ts`, `worker-yield.test.ts`, `capabilities.test.ts`, `formats.test.ts`, `residuals.test.ts`, `tests/clients/capabilities.test.ts`. Extended: `cache.test.ts`. Three tests that assert the migration count now expect five.

### Verification

- `npm run check`: passed.
- `npm test`: 38 files, 235 passed, 1 skipped, 0 failed. Before this follow-up: 31 files, 169 passed, 1 skipped.
- `npm run build`, `build:web`, `build:tv`, `fixtures`: passed.
- `npm run test:e2e`: 54 passed across Chromium, Firefox and WebKit.
- `npm audit`: 0 vulnerabilities.
- An independent reviewer read the follow-up diff. It found no defect in the capability rules, asset identities, block cache read-ahead, change-feed filtering or pruning, and four defects in the new code: an API outage burning every queued job's attempts, old probes lacking default-track data, one worker loop's error closing the database under a running conversion, and `POST /api/library` reporting a scan that did not start. All four are fixed in the last source commit, each with a test. An automated review of an earlier commit found that a paired device could set the stored browser report; that is fixed too.

### Follow-ups

- Deploy the API and worker together; an older API has no grant route.
- Open the player once after deploying so the server records what the browser plays.
- A prepared film still cannot play until it is complete. Playing while preparing is the next large gain.
- The 20 GiB prepared volume cannot hold a repackaged 4K original over 16 GiB.
- Not measured: Drive read speed on the server, and the new defaults on the production host.

## Raouf: 2026-11-15 (Australia/Sydney) · backend audit and remediation

**Scope:** every backend file (API, worker, edge, database, contracts, client API, scripts, deploy templates, tests). Branch `audit/backend-2026-11-15`, from `17dfa23`. Nothing was pushed or deployed. Full report: the maintainer's private notes.

### Security

- **Critical:** the API authorization hook tested the raw URL for an `/api/` prefix, but the router decodes a path before matching. `/%61pi/movies` reached private handlers with no session, and an anonymous caller could approve its own TV pairing request into a device credential. The hook now decides on the matched route. Not reachable through the public hostname, which returned 404 for the encoded path on the audit date.
- Anonymous sign-in starts could fill the 100 pending slots and return 429 to the owner. The oldest abandoned attempt is now evicted.
- The legacy single-host Nginx draft passed the client's `X-Forwarded-For` to an API that trusts it from loopback. It now sends `$remote_addr`.

### Reliability

- A service stop no longer spends one of a conversion's three attempts.
- A seek no longer fails by inheriting the cancellation of the request it replaced.
- A cached block of the wrong length is refetched instead of failing on every read.
- A transient error while re-checking the library root no longer marks every source unavailable.
- The API and worker no longer crash against each other when both apply a migration at startup.
- Drive block reads retry up to three times on 429, 5xx, a dropped connection or a short body.

### Performance

- Drive metadata lookups while streaming: 99 for 10 blocks before, 33 after.
- Scheduled refresh of an unchanged 21-folder library: 24 Drive calls before, 2 after.

### Smaller changes

- Rate-limited and unknown-route responses use `{ "error": "rate_limited" }` and `{ "error": "not_found" }`.
- `MOV_ORIGIN` with a trailing slash or path is rejected at startup.
- A failed start names the setting and rule that failed, never a configured value.
- The API client raises `ApiError` for a non-JSON gateway error.
- Unit files renamed to `ravan-api.service` and `ravan-worker.service`, the names their own dependency lines use.
- Removed unused `requireOwner` and `librarySchema`.
- the maintainer's private notes and `docs/backend-usage.md` corrected and extended.

### Files changed

Source: `apps/api/src/app.ts`, `config.ts`, `main.ts`, `auth/routes.ts`, `drive/sync.ts`, `library/import.ts`, `media/cache.ts`, `media/source-stream.ts`; `apps/worker/src/main.ts`, `leases.ts`; `packages/db/src/migrate.ts`, `open.ts`; `packages/client/src/api.ts`; `packages/contracts/src/schemas.ts`; `deploy/nginx/mov.conf.template`; `eslint.config.js`. Removed `apps/api/src/auth/owner.ts`. Renamed two unit files.

Tests added: `tests/backend/route-guard.test.ts`, `oauth-capacity.test.ts`, `worker-shutdown.test.ts`, `drive-efficiency.test.ts`, `migration-race.test.ts`, `tests/clients/api.test.ts`. Extended: `bootstrap.test.ts`, `cache.test.ts`, `streaming.test.ts`, `sync.test.ts`.

Docs: the maintainer's private notes, the maintainer's private notes, `docs/backend-usage.md`, `README.md`, `AGENT.md`, this file.

### Verification

- `npm run check`: passed.
- `npm test`: 31 files, 169 passed, 1 skipped, 0 failed. Baseline was 25 files, 135 passed, 1 skipped.
- `npm run build`, `build:web`, `build:tv`, `fixtures`: passed.
- `npm run test:e2e`: 54 passed across Chromium, Firefox and WebKit on two of three runs. The third had 3 Firefox timeouts while the machine was under heavy unrelated load; those tests mock the API and cover unchanged frontend code.
- `npm audit`: 0 vulnerabilities.
- The one skipped test needs FFmpeg's `zscale` filter, which this machine lacks.
- An independent reviewer with no knowledge of these findings read the source diff. It reported no defect in the authorization fix, block cache, job release or migrations, and four defects in this branch's own new code (a transient change-feed error recording a failed scan; an in-flight verification closing a newly published generation; retrying a failed token refresh; an unbounded startup lock retry). All four are fixed in `aa10d47`, each with a test.

### Follow-ups

- A preparation that fails three counted attempts has no owner-facing retry.
- Deploying restarts the worker; a running conversion starts again from the beginning.
- Do not publish this branch or the audit report before the fix is deployed.
- Production Nginx configuration, server FFmpeg build and real Drive latency were not verified.
