import type { ReactNode } from "react";
export function StatusPanel({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="status-panel" role="status">
      <span className="status-glyph" aria-hidden="true">
        ◌
      </span>
      <h2>{title}</h2>
      <div className="muted">{children}</div>
      {action && <div className="status-action">{action}</div>}
    </section>
  );
}
