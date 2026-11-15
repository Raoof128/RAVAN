import type { PreparationPhase } from "../../../../packages/contracts/src/index.js";
import { Flow, FlowProgress } from "../../../../packages/ui/src/Loading.js";

const order = ["read", "wait", "prepare", "start"] as const;
type Step = (typeof order)[number];
const stepOf: Record<PreparationPhase, Step> = {
  inspecting: "read",
  queued: "wait",
  retrying: "wait",
  repackaging: "prepare",
  converting: "prepare",
  buffering: "start",
};
/** Phases during which the worker reports how much of the film is written. */
const measured = new Set<PreparationPhase>([
  "repackaging",
  "converting",
  "buffering",
]);
function label(step: Step, phase: PreparationPhase) {
  if (step === "read") return "Read the file";
  if (step === "wait")
    return phase === "retrying" ? "Try again" : "Wait for the server";
  if (step === "prepare")
    return phase === "repackaging"
      ? "Repackage, picture untouched"
      : phase === "converting"
        ? "Convert for this screen"
        : "Prepare an edition this screen can play";
  return "Start the film";
}
/**
 * What the server is doing to a film that cannot play yet. Every element is
 * drawn from the server's answer: the step comes from `phase`, the bar from
 * `progress`, the sentence from `reason`. Nothing is estimated here, so there
 * is no time remaining and no bar unless the worker has reported one.
 */
export function Preparing({
  phase,
  progress,
  reason,
}: {
  phase?: PreparationPhase;
  progress?: number;
  reason?: string;
}) {
  const current = phase ? stepOf[phase] : undefined;
  const percent =
    typeof progress === "number" &&
    Number.isFinite(progress) &&
    (!phase || measured.has(phase))
      ? Math.max(0, Math.min(100, Math.floor(progress)))
      : undefined;
  return (
    <section className="preparing" aria-labelledby="preparing-title">
      <h2 id="preparing-title">Getting your film ready</h2>
      <p className="preparing-reason" role="status">
        {reason ??
          "Checking compatibility. Playback starts by itself when the film is ready."}
      </p>
      <div className="preparing-line">
        {percent === undefined ? (
          <Flow />
        ) : (
          <>
            <FlowProgress value={percent} label="Preparation progress" />
            <span className="preparing-percent">{percent}% prepared</span>
          </>
        )}
      </div>
      {phase && current && (
        <ol className="prep-steps" aria-label="Preparation steps">
          {order.map((step) => {
            const state =
              order.indexOf(step) < order.indexOf(current)
                ? "done"
                : step === current
                  ? "current"
                  : "pending";
            return (
              <li
                key={step}
                data-state={state}
                aria-current={state === "current" ? "step" : undefined}
              >
                {label(step, phase)}
                <span className="sr-only">
                  {state === "done"
                    ? " (done)"
                    : state === "current"
                      ? " (in progress)"
                      : ""}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      <p className="fine-print">
        You can leave this page. Preparation continues on the server and the
        finished edition is kept for next time.
      </p>
    </section>
  );
}
