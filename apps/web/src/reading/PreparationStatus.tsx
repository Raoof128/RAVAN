import type { ReadingPreparation } from "../../../../packages/contracts/src/reading.js";
import { FlowProgress } from "../../../../packages/ui/src/Loading.js";

export function PreparationStatus({ status }: { status?: ReadingPreparation }) {
  if (!status || status.state === "on-demand") return null;
  const label =
    status.state === "ready"
      ? "Ready for quick opening"
      : status.state === "queued"
        ? `Preparation queued · ${status.percent}%`
        : status.state === "failed"
          ? "Background preparation unavailable"
          : `Preparing · ${status.percent}%`;
  return (
    <span className="reading-preparation">
      <span>{label}</span>
      {(status.state === "queued" || status.state === "preparing") && (
        <FlowProgress value={status.percent} label="Book preparation" />
      )}
    </span>
  );
}
