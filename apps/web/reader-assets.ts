import { createReadStream, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/** Ship PDF.js's own CMaps/fonts/decoders locally; never contact a public CDN. */
export function readerAssets(): Plugin {
  const files = new Map<string, string>();
  for (const folder of ["cmaps", "standard_fonts", "wasm"]) {
    const directory = new URL(
      `../../node_modules/pdfjs-dist/${folder}/`,
      import.meta.url,
    );
    for (const name of readdirSync(directory)) {
      // The reader never runs PDF JavaScript; do not distribute its scripting VM.
      if (name.includes("quickjs")) continue;
      files.set(
        `/reader-assets/${folder}/${name}`,
        fileURLToPath(new URL(name, directory)),
      );
    }
  }
  return {
    name: "reader-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = files.get(request.url?.split("?")[0] ?? "");
        if (!path) return next();
        response.setHeader(
          "Content-Type",
          path.endsWith(".wasm")
            ? "application/wasm"
            : "application/octet-stream",
        );
        const stream = createReadStream(path);
        stream.on("error", () => {
          response.statusCode = 500;
          response.end();
        });
        response.on("close", () => stream.destroy());
        stream.pipe(response);
      });
    },
    generateBundle() {
      for (const [url, path] of files)
        this.emitFile({
          type: "asset",
          fileName: url.slice(1),
          source: readFileSync(path),
        });
    },
  };
}
