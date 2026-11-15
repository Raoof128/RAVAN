import type { ReactNode } from "react";
/**
 * A full-width message for an empty, waiting or failed state. Failures are
 * announced at once; everything else waits its turn.
 */
export function StatusPanel({
  title,
  children,
  action,
  tone = "info",
  level = 2,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  tone?: "info" | "error";
  /** 1 when the panel is the only heading on the screen. */
  level?: 1 | 2;
}) {
  const Title = level === 1 ? "h1" : "h2";
  return (
    <section
      className={`status-panel status-${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <span className="status-rule" aria-hidden="true" />
      <Title className="status-title">{title}</Title>
      <div className="muted">{children}</div>
      {action && <div className="status-action">{action}</div>}
    </section>
  );
}
