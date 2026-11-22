import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from "@zip.js/zip.js";
export async function readingZip(files: Record<string, string | Uint8Array>) {
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [name, content] of Object.entries(files))
    await zip.add(
      name,
      new Uint8ArrayReader(
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content,
      ),
    );
  return Buffer.from(await zip.close());
}
export function epubFixture(extra = "", language = "en") {
  return readingZip({
    mimetype: "application/epub+zip",
    "META-INF/container.xml":
      '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
    "OPS/book.opf":
      '<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>',
    "OPS/one.xhtml": `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${language}"><body><h1>The quiet chapter</h1><p>A small story, ready to read.</p>${extra}</body></html>`,
    "OPS/two.xhtml":
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>A second morning</h1><p>The story continues.</p></body></html>',
  });
}
export function pdfFixture(padding = 0) {
  const content = "BT /F1 24 Tf 60 700 Td (The reading room) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  if (padding)
    objects.push(
      `<< /Length ${padding} >>\nstream\n${"a".repeat(padding)}\nendstream`,
    );
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(pdf);
}

/**
 * A PDF of `total` bytes whose first page and index are real and whose bulk
 * is an unused stream, made only for the bytes asked for: a 150 MB book
 * without 150 MB in memory. As a scanned manga volume is, the cover needs
 * the start and the end, never the middle.
 */
export function virtualPdf(total: number) {
  const content = "BT /F1 24 Tf 60 700 Td (Volume two) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let head = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, object] of objects.entries()) {
    offsets.push(head.length);
    head += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  offsets.push(head.length);
  const tailFor = (padding: number, start: number) => {
    let tail = "\nendstream\nendobj\n";
    const xref = start + tail.length;
    tail += `xref\n0 7\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return tail;
  };
  // Solve for the padding that makes the file exactly `total` bytes long.
  let padding = total;
  for (let i = 0; i < 4; i++) {
    const opening = `6 0 obj\n<< /Length ${padding} >>\nstream\n`;
    const before = head.length + opening.length;
    padding = total - before - tailFor(padding, before + padding).length;
  }
  const opening = `6 0 obj\n<< /Length ${padding} >>\nstream\n`;
  const first = Buffer.from(head + opening, "latin1");
  const last = Buffer.from(tailFor(padding, first.length + padding), "latin1");
  if (first.length + padding + last.length !== total)
    throw new Error("virtual PDF length");
  const at = (i: number) =>
    i < first.length
      ? first[i]!
      : i < first.length + padding
        ? 0x61
        : last[i - first.length - padding]!;
  return (start: number, end: number) => {
    const out = new Uint8Array(end - start);
    for (let i = start; i < end; i++) out[i - start] = at(i);
    return out;
  };
}
