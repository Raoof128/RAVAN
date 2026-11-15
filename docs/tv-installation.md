# LG C1 development installation

The development target is an LG C1. LG's official table maps its webOS 6.x generation to Chromium 79. The separate TV bundle targets that engine and uses native media playback. The actual TV's firmware is not yet recorded. Browser automation is only shell evidence.

1. Choose the final HTTPS Mov origin and complete server authorization/streaming verification.
2. Install LG's current webOS TV CLI and follow the official Developer Mode app/device-key setup. Use the same local network for the device connection. Credentials and pairing keys stay outside this repository.
3. Build with the exact origin: `VITE_MOV_ORIGIN=https://your-hostname npm run build:tv`.
4. Use `node scripts/package-tv.mjs --platform=webos --origin=https://your-hostname --validate-only` to check the build configuration; remove `--validate-only` only when the vendor CLI is installed and a package is needed.
5. Install the resulting package using `ares-install` for your registered TV, then launch `com.mov.privatecinema` using `ares-launch`. Approve the displayed code in Your cinema on your signed-in phone.

Do not treat Developer Mode as permanent distribution. Follow LG's current session-extension/expiry instructions and test the app after expiry/reboot. A durable installation route is a separate decision. There is no store submission in the scripts.

Before accepting the C1 build: test remote and Magic Remote pointer navigation; direct-play compatible films; first/middle/end seeks; pause longer than two minutes; suspend/resume; disconnect/reconnect; device revocation; and a complete movie crossing credential renewal. Record firmware, source/container/codec/audio, connection and outcome. Browser-compatible MP4 conversion is available, but physical TV playback remains unverified; the HLS primitive is not connected to production playback.

Official references: [webOS CLI](https://webostv.developer.lge.com/develop/tools/cli-dev-guide), [Developer Mode](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app), [engine versions](https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine), [streaming constraints](https://webostv.developer.lge.com/develop/specifications/streaming-protocol-drm).
