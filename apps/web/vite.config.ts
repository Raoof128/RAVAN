import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readerAssets } from "./reader-assets.js";
export default defineConfig({
  plugins: [react(), readerAssets()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4310",
      "/auth": "http://127.0.0.1:4310",
      "/media": "http://127.0.0.1:4310",
    },
  },
  // RAVAN must load on an LG C1 (webOS 6, Chromium 79) as well as current
  // browsers. Newer syntax is lowered; newer APIs are filled in by
  // `packages/client/src/legacy.ts`. `npm run check:legacy` checks the built
  // files, and `npm run build:cloudflare` refuses a build that fails it.
  build: {
    target: ["chrome79", "edge79", "firefox78", "safari14"],
    cssTarget: ["chrome79", "edge79", "firefox78", "safari14"],
  },
});
