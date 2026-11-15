function time(value: string) {
  const match = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value);
  if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60)
    throw new Error("Invalid cue time");
  return (
    ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) *
      1000 +
    Number(match[4])
  );
}
export function subtitleToVtt(input: string) {
  if (Buffer.byteLength(input) > 2 * 1024 * 1024)
    throw new Error("Subtitle size limit");
  const blocks = input
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .trim()
    .split(/\n\s*\n/);
  const cues: string[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines[0] === "WEBVTT") continue;
    if (/^\d+$/.test(lines[0] ?? "")) lines.shift();
    const timing = lines.shift()?.split(" --> ");
    if (!timing || timing.length !== 2 || time(timing[0]!) >= time(timing[1]!))
      throw new Error("Invalid subtitle cue");
    const text = lines
      .join("\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    cues.push(
      `${timing.map((t) => t.replace(",", ".")).join(" --> ")}\n${text}`,
    );
  }
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}
