# Changelog

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
