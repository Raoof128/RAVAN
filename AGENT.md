# Working in this repository

RAVAN is a private, single-owner cinema: a Fastify API, a media worker, a Cloudflare edge Worker, SQLite, and React clients. This file records the rules that keep it safe to change. `CHANGELOG.md` records what changed and how it was verified.

## Before changing code

- Read `README.md`, `docs/backend-usage.md`, the maintainer's private notes, the maintainer's private notes, the maintainer's private notes and the maintainer's private notes. For the web or TV client, also read `docs/visual-design.md`, the maintainer's private notes and the maintainer's private notes.
- Run `npm run check` and `npm test` first and note anything already failing.
- Work on a branch. Do not push to `main`, deploy, or touch the server without the owner's say-so.
- Publishing goes to the public repository as a sanitized snapshot on a branch, never the private branch. Releasing follows the Releasing section of the maintainer's private notes and needs the owner's approval each time.

## Rules the code depends on

- **Authorize by matched route.** Guards read `request.routeOptions.url`. Never decide on `request.url`: the router decodes a path before matching, so the raw text and the handler can disagree.
- **The API answers only plainly written paths.** A request whose path holds `%2F`, `%5C`, `%2E`, `%25`, a backslash, `//` or a dot segment is refused before routing (`apps/api/src/app.ts`). The proxy in front resolves those when it chooses a rule and this router does not, and each such difference is a way round a layer. Test crafted paths over a real socket: `app.inject` tidies them first.
- **Every `/api` route is private unless listed** in `publicApiRoutes` in `apps/api/src/auth/routes.ts`. A route a paired device may call must be added to a device set there.
- **A library session is created in one place**, inside the MFA verification transaction in `apps/api/src/auth/mfa.ts`. Google sign-in alone yields only a challenge.
- **A sign-in attempt lives in its own browser**, sealed into the `mov_oauth` cookie. Do not bring back a server-side table of attempts: anything that bounds it lets strangers push the owner's attempt out.
- **A paired screen is bounded in the work it can ask for** (`SCREEN_WAITING_LIMIT` in `apps/api/src/media/planner.ts`), and can revoke only itself (`POST /api/pairing/forget`).
- **State changes need the CSRF token and an exact `Origin`.** `GET` handlers must not change state.
- **Media is authorized per ticket and per chunk.** Paths under a prepared asset come from a 64-hex ID and a filename matched by regular expression.
- **A source's generation follows its content, never Drive's `version`.** `contentKey` in `apps/api/src/drive/membership.ts` (checksum and size, else head revision) decides whether a scan keeps the generation and whether verification accepts a file. `version` rises with any change to Drive's record of the file; using it re-prepared films and ended playback.
- **Drive verification may be reused for five seconds, except after a read.** `verifySource(id, true)` must be used whenever the answer has to postdate bytes just fetched.
- **Subprocesses take fixed argument arrays** with `shell: false`, protocol and format allowlists, and a timeout. Never store or return FFmpeg stderr; classify it to a fixed code.
- **Errors leave the API as `{ "error": "<code>" }`** with no paths, filenames, tokens or upstream messages.
- **Logging stays off for requests.** Tickets and OAuth codes travel in URLs. The one line the API writes is for a request that failed inside the server (5xx): method, matched route pattern, error class and code, each reduced to letters, digits and underscores. Never add the address, a header, a message or data to it.
- **Routes are declared after the rate limiter is registered** in `apps/api/src/app.ts`. The limiter counts only routes it sees added.
- **Migrations are immutable and append-only.** Add a new numbered file and list it in `packages/db/src/migrate.ts`.
- **A job interrupted by a service stop or by a viewer's newer request is released, not failed.** Only real failures and crashes spend attempts.
- **A client's capability report is a claim.** It may shape that client's own request. It is stored for background planning only when the request is authenticated by the owner's browser session, never because of a profile name.
- **No capabilities means the previous behaviour and the previous asset ids.** An edition only some clients can play carries a `variant` in its asset id and must never replace the universal H.264 one.
- **FFmpeg and FFprobe get none of the service's environment** (`runProcess` passes a path, a temporary directory and a locale), and a bound on the pixels they may decode for a picture (`MAX_COVER_PIXELS`, `MAX_PICTURE_PIXELS`). A film, its cover and its captions are data the server did not write.
- **FFmpeg never receives the worker key.** It gets a grant for one file. Do not put any long-lived credential on a command line.
- **A playlist is served only in the exact form this server writes.** `parsePlaylist` in `apps/worker/src/hls.ts` is the gate; a player fetches every address a playlist names. Never serve a playlist, or add a tag, without going through it.
- **An edition being written is offered only in state `streaming`, and withdrawn on any failure.** Its files appear only when complete (`temp_file`); do not write into an edition's directory any other way.
- **One list of an edition's file names: `HLS_FILE` in `apps/worker/src/hls.ts`.** Every gate that admits a media file by name uses it. A second, narrower list in the media route once made every all-languages edition unplayable while each side's tests passed.
- **A failed Drive call is a verdict only if `sourceGone()` says so** (`apps/api/src/drive/sync.ts`). Drive reports a usage limit as 403 as well as 429; the client turns both into 429. Never end a session, fail a job or close the library on any other failure.
- **A heartbeat must answer within the player's patience.** It waits eight seconds for Drive, and access is extended only by a confirmation that succeeded.
- **Languages are compared with `sameLanguage`** (`packages/contracts/src/languages.ts`), by the server and the players alike: "en" is "eng"; "fa", "fas" and "per" are one language.
- **A film's length for an edition is `pictureMs(probe)`**, not `probe.durationMs`: sound and captions can outlast the last frame.
- **The API and worker ship together.** They share the database schema and the `/_worker` protocol.

## Rules the interface depends on

- **Show only what the server sent.** A preparation step comes from `phase`, a bar from `progress`, a sentence from `reason`. No time remaining, speed, queue position or percentage may be computed or guessed in the client. `apps/web/src/player/Preparing.tsx` is the one place this is drawn, for web and TV.
- **Never hold a screen back for an animation.** The opening screen in `apps/web/index.html` goes when the session answers. Placeholders appear only after `useDelayed`.
- **Loading uses the primitives in `packages/ui/src/Loading.tsx`.** Do not add another spinner, shimmer or skeleton. Animate `opacity` and `transform` only.
- **Every animation needs a still form.** Both `prefers-reduced-motion` and `:root[data-motion="reduce"]` set `animation: none`; an element whose base style is invisible until its animation runs will stay invisible. Write keyframes from the hidden state, not to the visible one, or add an explicit reset.
- **`index.html` may carry inline CSS but no inline script.** The content security policy permits self-hosted scripts and WebAssembly compilation for local PDF decoders, never general JavaScript eval.
- **The reader keeps a mouse selection inside the page.** `containSelection` (`apps/web/src/reading/selection.ts`) corrects a drag that leaves `.reading-viewport`; browsers otherwise select to the end of the chapter. Keep it when changing the reader's layout, and keep the bars outside the scrolling page or remove it with a test that drags past both bars.
- **Book covers are pictures like films' pictures.** Files live in `<data directory>/artwork`, rows in `reading_covers`, and they are served only by random id at `/api/artwork/:id`. Anything that lists or clears picture files (`sweepArtwork`, the restore scrub in `packages/db/src/backup.ts`) must include `reading_covers`, or covers are deleted as strays.
- **PDF text is PDF.js's `TextLayer` over the canvas.** Keep `--total-scale-factor` in step with the size the canvas is shown at, and keep the `endOfContent`/`selecting` guard; without it a drag in a gap selects to the end of the page.
- **Reading limits are by format** (`readingLimit` in `packages/contracts/src/reading.ts`): PDFs up to 512 MB, read only in pieces above 100 MB; EPUB and CBZ up to 100 MB, held whole. Whole-book preparation and warming stay at 100 MB. Covers have their own bound (`MAX_COVER_BOOK_BYTES`).
- **The reading room is browsed by Drive folder, as the films are.** Both use `apps/api/src/library/folders.ts`; a book's folder is `json_extract(metadata,'$.parents[0]')` from the scan's own record. Folder cards hide folders with none of their kind (no books, or no films).
- **The reading room is Google Drive only.** Books have their own catalogue and server progress. Do not add device imports or browser-local reading history. Serve bytes only after live folder/access/generation checks; never serve book HTML as a same-origin document.
- **Browser storage holds the motion flag (`ravan:motion`) and the TV's device credential, nothing else.** Never an MFA secret, a session token or library data.
- **A control whose action is running stays focusable.** Use `ActionButton` and `usePending`; do not set `disabled` on it. When an action removes the focused control, move focus somewhere deliberate.
- **Anything the TV loads must run on Chromium 79.** The build lowers script syntax and `inset`; it does not lower flex `gap`, `aspect-ratio`, `:focus-visible`, `:is()` or `:where()`. `tv.css` and `loading.css` avoid them; shared rules in `tokens.css` that use them are overridden in `tv.css`.
- **TV focus ids are a contract.** `data-focus-id` values are what remote navigation and its tests use. While the transport is hidden, the key that reveals it must do nothing else.
- **One link per film card.** The poster link covers the card; the title is a heading, not a second link.
- **Text an owner needs is at least 11 px, targets at least 24 by 24 px, control outlines `var(--control)`.** `tests/e2e/loading.spec.ts` measures all three on every screen from 320 to 3840 px.
- **`PlayerController.ts` and `BrowserAdapter.ts` own tickets, sessions and recovery.** Interface work goes around them, in the pages.
- **The web player draws its own controls** (`apps/web/src/player/Transport.tsx`); the video has no `controls` attribute except while it is full screen alone (the fallback for browsers that refuse the frame). The controls act on the video element only.
- **A film's title follows its Drive file name until the owner edits it in RAVAN** (`movies.title_edited`). Any code that changes a title for the owner must set `title_edited=1`, or the next scan puts the file name back.
- **Episodes are read from file names, never from titles** (`packages/contracts/src/episodes.ts`). Titles can be edited; numbers cannot.
- **Both clients must run on Chromium 79 (LG C1).** Keep `build.target` at `chrome79` and newer; fill a missing function in `packages/client/src/legacy.ts`, never by raising the target. `npm run check:legacy` and `build:cloudflare` refuse a script Chromium 79 cannot run. Write layout that holds without flex `gap`, `aspect-ratio` and `dvh`, or give it a fallback. Never put `:focus-visible` in a selector list with another selector (Chromium 79 drops the whole rule); give it a `[data-focus-visible="fallback"]` `:focus` copy. No `:is()`, `:where()` or `:has()`.
- **Type sizes are in rem; colours for text come from tokens.** `--text`, `--text-soft`, `--muted`, `--accent`, `--success`, `--danger`. `tests/clients/design-rules.test.ts` fails on a px type size or a new raw text colour. The TV stylesheet is exempt: it is a fixed 1080p layout.
- **Icons come from `packages/ui/src/Icon.tsx`.** Do not type ▶, ↗ or similar characters as icons; devices draw them differently, some as emoji.
- **Fields are 16 px where a finger is the pointer, and non-inline targets 44 px on a phone.** `tests/e2e/ux.spec.ts` measures both.
- **Navigation goes through `apps/web/src/router.tsx`.** It numbers history entries and restores scroll on Back. Do not call `window.scrollTo` on route change elsewhere. A "back to…" link uses `returnTo` so it does not push a second copy of the screen.
- **The library is browsed by folder through `GET /api/movies?folder=`.** The folder tree comes only from a scan (`library_folders`, replaced whole on publish). Without `folder`, `/api/movies` keeps its old flat answer: the television depends on it.
- **Anything that changes what the library lists must call `forgetLibrary(api)`** (`apps/web/src/libraryCache.ts`): playing, saving, editing.
- **Escape a hyphen in an HTML `pattern`.** Browsers compile it with the `v` flag and silently ignore a pattern that is invalid there.
- **Track choices go through `TrackPanel` (`apps/web/src/player/TrackPanel.tsx`).** Radio groups, not native selects; labels pass through `readableChoices` so codes become language names. A choice must show at once and then follow what the player reports.
- **One `h1` per screen.** `StatusPanel` takes `level={1}` when it is the only heading.
- **Every playlist and picture is served only in the form this server writes.** `servePlaylist` (`apps/worker/src/hls.ts`) is the gate for media and top-level playlists; track names from a film are reduced to safe characters before they are written. Pictures are served by random id from `<data directory>/artwork` only (`ARTWORK_FILE`). Never serve a URL or path a client or a film supplies.
- **No title leaves the server unless `MOV_TMDB_TOKEN` is set.** TMDB is reached only from the API (the worker cannot reach the internet), only at its fixed hosts, with redirects refused and every answer size-limited. A match needs the title and, when several films share it, the year.
- **The TV fetches pictures with its credential.** It must never put a server picture's address in an `img`; use `useArtwork` in `apps/tv/src/main.tsx`.

## Testing

- Reproduce a defect with a failing test before fixing it. Keep the test.
- Tests use temporary directories, synthetic media and fake Google clients. Never use real tokens, the real database or personal films.
- Do not skip, delete or loosen a test to make a run pass.
- The browser suites mock the API. Backend behaviour is proven in `tests/backend` and `tests/deploy`.
- `tests/backend/end-to-end.test.ts` runs the real API, the real worker and FFmpeg, and fetches a film as a player does. When the worker starts writing anything a player fetches, or the API starts serving it, extend that test: testing each side alone is how the two came to disagree.

## Verification commands

```sh
npm run check
npm test
npm run build
npm run build:web
npm run build:tv
npm run fixtures
npm run test:e2e
```

## Secrets and data

Never commit or print populated `.env` files, OAuth client JSON, database files, MFA material, server keys, backups or films. Client servers and production data are inspect-only.

## Log

Raouf: 2026-11-15 (Australia/Sydney)

- Scope: full backend audit and remediation on `audit/backend-2026-11-15`.
- Summary: fixed 19 findings, one critical (API authorization decided on the raw URL). See the maintainer's private notes.
- Files changed: see `CHANGELOG.md`.
- Verification: 31 files, 169 passed, 1 skipped, 0 failed; `npm run check`, all three builds and `npm run test:e2e` pass (54 browser tests; three Firefox tests timed out once under heavy machine load and passed on rerun).
- Follow-ups: R-01 (retry path for failed preparations) and the unverified production items in section 10 of the audit.

Raouf: 2026-11-15 (Australia/Sydney), second entry

- Scope: faster preparation, wider format support, and the audit's remaining findings.
- Summary: the server now plays or repackages what the browser can decode instead of re-encoding it; viewer requests outrank background work; encoder defaults and source read-ahead are faster; R-01, R-03 to R-09, R-11 and R-15 are fixed. See the maintainer's private notes.
- Files changed: see `CHANGELOG.md`.
- Verification: 38 files, 235 passed, 1 skipped, 0 failed; `npm run check`, all three builds and `npm run test:e2e` (54 passed across Chromium, Firefox and WebKit) pass.
- Follow-ups: playing while preparing (P-09), a larger prepared volume (P-10), and confirming the new defaults on the production host.

Raouf: 2026-11-15 (Australia/Sydney), third entry

- Scope: playing a film while it is prepared, a configurable prepared volume, and current-documentation checks.
- Summary: editions for the web player are HLS and playable while growing; the player prefers HLS.js, sets its start position and guards the first frame on WebKit; codec detection uses Media Capabilities. See the maintainer's private notes.
- Files changed: see `CHANGELOG.md`.
- Verification: 41 files, 263 passed, 1 skipped, 0 failed; `npm run check`, all three builds and `npm run test:e2e` (57 passed across Chromium, Firefox and WebKit, on two consecutive runs) pass.
- Follow-ups: real Safari and LG television checks; captions during growth; enlarging the volume on the server.

Raouf: 2026-11-15 (Australia/Sydney), fourth entry

- Scope: full frontend audit and remediation on `audit/frontend-2026-11-15`.
- Summary: one loading language, preparation screens driven by a new `phase` field from the API, the saved motion preference applied, layout shift on the library removed (0.63 to 0.00), accessibility gaps closed, a full-screen TV player. See the maintainer's private notes.
- Files changed: see `CHANGELOG.md`.
- Verification: 42 files, 274 passed, 1 skipped, 0 failed; `npm run check` and all four builds pass; `npm run test:e2e` 114 passed (one of three final runs had 2 Chromium playback timeouts under a load average near 40); release suite 12 passed.
- Follow-ups: verify on a physical LG C1 and with a screen reader; test the TV's focus move to Play; return film length in the catalogue.

Raouf: 2026-11-15 (Australia/Sydney), fifth entry

- Scope: UI and UX audit against the UI/UX Pro Max rule set and the frontend-design guidance, on `audit/frontend-2026-11-15`.
- Summary: 19 findings fixed. Back keeps scroll, search and results; fields no longer zoom on iOS; the folder pattern validates; the TV header no longer depends on flex gap; drawn icons, rem type, six text colours, one `h1` per screen. See the maintainer's private notes.
- Files changed: see `CHANGELOG.md`.
- Verification: 43 files, 278 passed, 1 skipped, 0 failed; `npm run check` and all four builds pass; `npm run test:e2e` 132 passed (one of two final runs had 1 Chromium playback timeout under load); release suite 12 passed.
- Follow-ups: real iPhone and LG C1 checks; TV colour tokens; font preloading.

Raouf: 2026-11-15 (Australia/Sydney), sixth entry

- Scope: publish and release `audit/frontend-2026-11-15`, with the owner's approval for a full redeploy.
- Summary: sanitized snapshot pushed to the public repository as a branch; backend release `29d3e328524b-bdc52186` and the same frontend revision are live; migrations 005 and 006 applied; hardened units and an HSTS header installed. See the maintainer's private notes.
- Files changed: the maintainer's private notes, the maintainer's private notes, `CHANGELOG.md`, this file.
- Verification: rehearsal on the server before switching (configuration, volume check, migrations on a database copy, FFmpeg in the new sandbox); 9 of 9 edge checks; host health checks; sign-in page in two browsers. No rollback was needed.
- Follow-ups: exercise the signed-in screens on production; remove the rollback material from the server later; rebuild the TV package.

Raouf: 2026-11-15 (Australia/Sydney), seventh entry

- Scope: switch audio and subtitles in films with several, and automatic pictures for every film, on `audit/frontend-2026-11-15`.
- Summary: all-languages HLS editions switch language in place; a subtitle menu follows the saved language; the worker makes posters and stills from each film's cover or frames; optional TMDB posters behind `MOV_TMDB_TOKEN`. 14 review findings fixed. See `CHANGELOG.md` and the maintainer's private notes.
- Files changed: see `CHANGELOG.md`.
- Verification: 46 files, 300 passed, 1 skipped, 0 failed; `npm run check`, all four builds and the release suite pass; `npm run test:e2e` 146 of 147 (one Firefox timeout under load, 36 of 36 on repeat).
- Follow-ups: release migration 007 with API, worker and frontend together; TMDB logo in the credits before enabling it; let the edge and Nginx pass picture caching.

Raouf: 2026-11-15 (Australia/Sydney), eighth entry

- Scope: publish and release the language, subtitle and picture work, at the owner's request.
- Summary: sanitized snapshot pushed; backend `aae2f72c0a54-a680efab` and the same frontend revision are live; migration 007 applied; pictures made for all five films. See the maintainer's private notes.
- Files changed: the maintainer's private notes, the maintainer's private notes, `CHANGELOG.md`, this file.
- Verification: server rehearsal (migration on a copy, two-language edition, pictures), 9 of 9 edge checks, host checks, sign-in page in two browsers; no rollback needed.
- Follow-ups: signed-in check of the new menus on production; TMDB logo before enabling TMDB; clear old rollback material.

Raouf: 2026-11-15 (Australia/Sydney), ninth entry

- Scope: two problems reported on the live site.
- Summary: generations now follow content (Drive's `version` changed several times an hour and caused films to be prepared again and playback to end); stale editions are pruned; the audio menu shows for every film and stays with the picture in full screen.
- Files changed: see `CHANGELOG.md`.
- Verification: 46 files, 302 passed, 1 skipped; `npm run check`; 150 browser tests passed.
- Follow-ups: released as `e58d8f59578d`; see the maintainer's private notes.

Raouf: 2026-11-15 (Australia/Sydney), tenth entry

- Scope: the owner found the audio option locked.
- Summary: background planning builds all-languages editions for films that only have one-language copies; a one-language film states its language instead of showing a disabled menu.
- Files changed: `apps/api/src/media/planner.ts`, `apps/web/src/pages/Player.tsx`, `apps/web/src/cinema.css`, tests, logs.
- Verification: `npm run check`; 301 of 302 unit tests (one load-timing failure in the untouched cache test, 5 of 5 on repeat); 150 browser tests.
- Follow-ups: release.

Raouf: 2026-11-15 (Australia/Sydney), eleventh entry

- Scope: audit and restyle the language picker at the owner's request.
- Summary: one Audio & subtitles button and panel (Audio, Subtitles, Picture) in the site's style, replacing three browser menus; readable names; keyboard, full screen and phone sheet.
- Files changed: see `CHANGELOG.md`.
- Verification: 47 files, 304 passed, 1 skipped; `npm run check`; 150 browser tests.
- Follow-ups: release together with the background all-languages editions.

Raouf: 2026-11-15 (Australia/Sydney), twelfth entry

- Scope: release the panel and background all-languages editions, approved by the owner.
- Summary: backend `75c9f12bd716-e9092872` and Worker version `7e63af83` are live. Before activating, a live eviction of every prepared film was traced to a 2160p encode of the 4K film under the previous release; activation waited for it to finish. See the maintainer's private notes.
- Files changed: the maintainer's private notes, the maintainer's private notes, `CHANGELOG.md`, this file.
- Verification: rehearsal, 9 of 9 edge checks, 12 release tests, sign-in page in two browsers, Sentinel host checks; no rollback needed.
- Follow-ups: room check before eviction; warn in the Picture list that a 4K encode replaces the other prepared films; signed-in check on production; clear old rollback material.
- Rule: before activating a release, read the live job queue. A restart throws away a running encode, so wait until no long encode is running and no one is watching.

Raouf: 2026-11-16 (Australia/Sydney), thirteenth entry

- Scope: the panel release's two follow-ups, and preparation speed.
- Summary: identical editions under another quality's name are reused, ready or in progress; the worker checks room before evicting; the Picture list shows each choice's consequence from server disk figures.
- Files changed: see `CHANGELOG.md`.
- Verification: 48 files, 309 passed, 1 skipped; `npm run check`; 153 browser tests.
- Follow-ups: release; rehearse `pictureChoices` against a copy of the live database first.
- Rule: an edition's identity includes its quality name. Two names can mean the same plan, so look for a twin (`sameEditions`) before making anything.

Raouf: 2026-11-16 (Australia/Sydney), fourteenth entry

- Scope: release the same-copy and room work, approved by the owner.
- Summary: backend `e49e0c964e69-9f306da6` and Worker version `a019a0f0` are live. See the maintainer's private notes.
- Files changed: the maintainer's private notes, the maintainer's private notes, `CHANGELOG.md`, this file.
- Verification: rehearsal on a copy of the live database, 9 of 9 edge checks, 12 release tests, sign-in page in two browsers, Sentinel host checks; no rollback needed.
- Follow-ups: signed-in check of the Picture list on production; clear old rollback material.
- Rule: run the release tests before the deploy, then restore `docs/testing/screenshots/login-production-1488.png`; the deploy refuses an uncommitted tree.

Raouf: 2026-11-16 (Australia/Sydney), fifteenth entry

- Scope: bring every log and Zurvan up to date.
- Summary: operations guide describes shared editions, room and Picture costs; release records and the guide ingested into Zurvan with claims and decisions under `mov`.
- Files changed: the maintainer's private notes, `CHANGELOG.md`, this file.
- Verification: each claim's quote was accepted as verbatim by Zurvan; every RAVAN decision page carries `project: "mov"`.
- Rule: Zurvan keys ingested files by path, and another project's the maintainer's private notes already holds that key. Ingest RAVAN's guide as a copy under `raw/docs/` with a `ravan-` name.

Raouf: 2026-11-16 (Australia/Sydney), sixteenth entry

- Scope: second full backend audit, with fixes, on `audit/backend-2026-11-16`.
- Summary: 11 findings fixed. The main one: films with several audio tracks could not be played in the web player, because the media route refused the files of an all-languages edition. Also Drive hiccups and usage limits ending playback, the saved audio language matched two ways, films whose sound outruns their picture, a stop that hung, and faults that left no trace. See the maintainer's private notes.
- Files changed: see `CHANGELOG.md`.
- Verification: 50 files, 326 passed, 1 skipped; `npm run check`, all three builds and `npm run fixtures` pass; `npm run test:e2e` 153 passed; two independent reviews.
- Follow-ups: release (owner's approval), then clear queued forced re-encodes and play a two-language film signed in; R-20 (player asks for a re-encode after any failed start); R-26 (television and the `null` origin) on a physical set; continuous integration.
- Rule: a feature that crosses the worker and the API is not tested until one test crosses with it. Extend `tests/backend/end-to-end.test.ts`.

Raouf: 2026-11-16 (Australia/Sydney), seventeenth entry

- Scope: release the second-audit fixes, approved by the owner.
- Summary: backend `89ed78bc12ad-7de5ef21` and Worker version `2ccce3c7` are live. The rehearsal showed the main defect had been hit on production that morning. See the maintainer's private notes.
- Files changed: the maintainer's private notes, the maintainer's private notes, the maintainer's private notes, `CHANGELOG.md`, this file.
- Verification: rehearsal on a copy of the live database and the real prepared files, 9 of 9 edge checks, 12 release tests, sign-in page in two browsers, Sentinel host checks; no rollback needed.
- Follow-ups: signed-in play of a two-language film on production; clear old rollback material; publish the sanitized snapshot if wanted.
- Rule: rehearse a media fix by reading the real prepared files through the staged code (session, `authorizeMedia`, `servePlaylist`, `localReader`), not only by planning. Planning alone passed five rehearsals while nothing could be played.

Raouf: 2026-11-16 (Australia/Sydney), eighteenth entry

- Scope: red-team exercise on the whole project, on `audit/backend-2026-11-16`.
- Summary: no attack reached the library or ran script in the owner's browser. Eleven worked in lesser ways and ten are fixed: the origin key could be walked round with `%2f..` paths (confirmed on the live origin), strangers could end a sign-in, a paired screen could flood the conversion queue, a cover image or caption track could exhaust memory or freeze the player, FFmpeg held the service's secrets, and "Disconnect this TV" revoked nothing. See the maintainer's private notes.
- Files changed: see `CHANGELOG.md`.
- Verification: 53 files, 337 passed, 1 skipped; `npm run check`; all four builds; 153 browser tests; 12 release tests.
- Follow-ups: release (owner's approval), including the new Nginx rule; decide RT-10 (how paired screens are approved and kept); the lower open items in section 5 of the report.
- Rule: when two layers each decide on a request's path, test that they read it the same way, with the path sent over a real socket as written. `app.inject` and URL parsers tidy paths before the code under test sees them.

Raouf: 2026-11-16 (Australia/Sydney), nineteenth entry

- Scope: release the red-team fixes, approved by the owner.
- Summary: backend `b0dab6b8d873-c4619299`, Worker version `53ad7734` and one Nginx rule are live. See the maintainer's private notes.
- Files changed: the maintainer's private notes, the maintainer's private notes, the maintainer's private notes, `CHANGELOG.md`, this file.
- Verification: rehearsal on a copy of the live database, the crafted addresses retried on the server and from outside, 9 of 9 edge checks, 12 release tests, sign-in page in two browsers, Sentinel host checks; no rollback needed.
- Follow-ups: the owner signs in on production; rebuild the television package; clear old rollback material.
- Rule: a private document named in a test comment or in the changelog stops the public export. Name the report in words, not by path, anywhere outside `docs/`.

Raouf: 2026-11-19 (Australia/Sydney), twentieth entry

- Scope: audit and speed pass on the reading room, at the owner's request, on `audit/backend-2026-11-16` over the uncommitted worker-backed reading work.
- Summary: book verification reuses Drive's answer for five seconds (`verifyReading(id, fresh)`); the worker warms three blocks at once; the browser fetches ranges in parallel, prefetches whole archive entries, and keeps the neighbouring pages (`apps/web/src/reading/pages.ts`) and the next PDF page rendered.
- Files changed: see `CHANGELOG.md`.
- Verification: 59 files, 357 passed, 1 skipped; `npm run check`; `npm run build`, `npm run build:web`; 30 reader browser tests across three engines.
- Follow-ups: commit, then release with the worker-backed reading work (owner's approval); time a first page and a page turn on production against a real Drive book.
- Rule: books follow the films' verification rule. Pass `fresh` to `verifyReading` whenever the answer must postdate bytes just fetched, and test a change or revocation by moving the clock past `VERIFY_REUSE_MS`, not by asking again at once.
- Rule: `PageCache` owns the pages it hands out. The reader never releases a page; `keep` and `dispose` do.

Raouf: 2026-11-19 (Australia/Sydney), twenty-first entry

- Scope: release the worker-backed and faster reading work, approved by the owner.
- Summary: backend `3653ae1075d7-35f5e79f` (schema 10) and Worker version `a918a3ca` are live. See the maintainer's private notes.
- Files changed: the maintainer's private notes, the maintainer's private notes, `CHANGELOG.md`, this file.
- Verification: rehearsal on a copy of the live database, 12 release tests, 9 of 9 edge checks, Sentinel host checks; no rollback needed.
- Follow-ups: the owner times a first page and page turns on production; clear old rollback material.
- Rule: time reader changes with the maintainer's timing harness, kept outside the repository (real API and web client, simulated Drive latency), before and after; the unit tests count Drive calls but not milliseconds.

Raouf: 2026-11-19 (Australia/Sydney), twenty-second entry

- Scope: second speed pass on the reading room, at the owner's request.
- Summary: book blocks are fetched from Drive as four parallel parts (`BOOK_BLOCK_PARTS`); opening a book warms its missing blocks in the API (`OpenWarmer`); slice spans and slice batches run four at a time. Cold first page in the local benchmark: 26.2 s to 3.2 s at production's per-connection Drive rate.
- Files changed: see `CHANGELOG.md`.
- Verification: 59 files, 361 passed, 1 skipped; `npm run check`; both builds; 30 reader browser tests.
- Follow-ups: release (owner's approval); then compare per-block times in `cache_blocks` for newly prepared books against the 3.5 to 4 s seen on 19 November, which tests the per-connection assumption.
- Rule: the benchmark simulator has no shared bandwidth limit, so more lanes always look faster there. Set `BENCH_BYTES_PER_MS` from production block timings, and keep Drive connections bounded (open warming 4 x 4 parts, worker 3 x 4).

Raouf: 2026-11-19 (Australia/Sydney), twenty-third entry

- Scope: release the second reading speed pass, approved by the owner.
- Summary: backend `ff6678f01250-e3f57cff` and Worker version `17e64b55` are live. See the maintainer's private notes.
- Files changed: the maintainer's private notes, the maintainer's private notes, `CHANGELOG.md`, this file.
- Verification: rehearsal on a copy of the live database, 12 release tests, 9 of 9 edge checks, Sentinel host checks; no rollback needed.
- Rule: book jobs may run during activation. They resume from stored blocks, so the activation guard counts only viewers and film jobs (`kind<>'reading'`).

Raouf: 2026-11-19 (Australia/Sydney), twenty-third entry, continued

- Scope: push, approved by the owner.
- Summary: sanitized snapshot of `7e3be95` pushed as `public/fast-reader-2026-11-19` (`9cd19a8`); the private branch stays local.
- Verification: export assertions passed; secret scan clean.
- Rule: before exporting, search `AGENT.md` and `CHANGELOG.md` for `.local/`. The export's forbidden list does not catch paths outside the repository.

Raouf: 2026-11-19 (Australia/Sydney), twenty-fourth entry

- Scope: check the reading room against current documentation (PDF.js 6.5, zip.js 2.25, DOMPurify 3.4, Drive API), audit and polish, at the owner's request.
- Summary: fixed EPUB attributes removed by DOMPurify; Drive rate limits use Google's backoff with a shared pause; book downloads are capped at 24 with reader-first priority; dropped PDF pages are released; zip.js reads past the end are truncated.
- Files changed: see `CHANGELOG.md`.
- Verification: 59 files, 364 passed, 1 skipped; `npm run check`; both builds; 30 reader browser tests.
- Follow-ups: release (owner's approval); measure per-block Drive times on production; try PDF.js worker rendering behind a test in all three engines.
- Rule: a custom DOMPurify `ALLOWED_URI_REGEXP` applies to every allowed attribute outside the URI-safe list. Add plain-text attributes to `ADD_URI_SAFE_ATTR`, and test that they survive.
- Rule: retry a Drive rate limit (429, `usageLimits`, `RESOURCE_EXHAUSTED`) with Google's backoff, and a server error with the short retry. Never treat either as a verdict on the file.

Raouf: 2026-11-19 (Australia/Sydney), twenty-fifth entry

- Scope: release and publish the reading documentation audit, approved by the owner.
- Summary: backend `92019068e456-84496e2c` and Worker version `eafcdd9d` are live. See the maintainer's private notes. Published as public `de19838` on `public/fast-reader-2026-11-19`.
- Files changed: the maintainer's private notes, the maintainer's private notes, `CHANGELOG.md`, this file.
- Verification: rehearsal on a copy of the live database, 12 release tests, 9 of 9 edge checks, Sentinel host checks; no rollback needed.
- Follow-ups: when the owner opens a book that is not stored, read its per-block times in `cache_blocks` (before parallel parts: 3.5 to 4 s per block); signed-in timing of the first page and page turns; clear old rollback material.

Raouf: 2026-11-21 (Australia/Sydney), twenty-sixth entry

- Scope: the owner reported that dragging the mouse over reader text glitched; audit and fix.
- Summary: a drag that left the scrolling page for the top bar or footer made every engine select to the end of the chapter or into the bar. `containSelection` now keeps the selection end on the nearest line inside the page, before paint, and keeps the start.
- Files changed: see `CHANGELOG.md`.
- Verification: `npm run check`; 59 files, 364 passed, 1 skipped; new browser test fails without the fix and passes in three engines.
- Follow-ups: release (owner's approval). Owner to confirm on a real book in their browser. Manga images can be dragged as images; PDF pages have no selectable text.
- Rule: test a selection fix by measuring the selection after the pointer crosses each edge, in all three engines. CSS on the bars (`user-select`, `pointer-events`) does not stop the jump in Chromium or WebKit.

Raouf: 2026-11-21 (Australia/Sydney), twenty-seventh entry

- Scope: the owner asked to fix the drag audit's two findings and to give books server-made thumbnails like the films', checked against current documentation.
- Summary: the worker makes a cover per book (EPUB cover, CBZ first page, PDF page 1 via PDF.js in Node) from ranged reads of at most 48 MiB, stored in `reading_covers` (migration 11) and shown on the shelf. PDF pages carry a selectable PDF.js text layer. Manga pages cannot be dragged.
- Files changed: see `CHANGELOG.md`.
- Verification: `npm run check`; 60 files, 373 passed, 1 skipped; both builds; 198 browser tests in three engines; built code makes a PDF cover under plain Node.
- Follow-ups: release (owner's approval, includes migration 11). Confirm `@napi-rs/canvas-linux-x64-gnu` is in the server's `node_modules` before switching. Watch the first cover pass on production for Drive quota and time per book.
- Rule: run a new picture job's code from `dist` under plain Node before release; `tsx` and the tests resolve modules differently.
- Rule: never run a regular expression over a whole file from a book or film. Find tags with `indexOf`, cap their number and length, and match patterns only on the short pieces. Test with a large malformed input.

Raouf: 2026-11-21 (Australia/Sydney), twenty-eighth entry

- Scope: release and publish the book covers work, approved by the owner.
- Summary: backend `7bd893135c64-09f29870` (schema 11) and Worker version `6a997e30` are live; see the maintainer's private notes. A background security review of the first release found a backtracking scan of EPUB packages; fixed and released the same evening. Published as public `50c572d` on `public/book-covers-2026-11-21`.
- Files changed: the maintainer's private notes, the maintainer's private notes, `docs/reading-room.md`, `CHANGELOG.md`, this file.
- Verification: rehearsal in the worker's sandbox, covers made by the staged code, 12 release tests, 9 of 9 edge checks twice, Sentinel host checks, clean journal.
- Follow-ups: find why a PDF cover takes two to four minutes on production; the owner to check covers, PDF selection and the drag fix signed in.
- Rule: a public doc must not name a private one (the maintainer's private notes, `docs/testing/*.md`); the export refuses it. Only `CHANGELOG.md`, `AGENT.md` and `docs/backend-usage.md` are rewritten automatically.
- Rule: the activation guard may ignore `book-cover` jobs as it ignores `reading` ones; a stop returns them to the queue.

Raouf: 2026-11-22 (Australia/Sydney), twenty-ninth entry

- Scope: the owner reported that only a few book covers had been made after the covers release.
- Summary: a read-only look at production found 4 of 13 covers, 9 jobs failed three times, and 12 worker crashes. The API never finished a range response whose last chunk was exactly the body's 64 KiB buffer (`raw-route.ts` aborted, and so destroyed, the body as its source finished); PDF.js reads in 64 KiB pieces. After each 120 second read timeout PDF.js, destroyed mid-load, threw into an unhandled promise and ended the worker process. Fixed both; PDF pages are drawn in their own thread; `BOOK_COVER_VERSION` 2 asks again for missing covers.
- Files changed: see `CHANGELOG.md`.
- Verification: `npm run check` clean. New tests fail on the old code and pass: `raw-route.test.ts` (times out before), two PDF cover tests (hung before). Book cover tests 12 of 12. Full suite: 372 passed, 1 skipped, 5 timed out while another session held the machine at load 28; those 4 files pass alone (40 of 40). The built cover code under plain Node makes a cover and keeps a failed read's own error. Reader browser tests in Chromium: 11 passed, 3 failed on 5 second waits at load 43; they mock `/api` in the page and do not reach the changed code.
- Follow-ups: release (owner's approval). After it, confirm the 9 covers are made and the worker does not restart.
- Rule: a stream's source must not destroy the stream on normal completion. Test range responses at exactly the stream's high-water mark, fresh and cached.
- Rule: run PDF.js in Node only in a worker thread. Destroying a loading document throws into an unhandled promise (PDF.js 6.5), which ends the process.

Raouf: 2026-11-22 (Australia/Sydney), thirtieth entry

- Scope: release and publish the cover reads fix, approved by the owner.
- Summary: backend `98762ef4a832-74b72b75` is live; see the maintainer's private notes. All 13 PDF covers made after activation, zero worker restarts.
- Files changed: the maintainer's private notes, the maintainer's private notes, `CHANGELOG.md`, this file.
- Verification: rehearsal with a real failed production PDF, 9 of 9 edge checks, Sentinel host checks, clean journal.
- Follow-ups: the owner to check covers, PDF selection and the drag fix signed in.
- Rule: when the live API has a known fault the fix removes, a rehearsal that reads through it must avoid the fault (here, pieces under 64 KiB), or it tests the old API, not the staged code.
- Rule: build release archives with `COPYFILE_DISABLE=1` so macOS extended attributes stay out of them.

Raouf: 2026-11-22 (Australia/Sydney), thirty-first entry

- Scope: the owner said RAVAN does not work on their LG C1 and asked for it to work there and in current browsers.
- Summary: the web build targeted `es2022`, so Chromium 79 could not parse the entry script and showed an empty page. The build now targets Chromium 79; `legacy.ts` fills in three abort functions and flex `gap`; posters and the reader have CSS fallbacks; a checker guards every Cloudflare build. Details in `CHANGELOG.md`.
- Files changed: see `CHANGELOG.md`.
- Verification: `npm run check` clean. `npx vitest run`: 381 passed, 1 skipped. `npx playwright test`: 201 passed in Chromium, Firefox and WebKit. The new build test fails on the old config. `npm run build:cloudflare` passes the check. Real Chromium 79.0.3945.0 (Linux snapshot, run on the owner's own droplet under `/root`, libraries unpacked there, removed afterwards), driven over DevTools: the live demo throws `SyntaxError: Unexpected token '?'` and renders nothing; the new demo build renders the library (6 posters, 338 px tall as in current engines, pictures loaded), the film page and the player, with no errors, and menu and button spacing within 1 px of current Chromium.
- Follow-ups: release the web client (Cloudflare only, the server is unchanged) with the owner's approval; then try it on the TV itself and play a film there; decide whether PDF books matter on the TV (PDF.js legacy build or a message).
- Rule: a test that builds a client under Vitest must set `NODE_ENV=production`; Vitest's `test` value builds React's development copy, which is not what ships.
- Rule: headless Chromium 79's `--screenshot` with `--virtual-time-budget` stops animations part way and misses pictures; drive it over DevTools for a true picture.

Raouf: 2026-11-22 (Australia/Sydney), thirty-second entry

- Scope: the owner asked to check the current documentation and fix everything left on the LG C1.
- Summary: fixed reading progress that never saved on Chromium 79 (refused keepalive), hover rules lost with `:focus-visible`, missing focus rings, `:is()`/`:has()` rules, shelf and thumbnail shapes, `replaceChildren` and listener `signal`; PDF books now say they need a newer browser. The checker reads CSS too. Details in `CHANGELOG.md`.
- Files changed: see `CHANGELOG.md`.
- Verification: `npm run check` clean, Prettier clean. `npx vitest run`: 389 passed, 1 skipped. `npx playwright test`: 201 passed in Chromium, Firefox and WebKit. `npm run build:cloudflare` passes the Chromium 79 check. Real Chromium 79.0.3945.0 on the owner's own droplet (under `/root`, removed afterwards) against the production build and a fake API: focus ring by Tab (3 px), poster hover lift, shelf covers 193 × 290 and 163 × 245 on a phone, EPUB opens, turns and closes with the header restored, CBZ page shown, PDF message shown, no page errors. The WebKit dev-server line "Importing a module script failed" appears on the previous code too.
- Follow-ups: release the web client (Cloudflare only) with the owner's approval, then play a film on the TV. Rendering PDF pages on the server for old browsers would make PDFs readable on the C1; it is a backend feature and needs the owner's decision.
- Rule: a request that sets `keepalive` must survive Chromium before 81 refusing it unsent. Only idempotent requests may use it.
- Rule: to test a lazy chunk in Chromium 79, drive it over DevTools against the production build; headless `--screenshot` timing misleads.

Raouf: 2026-11-22 (Australia/Sydney), thirty-third entry

- Scope: commit, release and publish the LG C1 work, approved by the owner.
- Summary: web-only release; Worker version `55740333-7466-4ecf-9bfc-9937ebb8c338` from `7dfa5248afd7`. Backend unchanged at `98762ef4a832-74b72b75`. See the maintainer's private notes.
- Files changed: the maintainer's private notes, the maintainer's private notes, `CHANGELOG.md`, this file.
- Verification: 12 release tests, 9 of 9 edge checks, live assets pass `check-legacy-browsers.mjs`, live demo in real Chromium 79 with no page errors.
- Follow-ups: the owner to try the C1: play a film, open an EPUB and confirm the reading position is kept.
- Rule: after a web release, run `node scripts/check-legacy-browsers.mjs` on the live page's and live demo's downloaded assets; it confirms what is served, not only what was built.
- Published: private `523e783` as public `7238df6` on `public/lg-c1-2026-11-22` (based on `public/cover-reads-2026-11-22`), gitleaks clean.
- Rule: the export refuses a host id such as the droplet's in `AGENT.md`; name the owner's machines in words in log entries.

Raouf: 2026-11-22 (Australia/Sydney), thirty-fourth entry

- Scope: the owner tried the LG C1 release on the TV.
- Summary: the owner reported that RAVAN works on the C1 and shows video, through the TV's own browser. Documents updated to match; the packaged TV app stays unverified.
- Files changed: `README.md`, `docs/implementation-status.md`, `docs/tv-installation.md`, the maintainer's private notes, `CHANGELOG.md`, this file.
- Verification: the owner's report on the TV; no code changed.
- Follow-ups: the owner to open an EPUB on the TV and confirm the position is kept after closing; decide whether server-drawn PDF pages are worth building for the C1; the packaged TV app's physical acceptance.
- Rule: the C1's browser is now a supported client. Keep `npm run check:legacy` and the `build:cloudflare` guard passing; a regression there blanks the owner's TV.

Raouf: 2026-11-22 (Australia/Sydney), thirty-fifth entry

- Scope: the owner asked for a next-episode option with a design of its own, after checking current guidance.
- Summary: titles now follow Drive renames (32 of 43 production films showed old download names); films named as episodes know the next one in their folder; the player offers it in the last 30 seconds and, at the end, as a ten-second copper line the owner can stop or turn off with one press. Details in `CHANGELOG.md`.
- Files changed: see `CHANGELOG.md`.
- Verification: `npm run check` clean, Prettier clean. `npx vitest run`: 396 passed, 1 skipped. `npx playwright test`: 213 passed in Chromium, Firefox and WebKit. `npm run check:legacy` passes. Real Chromium 79 on the owner's own droplet (removed afterwards): end panel, focus, Enter, autoplay and session replacement, no page errors. Screens checked at 1440 and 390 px.
- Follow-ups: release (backend with migration 12, and web together: the client sends `autoplayNext`, which the old API refuses) with the owner's approval; the next scan then renames the 32 films. Next episode in the packaged TV app; chaining a season's last episode to the next season's folder.
- Rule: a fake media address in a test must start with `/media/s/`; the adapter refuses any other as untrusted, which reads like a playback bug.

Raouf: 2026-11-22 (Australia/Sydney), thirty-sixth entry

- Scope: the owner asked for a play control in the middle of the picture, a working full-screen button, and a player upgrade from current guidance with a design of RAVAN's own.
- Summary: RAVAN's own controls replace the browser's: the copper line over the Ā as the seek line with the macron as playhead, click in the middle to play or pause with a drawn copper ring, pause as an intermission, a bar that fades and returns, and full screen of the frame with a picture-alone fallback. Video.js 10 was ruled out (Chrome 111+, no TVs). Details in `CHANGELOG.md`.
- Files changed: see `CHANGELOG.md`.
- Verification: `npm run check` clean, Prettier clean. `npx vitest run`: 396 passed, 1 skipped. `npx playwright test`: 223 passed, 2 skipped (the full-screen fallback outside Chromium). `npm run check:legacy` passes. Real Chromium 79 on the owner's own droplet (removed afterwards): click to pause and play, ring, intermission, seek, fade and wake, focus ring, no page errors. Screens checked at 1440 and 390 px.
- Follow-ups: release together with the next-episode work (owner's approval); the owner to try full screen on the C1 (headless Chromium 79 cannot complete one).
- Rule: headless Chromium 79 never settles `requestFullscreen()`; test full screen in a current engine and on the TV.
- Rule: with no `controls`, a video cannot take focus. Tests that need the player's shortcuts blur the active element instead of focusing the video.

Raouf: 2026-11-22 (Australia/Sydney), thirty-seventh entry

- Scope: release and publish the next-episode, Drive-title and player-controls work, approved by the owner.
- Summary: backend `0b5f319bd4ae-9e5c2d44` (schema 12) and Worker `8c6d623e-5b12-470e-a258-89872a81687a` are live. See the maintainer's private notes.
- Files changed: the maintainer's private notes, the maintainer's private notes, `CHANGELOG.md`, this file.
- Verification: rehearsal in the worker's sandbox with the staged API on a live copy, activation with no viewers or jobs, schema 12 and 40 of 40 Drive titles after, Sentinel host checks, 12 release tests, 9 of 9 edge checks, live assets checked for Chromium 79.
- Follow-ups: the owner to try full screen and an episode ending into the next on the C1.
- Rule: a release whose lock adds only development packages may reuse the installed `node_modules`; compare the lock's production entries (packages without `dev`, and the root without `devDependencies`) instead of the whole file.
- Rule: the unattended scan does nothing when Drive reports no change, so a rule that changes how existing rows are read from Drive needs a migration to apply it, or it waits for a manual refresh.
- Published: private `4b3d05f` as public `791dfed` on `public/next-episode-2026-11-22` (based on `public/lg-c1-2026-11-22`), gitleaks clean.

Raouf: 2026-11-22 (Australia/Sydney), thirty-eighth entry

- Scope: the owner asked to update all logs and Zurvan after the next-episode and player-controls release.
- Summary: README and the visual design document describe next episode, titles following Drive and the new controls; Zurvan has the release record, the design note and claims from them.
- Files changed: `README.md`, `docs/visual-design.md`, `CHANGELOG.md`, this file.
- Verification: Prettier clean; Zurvan search returns the new claims after the rebuild.
- Follow-ups: the owner to try full screen and an episode ending into the next on the C1. These document changes reach the public repository with the next published snapshot.

Raouf: 2026-11-22 (Australia/Sydney), thirty-ninth entry

- Scope: the owner asked for the reading room to be foldered like the films.
- Summary: `/api/reading?folder=` lists a folder's books, its folders as cards and the way back, and at the top the books being read; the web reading room browses `#/reading/folder/<id>`, folders drawn as stacks of volumes. Production's 55 books sit in Berserk (42) and Oyasumi Punpun (13). No schema change. Details in `CHANGELOG.md`.
- Files changed: see `CHANGELOG.md`.
- Verification: `npm run check` clean, Prettier clean. `npx vitest run`: 64 of 65 files passed; `formats.test.ts` timed out at 15 s with the machine's load average near 31 and passes alone with a longer limit (20 of 20), and touches no changed code. `npx playwright test --workers=2`: 223 passed, 3 failed, 2 skipped, at load averages of 31 to 55; the three pass when run again (two together, the WebKit fade test alone). `npm run check:legacy` passes. Screens checked at 1440 and 390 px.
- Follow-ups: release (API and web together) with the owner's approval. The disk ran out during the browser run (ENOSPC on the volume holding Claude Code's temporary files; mostly other projects' session files); 2.7 GB were free afterwards. Nothing was deleted.
- Rule: under heavy load, run the browser suite with `--workers=2` and confirm any failure alone before calling it a regression.

Raouf: 2026-11-22 (Australia/Sydney), fortieth entry

- Scope: release and publish the reading room by folder, approved by the owner.
- Summary: backend `bfebb5ed7575-2d0f183c` (schema 12) and Worker `7dcc4cdb-fa87-4f0d-bdb5-d7123e681f57` are live. See the maintainer's private notes.
- Files changed: the maintainer's private notes, the maintainer's private notes, `CHANGELOG.md`, this file.
- Verification: rehearsal with the staged routes on a live copy, activation with no viewers or jobs, Sentinel host checks, 12 release tests, 9 of 9 edge checks, live assets checked for Chromium 79.
- Follow-ups: the owner to check the reading room's folders signed in.
- Rule: a rehearsal can mount `registerReading` with empty stand-ins for the sync and cache when it only exercises list routes; they serve book bytes only.
- Published: private `c5a235d` as public `1a01a5f` on `public/reading-folders-2026-11-22` (based on `public/next-episode-2026-11-22`), gitleaks clean.

Raouf: 2026-11-22 (Australia/Sydney), forty-first entry

- Scope: the owner suspected Berserk's covers were stuck.
- Summary: 30 of 42 Berserk volumes are over 100 MB and were never planned a cover: the planner and the worker's book route used the reading limit. Covers now have their own bound (`MAX_COVER_BOOK_BYTES`, 4 GiB); a cover still reads at most 48 MiB. The reading limit itself still blocks opening those volumes.
- Files changed: see `CHANGELOG.md`.
- Verification: `npm run check` clean, Prettier clean, `npx vitest run` 402 passed, 1 skipped; the new 150 MB test failed before the change.
- Follow-ups: release with the owner's approval (worker and API); the owner to decide on reading books over 100 MB.
- Rule: a size limit belongs to the operation it protects. The reading limit is about holding a book to read it; a cover reads a bounded part of any book.

Raouf: 2026-11-22 (Australia/Sydney), forty-second entry

- Scope: the owner chose to raise the PDF reading limit to 512 MB, released together with the cover fix.
- Summary: `readingLimit(format)`; big PDFs open through ranges only and are never prepared or warmed whole; EPUB and CBZ stay at 100 MB. Details in `CHANGELOG.md`.
- Files changed: see `CHANGELOG.md`.
- Verification: `npm run check` clean, Prettier clean. `npx vitest run --testTimeout=60000`: 404 passed, 1 skipped (after `reading.test.ts`'s oversized PDF became 513 MB). `npx playwright test --workers=2`: 219 passed, 10 failed, 2 skipped at load averages of 58 to 68; the 10 (none in the reading room) pass run one at a time. The new browser test passes in all three engines (Firefox alone). `npm run check:legacy` passes.
- Follow-ups: release with the cover fix; confirm on production that the 30 Berserk covers are made and that a volume over 100 MB opens.
- Rule: a limit copied into the client (`reading-ranges.ts`) must move with the server's; search the whole tree for the constant, not only the server.

Raouf: 2026-11-22 (Australia/Sydney), forty-third entry

- Scope: release the covers for books over 100 MB and the 512 MB PDF limit, approved by the owner.
- Summary: backend `b3fdb50690ad-b71dfdf7` and Worker `fab7267f-17b5-4e0c-8c13-eb75b589cd17` are live. See the maintainer's private notes.
- Files changed: the maintainer's private notes, the maintainer's private notes, `CHANGELOG.md`, this file.
- Verification: rehearsal with the staged worker and routes on a live copy, activation with no viewers or jobs, Berserk covers 12 to 41 of 42 within minutes, 9 of 9 edge checks, live assets checked for Chromium 79, release tests 12 of 12 when run one at a time.
- Follow-ups: confirm the last Berserk cover; the owner to open a volume over 100 MB signed in.
- Rule: run each release step only if the one before passed (`set -e`, or `&&` between steps). A failed release test stops the deploy, even when the failure looks like load.
- Rule: a rehearsal that calls the worker's `queueLibrary` must give it storage in empty temporary folders: planning with storage also sweeps picture files and prunes editions, and must never reach the live folders from a copy of the database.

## Apple client

Build the SwiftUI project with the iPhoneOS SDK and use a connected physical device for hardware testing. See [the build guide](apps/apple/README.md) for the three configurations and isolated fixtures.

The paired build stores device credentials in a device-only Keychain item. The Files build excludes pairing at compile time. An authenticated preparation-status request reads progress without creating a playback lease. Deploy schema 13 with its matching API and worker.
