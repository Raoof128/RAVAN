import DOMPurify from "dompurify";
import {
  MAX_READING_BYTES,
  type ReadingFormat,
} from "../../../../packages/contracts/src/reading.js";
import {
  openArchive,
  resolveResource,
  type ReadingArchive,
} from "./archive.js";

export type BookPage = {
  html?: string;
  image?: string;
  language?: string;
  direction?: "ltr" | "rtl";
  release: () => void;
};
export type OpenBook = {
  format: ReadingFormat;
  sections: string[];
  rtl: boolean;
  page: (index: number, signal?: AbortSignal) => Promise<BookPage>;
  close: () => Promise<void>;
};
const decoder = new TextDecoder();
function xml(data: Uint8Array): XMLDocument {
  const source = decoder.decode(data).replace(/<!DOCTYPE\s+html\s*>/gi, "");
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    throw new Error(
      "Book XML with document type declarations is not supported.",
    );
  const doc = new DOMParser().parseFromString(source, "application/xml");
  if (doc.querySelector("parsererror"))
    throw new Error("This EPUB contains invalid XML.");
  return doc;
}
const elements = (doc: Document | Element, name: string) =>
  Array.from(doc.getElementsByTagNameNS("*", name));
const raster = /\.(png|jpe?g|webp|gif|avif)$/i;
async function imageUrl(
  archive: ReadingArchive,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const bytes = await archive.read(path, undefined, signal);
  signal?.throwIfAborted();
  const extension = path.split(".").pop()!.toLowerCase().replace("jpg", "jpeg");
  // Image decoding has no HTML/script context; SVG is deliberately excluded.
  return URL.createObjectURL(new Blob([bytes], { type: `image/${extension}` }));
}
/** Only reader-owned object URLs may survive as image sources. No links, CSS or scripts. */
export function sanitizeChapter(
  source: string,
  urls: ReadonlySet<string>,
): string {
  const fragment = DOMPurify.sanitize(source, {
    ALLOWED_TAGS: [
      "p",
      "div",
      "span",
      "section",
      "article",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "br",
      "hr",
      "em",
      "strong",
      "b",
      "i",
      "u",
      "s",
      "blockquote",
      "pre",
      "code",
      "ul",
      "ol",
      "li",
      "dl",
      "dt",
      "dd",
      "table",
      "thead",
      "tbody",
      "tr",
      "td",
      "th",
      "sup",
      "sub",
      "ruby",
      "rt",
      "rp",
      "img",
      "figure",
      "figcaption",
    ],
    ALLOWED_ATTR: ["alt", "title", "dir", "lang", "colspan", "rowspan", "src"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP: /^blob:/,
    RETURN_DOM_FRAGMENT: true,
  });
  for (const image of fragment.querySelectorAll("img")) {
    if (!urls.has(image.getAttribute("src") ?? ""))
      image.removeAttribute("src");
  }
  const container = document.createElement("div");
  container.append(fragment);
  return container.innerHTML;
}
export async function openBook(
  blob: Blob,
  format: "epub" | "cbz",
  signal: AbortSignal,
): Promise<OpenBook> {
  if (!blob.size || blob.size > MAX_READING_BYTES)
    throw new Error("Choose a non-empty file up to 100 MB.");
  const archive = await openArchive(blob, signal);
  try {
    if (format === "cbz") {
      const paths = [...archive.entries.keys()]
        .filter((p) => raster.test(p) && !p.startsWith("__MACOSX/"))
        .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
      if (!paths.length)
        throw new Error("This CBZ has no supported image pages.");
      return {
        format,
        sections: paths.map((_, i) => `Page ${i + 1}`),
        rtl: true,
        close: archive.close,
        async page(index, pageSignal) {
          const path = paths[index];
          if (!path) throw new Error("Page unavailable.");
          const url = await imageUrl(archive, path, pageSignal);
          return { image: url, release: () => URL.revokeObjectURL(url) };
        },
      };
    }
    if (archive.entries.has("META-INF/encryption.xml"))
      throw new Error(
        "Encrypted EPUB resources are not supported. Use a DRM-free copy without encrypted fonts.",
      );
    const container = xml(
      await archive.read("META-INF/container.xml", 1024 * 1024),
    );
    const packagePath = elements(container, "rootfile")[0]?.getAttribute(
      "full-path",
    );
    if (!packagePath || !archive.entries.has(packagePath))
      throw new Error("The EPUB package is missing.");
    const metadata = xml(await archive.read(packagePath, 2 * 1024 * 1024));
    const manifest = new Map(
      elements(metadata, "item").map((item) => [item.getAttribute("id"), item]),
    );
    const spine = elements(metadata, "spine")[0];
    if (!spine) throw new Error("This EPUB has no reading order.");
    const paths = elements(spine, "itemref")
      .filter((item) => item.getAttribute("linear") !== "no")
      .map((item) => {
        const resource = manifest.get(item.getAttribute("idref"));
        const path = resolveResource(
          packagePath,
          resource?.getAttribute("href") ?? "",
        );
        if (
          !path ||
          !archive.entries.has(path) ||
          resource?.getAttribute("media-type") !== "application/xhtml+xml"
        )
          throw new Error("This EPUB contains an unsupported chapter.");
        return path;
      });
    if (!paths.length || paths.length > 2000)
      throw new Error("This EPUB has no chapters or too many chapters.");
    return {
      format,
      sections: paths.map((_, i) => `Chapter ${i + 1}`),
      rtl: spine.getAttribute("page-progression-direction") === "rtl",
      close: archive.close,
      async page(index, pageSignal) {
        const path = paths[index];
        if (!path) throw new Error("Chapter unavailable.");
        const doc = xml(await archive.read(path, 4 * 1024 * 1024, pageSignal));
        const urls = new Set<string>();
        let imageBytes = 0;
        try {
          for (const img of elements(doc, "img")) {
            const local = resolveResource(path, img.getAttribute("src") ?? "");
            img.removeAttribute("src");
            const entry =
              local && raster.test(local)
                ? archive.entries.get(local)
                : undefined;
            if (!local || !entry) continue;
            imageBytes += entry.uncompressedSize;
            if (imageBytes > 40 * 1024 * 1024 || urls.size >= 100)
              throw new Error("This chapter contains too many large images.");
            const url = await imageUrl(archive, local, pageSignal);
            urls.add(url);
            img.setAttribute("src", url);
          }
          const root = doc.documentElement;
          const body = elements(doc, "body")[0] ?? root;
          // The sanitizer unwraps the document and body. Preserve their inherited language for assistive technology.
          const language =
            body.getAttribute("lang") ||
            body.getAttribute("xml:lang") ||
            root.getAttribute("lang") ||
            root.getAttribute("xml:lang");
          const direction =
            body.getAttribute("dir") || root.getAttribute("dir");
          const html = sanitizeChapter(
            new XMLSerializer().serializeToString(body),
            urls,
          );
          return {
            html,
            language: language || undefined,
            direction:
              direction === "ltr" || direction === "rtl"
                ? direction
                : undefined,
            release: () => {
              for (const url of urls) URL.revokeObjectURL(url);
            },
          };
        } catch (error) {
          for (const url of urls) URL.revokeObjectURL(url);
          throw error;
        }
      },
    };
  } catch (error) {
    await archive.close();
    throw error;
  }
}
