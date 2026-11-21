# Mov documentation refresh

Checked 15 November 2026. These are current official pages, including living standards first published before 2026. This is a targeted implementation review, not a claim to have read every document published in 2026. Architecture choices in the specification are our decisions, not vendor guarantees.

| Area                  | Official reference                                                                                                                                  | Planning consequence                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Drive limits          | [Usage limits](https://developers.google.com/workspace/drive/api/guides/limits)                                                                     | New-project quota-unit model; instrument downloads and verify project-specific allowances          |
| Drive changes in 2026 | [Release notes](https://developers.google.com/workspace/drive/release-notes)                                                                        | Keep ordinary REST integration separate from MCP agentic-client changes                            |
| Partial downloads     | [Download/export](https://developers.google.com/workspace/drive/api/guides/manage-downloads)                                                        | Use supported blob downloads and byte ranges; verify download capability                           |
| Incremental catalogue | [Changes](https://developers.google.com/workspace/drive/api/guides/manage-changes)                                                                  | Differentiate next-page and new-start tokens; checkpoint durable progress                          |
| Authorization scope   | [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)                                                          | Read-only grant is account-wide; selected folder is app enforcement                                |
| OAuth                 | [Web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)                                                              | Supported library, offline access, validated redirects and server-side credentials                 |
| Runtime               | [Node releases](https://nodejs.org/en/about/previous-releases)                                                                                      | Node 26 is listed as LTS; lock compatible patched dependencies                                     |
| HLS production        | [FFmpeg formats](https://ffmpeg.org/ffmpeg-formats.html#hls-2)                                                                                      | Generate real VOD renditions; do not confuse player support with encoding                          |
| Browser HLS           | [HLS.js](https://github.com/video-dev/hls.js)                                                                                                       | Capability detection and explicit native-player fallback                                           |
| Database              | [SQLite WAL](https://www.sqlite.org/wal.html)                                                                                                       | Local database plus driver-level verification of the 2026 WAL-reset fix                            |
| Samsung 2026 codecs   | [2026 TV video specifications](https://developer.samsung.com/smarttv/develop/specifications/media-specifications/2026-tv-video-specifications.html) | Codec support varies by model group; test actual hardware                                          |
| Samsung engine        | [Web engine specifications](https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html)                            | Set TV-specific build target; do not assume newest browser APIs                                    |
| Samsung player        | [AVPlay](https://developer.samsung.com/smarttv/develop/guides/multimedia/media-playback/using-avplay.html)                                          | Platform adapter with explicit state transitions                                                   |
| LG engine             | [Web engine](https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine)                                                       | webOS 26 lists Chromium 132; older generations differ substantially                                |
| LG HLS                | [Streaming specifications](https://webostv.developer.lge.com/develop/specifications/streaming-protocol-drm)                                         | Matching audio/video segment durations and platform-specific tag limitations                       |
| LG installation       | [Developer Mode](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app)                                                      | Limited session time; document renewal and distinguish test installation from durable distribution |
| Resource limits       | [systemd resource controls](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html)                                  | CPUQuota=100% caps one CPU equivalent, not the entire two-CPU host; enforce memory limits too      |
| Reverse proxy         | [Nginx proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)                                                                     | Disable media buffering/cache where appropriate; prevent uncontrolled temporary video files        |

Earlier sources for HTTP semantics, FFprobe, security, metadata, and storage remain linked in the [research report](2026-research-and-gap-analysis.md). No private account entitlement, throughput, codec result or cloud billing allowance was verified by reading these pages.

## Reading room, checked 19 November 2026

| Area              | Official reference                                                                      | Consequence                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Drive quota units | [Usage limits](https://developers.google.com/workspace/drive/api/guides/limits)         | A download (`files.get` with `alt=media`) costs 200 units of 325,000 per user per minute; book downloads are capped at 24 in flight         |
| Drive backoff     | [Usage limits](https://developers.google.com/workspace/drive/api/guides/limits)         | Rate limits wait `min(2^n s + up to 1 s, 32 s)`; one limited request pauses the others                                                      |
| Drive errors      | [Handle errors](https://developers.google.com/workspace/drive/api/guides/handle-errors) | `userRateLimitExceeded`, `rateLimitExceeded` and 429 are retried; no `Retry-After` is documented                                            |
| Drive 2026 limits | [Release notes](https://developers.google.com/workspace/drive/release-notes)            | Quota units from 1 May 2026, with a 1 TB per project per day egress limit; projects active before then keep their earlier quotas            |
| PDF.js 6.5        | [API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html)                  | `render({ canvas })` is the current form; `page.cleanup()` releases a dropped page; worker rendering (`rendererSrc`) is available, not used |
| zip.js 2.25       | [Reader](https://gildas-lormeau.github.io/zip.js/api/classes/Reader.html)               | Reads past the end are truncated; `checkSignature` is deprecated for `checkCrc32`                                                           |
| DOMPurify 3.4     | [README](https://github.com/cure53/DOMPurify)                                           | A custom `ALLOWED_URI_REGEXP` applies to non-URI attributes too; `ADD_URI_SAFE_ATTR` keeps `lang`, `dir` and table spans                    |

## Reading room, checked 21 November 2026

| Area              | Official reference                                                                                   | Consequence                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| PDF.js text layer | [`text_layer.js`](https://github.com/mozilla/pdf.js/blob/v6.5.438/src/display/text_layer.js)         | `new TextLayer({ textContentSource, container, viewport })`; sized by the `--total-scale-factor` CSS variable |
| PDF.js selection  | [`text_layer_builder.js`](https://github.com/mozilla/pdf.js/blob/v6.5.438/web/text_layer_builder.js) | `endOfContent` and the `selecting` class guard drags; the end is moved only outside Firefox and Chromium 148+ |
| PDF.js in Node    | [pdf2png example](https://github.com/mozilla/pdf.js/tree/v6.5.438/examples/node/pdf2png)             | Legacy build draws with `@napi-rs/canvas`; `isEvalSupported` no longer exists in 6.5                          |

## LG C1 target refinement

Owner confirmed LG C1 during implementation. LG lists its 2021 OLED lineup, including C1, with webOS 6.0. The current developer engine table maps webOS 6.x to Chromium 79. Build the separate TV bundle for Chrome 79; do not assume the modern browser bundle or CSS feature set works on the TV. Installed firmware remains unverified.

- https://www.lg.com/us/newsroom/media-entertainment/lg-usa-begins-rollout-of-2021-oled-tv-lineup
- https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine
- https://webostv.developer.lge.com/develop/specifications/streaming-protocol-drm
