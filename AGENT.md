# Working in this repository

RAVAN is a private, single-owner cinema: a Fastify API, a media worker, a Cloudflare edge Worker, SQLite, and React clients. This file records the rules that keep it safe to change. `CHANGELOG.md` records what changed and how it was verified.

## Before changing code

- Read `README.md`, `docs/backend-usage.md`, the maintainer's private notes and the maintainer's private notes.
- Run `npm run check` and `npm test` first and note anything already failing.
- Work on a branch. Do not push to `main`, deploy, or touch the server without the owner's say-so.

## Rules the code depends on

- **Authorize by matched route.** Guards read `request.routeOptions.url`. Never decide on `request.url`: the router decodes a path before matching, so the raw text and the handler can disagree.
- **Every `/api` route is private unless listed** in `publicApiRoutes` in `apps/api/src/auth/routes.ts`. A route a paired device may call must be added to a device set there.
- **A library session is created in one place**, inside the MFA verification transaction in `apps/api/src/auth/mfa.ts`. Google sign-in alone yields only a challenge.
- **State changes need the CSRF token and an exact `Origin`.** `GET` handlers must not change state.
- **Media is authorized per ticket and per chunk.** Paths under a prepared asset come from a 64-hex ID and a filename matched by regular expression.
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
