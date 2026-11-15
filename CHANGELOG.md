# Changelog

## Raouf: 2026-11-15 (Australia/Sydney) — prepared films kept; audio menu always shown

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

- Release to the server. The first scan after it records the content of each film; generations do not change for films whose checksum is unchanged.

## Raouf: 2026-11-15 (Australia/Sydney) — languages and pictures released

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

## Raouf: 2026-11-15 (Australia/Sydney) — switch language and subtitles; automatic film pictures

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

## Raouf: 2026-11-15 (Australia/Sydney) — released to production

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

## Raouf: 2026-11-15 (Australia/Sydney) — UI and UX audit against the rule set

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

## Raouf: 2026-11-15 (Australia/Sydney) — frontend audit: loading, preparation states, accessibility

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

## Raouf: 2026-11-15 (Australia/Sydney) — watch a film while it is prepared

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

## Raouf: 2026-11-15 (Australia/Sydney) — faster preparation and the remaining audit findings

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

## Raouf: 2026-11-15 (Australia/Sydney) — backend audit and remediation

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
