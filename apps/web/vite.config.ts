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
  build: { target: "es2022" },
});
