import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { target: "chrome79", cssTarget: "chrome79" },
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
});
