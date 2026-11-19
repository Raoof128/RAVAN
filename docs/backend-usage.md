# Local backend setup

1. Copy `.env.example` to `.env`. The populated file is Git-ignored. Use an absolute private data directory for a deployed installation.
2. Create a Google Cloud OAuth web client with Drive API enabled. Register `http://localhost:5173/auth/google/callback` for local development. The production callback must use the final HTTPS hostname.
3. Set the client ID/secret and a **verified Google subject** for the owner. Owner binding must come from a controlled, verified identity flow; there is no public first-user-wins setup. Do not paste credentials into chat.
4. Generate independent 32-byte hexadecimal values locally for `MOV_ENCRYPTION_KEY` and `MOV_WORKER_KEY`. Store the encryption key outside the database and preserve its recovery custody. Changing it makes stored refresh credentials and MFA authenticator seeds unreadable. Preserve it separately from the database backup.
5. Start API and worker in separate terminals:

```sh
node --env-file=.env --import tsx apps/api/src/main.ts
node --env-file=.env --import tsx apps/worker/src/main.ts
npm run dev:web
```

6. Open `http://localhost:5173`, sign in as the pinned owner and grant Drive read access. The Google scope can read the account; Mov enforces the selected folder in its own membership checks. Enroll an authenticator, verify its six-digit code and save the one-use recovery codes before entering. On later logins, Google verification is followed by the authenticator. Select the folder ID from your Drive folder URL in Your cinema. Shortcuts are excluded.
7. Wait for the library refresh, open a film and choose Watch. The worker checks the source format first. Compatible H.264/AAC MP4 can play directly. With `MOV_PREPARED_DIR` configured, other supported formats are prepared automatically as browser-compatible MP4, including HDR-to-SDR conversion and WebVTT text subtitles. Leave Quality on Auto; initial preparation continues in the background.

The player reports what the browser can decode, and the server does the least work that will play: the original directly, a repackaged copy with the picture untouched, or a full H.264 conversion. Choosing an explicit size in the player always converts to that size. A browser that reports nothing gets the universal conversion.

Only one playback session is active by default. Replacing it requires an explicit button press. Progress is saved periodically and on pause/end. The TV receives its own revocable credential; Google tokens remain on the server. A credential the owner approved but the screen did not collect within a minute is revoked, since nobody holds it.

The worker's private routes are `/_worker/*`. They require a separate key and must also be excluded by the public proxy. Source bytes are served only against a per-file grant the worker obtains with that key, so the key itself never appears on an FFmpeg command line. Media operations use fixed executable argument arrays, bounded output and timeouts. Source downloads use immutable generation-keyed blocks; the input file is never changed.

Every `/api` route is authorized by the route the request matched, not by the text of its URL, so percent-encoded spellings of a path receive the same checks. Only `/api/session` and the TV's `/api/pairing` and `/api/pairing/poll` are reachable without an owner session or device credential. Errors use one shape, `{ "error": "<code>" }`, including `not_found` and `rate_limited`.

The API runs on loopback port 4310. `/healthz` checks liveness; `/readyz` checks the open database and disk reserve. Missing Google configuration leaves the setup screen available and private API routes protected. Normal development commands do not auto-load `.env`; use the explicit commands above when connecting Google.

The current implementation disables application request logging. The one exception is a request that fails inside the server: it writes its method, matched route pattern and error class, never the address, a header or data. The proxy template disables ticket-bearing media access logs and error logs. Add telemetry only with explicit redaction of paths, credentials and private filenames.

Browsing by folder: `GET /api/movies?folder=root` lists the top of the selected Drive folder, and `folder=<id>` one folder inside it. The answer carries `folder` (its name and the folder above it), `folders` (the folders inside, each with a film count and a poster, on the first page only) and, at the top, `resume` (films in progress anywhere). Films are ordered by title; `nextCursor` pages them. Folders come from the last scan (`library_folders`); before one has recorded them, `folder=root` lists the whole library. Without `folder`, the list is the whole library ordered as before, which is what the television uses.

Source edition reassignment is available to the owner via `PATCH /api/movies/:targetId` with `{ "associateSourceId": "source-id" }` and the normal session/CSRF headers. It retains the original movie's history and revokes playback of the moved source. Multiple available sources currently require disambiguation before playback. Optional TMDB enrichment is not connected; locally edited titles/descriptions and generated fallback posters work independently.

Set `MOV_ORIGIN=http://localhost:5173` when using the Vite proxy locally, matching the exact browser origin and Google callback registration. It must be a bare origin (`scheme://host[:port]`); a trailing slash or path is rejected at startup because it could never equal a browser's `Origin` header. A failed start prints the setting and rule that failed, never a configured value. The production origin must be the final HTTPS hostname. See [MFA recovery](security/mfa-usage.md).

For local preparation, set `MOV_PREPARED_DIR` to an absolute real directory (not a symlink). In production it must be a separate bounded filesystem, with sufficient space reserved on the parent disk. The worker needs FFmpeg with libx264, AAC, zscale and tonemap. The service template allows 256 tasks for up to 64 subtitle outputs while retaining a one-core CPU limit and 2 GiB memory ceiling. Do not lower the task limit to the video encoder's thread count.

### Book preparation

Run the API and worker against the same data directory. After a Drive sync, the worker prepares supported books in a separate reading lane. Open a title to prioritize it. The shelf reports the worker’s measured progress, and Reading settings shows it while the book is open. A service restart resumes from verified cache blocks. Bookmarks are stored independently in SQLite. See [Reading room](reading-room.md).
