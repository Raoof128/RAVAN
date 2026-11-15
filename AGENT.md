# Working in this repository

RAVAN is a private, single-owner cinema: a Fastify API, a media worker, a Cloudflare edge Worker, SQLite, and React clients. This file records the rules that keep it safe to change. `CHANGELOG.md` records what changed and how it was verified.

## Before changing code

- Read `README.md`, `docs/backend-usage.md`, the maintainer's private notes and the maintainer's private notes. For the web or TV client, also read `docs/visual-design.md`, the maintainer's private notes and the maintainer's private notes.
- Run `npm run check` and `npm test` first and note anything already failing.
- Work on a branch. Do not push to `main`, deploy, or touch the server without the owner's say-so.
- Publishing goes to the public repository as a sanitized snapshot on a branch, never the private branch. Releasing follows the Releasing section of the maintainer's private notes and needs the owner's approval each time.

## Rules the code depends on

- **Authorize by matched route.** Guards read `request.routeOptions.url`. Never decide on `request.url`: the router decodes a path before matching, so the raw text and the handler can disagree.
- **Every `/api` route is private unless listed** in `publicApiRoutes` in `apps/api/src/auth/routes.ts`. A route a paired device may call must be added to a device set there.
- **A library session is created in one place**, inside the MFA verification transaction in `apps/api/src/auth/mfa.ts`. Google sign-in alone yields only a challenge.
- **State changes need the CSRF token and an exact `Origin`.** `GET` handlers must not change state.
- **Media is authorized per ticket and per chunk.** Paths under a prepared asset come from a 64-hex ID and a filename matched by regular expression.
- **A source's generation follows its content, never Drive's `version`.** `contentKey` in `apps/api/src/drive/membership.ts` (checksum and size, else head revision) decides whether a scan keeps the generation and whether verification accepts a file. `version` rises with any change to Drive's record of the file; using it re-prepared films and ended playback.
- **Drive verification may be reused for five seconds, except after a read.** `verifySource(id, true)` must be used whenever the answer has to postdate bytes just fetched.
- **Subprocesses take fixed argument arrays** with `shell: false`, protocol and format allowlists, and a timeout. Never store or return FFmpeg stderr; classify it to a fixed code.
- **Errors leave the API as `{ "error": "<code>" }`** with no paths, filenames, tokens or upstream messages.
- **Logging stays off for requests.** Tickets and OAuth codes travel in URLs.
- **Migrations are immutable and append-only.** Add a new numbered file and list it in `packages/db/src/migrate.ts`.
- **A job interrupted by a service stop or by a viewer's newer request is released, not failed.** Only real failures and crashes spend attempts.
- **A client's capability report is a claim.** It may shape that client's own request. It is stored for background planning only when the request is authenticated by the owner's browser session, never because of a profile name.
- **No capabilities means the previous behaviour and the previous asset ids.** An edition only some clients can play carries a `variant` in its asset id and must never replace the universal H.264 one.
- **FFmpeg never receives the worker key.** It gets a grant for one file. Do not put any long-lived credential on a command line.
- **A playlist is served only in the exact form this server writes.** `parsePlaylist` in `apps/worker/src/hls.ts` is the gate; a player fetches every address a playlist names. Never serve a playlist, or add a tag, without going through it.
- **An edition being written is offered only in state `streaming`, and withdrawn on any failure.** Its files appear only when complete (`temp_file`); do not write into an edition's directory any other way.
- **The API and worker ship together.** They share the database schema and the `/_worker` protocol.

## Rules the interface depends on

- **Show only what the server sent.** A preparation step comes from `phase`, a bar from `progress`, a sentence from `reason`. No time remaining, speed, queue position or percentage may be computed or guessed in the client. `apps/web/src/player/Preparing.tsx` is the one place this is drawn, for web and TV.
- **Never hold a screen back for an animation.** The opening screen in `apps/web/index.html` goes when the session answers. Placeholders appear only after `useDelayed`.
- **Loading uses the primitives in `packages/ui/src/Loading.tsx`.** Do not add another spinner, shimmer or skeleton. Animate `opacity` and `transform` only.
- **Every animation needs a still form.** Both `prefers-reduced-motion` and `:root[data-motion="reduce"]` set `animation: none`; an element whose base style is invisible until its animation runs will stay invisible. Write keyframes from the hidden state, not to the visible one, or add an explicit reset.
- **`index.html` may carry inline CSS but no inline script.** The content security policy is `script-src 'self'`.
- **Browser storage holds the motion flag (`ravan:motion`) and the TV's device credential, nothing else.** Never an MFA secret, a session token or library data.
- **A control whose action is running stays focusable.** Use `ActionButton` and `usePending`; do not set `disabled` on it. When an action removes the focused control, move focus somewhere deliberate.
- **Anything the TV loads must run on Chromium 79.** The build lowers script syntax and `inset`; it does not lower flex `gap`, `aspect-ratio`, `:focus-visible`, `:is()` or `:where()`. `tv.css` and `loading.css` avoid them; shared rules in `tokens.css` that use them are overridden in `tv.css`.
- **TV focus ids are a contract.** `data-focus-id` values are what remote navigation and its tests use. While the transport is hidden, the key that reveals it must do nothing else.
- **One link per film card.** The poster link covers the card; the title is a heading, not a second link.
- **Text an owner needs is at least 11 px, targets at least 24 by 24 px, control outlines `var(--control)`.** `tests/e2e/loading.spec.ts` measures all three on every screen from 320 to 3840 px.
- **`PlayerController.ts` and `BrowserAdapter.ts` own tickets, sessions and recovery.** Interface work goes around them, in the pages.
- **Type sizes are in rem; colours for text come from tokens.** `--text`, `--text-soft`, `--muted`, `--accent`, `--success`, `--danger`. `tests/clients/design-rules.test.ts` fails on a px type size or a new raw text colour. The TV stylesheet is exempt: it is a fixed 1080p layout.
- **Icons come from `packages/ui/src/Icon.tsx`.** Do not type ▶, ↗ or similar characters as icons; devices draw them differently, some as emoji.
- **Fields are 16 px where a finger is the pointer, and non-inline targets 44 px on a phone.** `tests/e2e/ux.spec.ts` measures both.
- **Navigation goes through `apps/web/src/router.tsx`.** It numbers history entries and restores scroll on Back. Do not call `window.scrollTo` on route change elsewhere. A "back to…" link uses `returnTo` so it does not push a second copy of the screen.
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
