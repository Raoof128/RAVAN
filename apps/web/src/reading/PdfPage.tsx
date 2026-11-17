import { useEffect, useRef, useState } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
GlobalWorkerOptions.workerSrc = workerUrl;

export function PdfReader({
  blob,
  section,
  onCount,
  onReady,
  onError,
}: {
  blob: Blob;
  section: number;
  onCount: (n: number) => void;
  onReady: () => void;
  onError: (message: string) => void;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const host = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    let alive = true;
    let task: ReturnType<typeof getDocument> | undefined;
    void blob
      .arrayBuffer()
      .then(async (data) => {
        if (!alive) return;
        task = getDocument({
          data,
          disableFontFace: true,
          useSystemFonts: true,
          cMapUrl: `${import.meta.env.BASE_URL}reader-assets/cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${import.meta.env.BASE_URL}reader-assets/standard_fonts/`,
          wasmUrl: `${import.meta.env.BASE_URL}reader-assets/wasm/`,
          maxImageSize: 20_000_000,
          canvasMaxAreaInBytes: 32 * 1024 * 1024,
        });
        const doc = await task.promise;
        if (doc.numPages > 10000) {
          await task.destroy();
          throw new Error("Too many PDF pages");
        }
        if (alive) {
          setPdf(doc);
          onCount(doc.numPages);
        }
      })
      .catch(() => {
        if (alive)
          onError(
            "This PDF could not be opened. It may be damaged or password protected.",
          );
      });
    return () => {
      alive = false;
      if (task) void task.destroy().catch(() => {});
    };
  }, [blob, onCount, onError]);
  useEffect(() => {
    if (!pdf) return;
    let alive = true;
    let render:
      | ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]>
      | undefined;
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    setText("");
    void pdf
      .getPage(Math.min(section + 1, pdf.numPages))
      .then(async (page) => {
        if (!alive) return;
        const natural = page.getViewport({ scale: 1 });
        const scale = Math.min(2, 1600 / natural.width, 2200 / natural.height);
        const viewport = page.getViewport({ scale });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        render = page.render({ canvas, viewport });
        await render.promise;
        if (!alive) return;
        host.current?.replaceChildren(canvas);
        onReady();
        // Some image-only or damaged PDFs render even when the text layer fails.
        const content = await page.getTextContent().catch(() => undefined);
        if (alive && content) {
          setText(
            content.items
              .map((item) => ("str" in item ? item.str : ""))
              .join(" "),
          );
        }
      })
      .catch(() => {
        if (alive) onError("This PDF page could not be rendered.");
      });
    return () => {
      alive = false;
      render?.cancel();
      canvas.remove();
    };
  }, [pdf, section, onReady, onError]);
  return (
    <>
      <div className="reading-pdf" ref={host} />
      <p className="reading-accessible-text">
        {text || "No text is available for this PDF page."}
      </p>
    </>
  );
}
