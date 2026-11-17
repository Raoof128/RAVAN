import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "../../../../packages/ui/src/Icon.js";

export function ReaderPanel({
  title,
  children,
  onDismiss,
}: {
  title: string;
  children: ReactNode;
  onDismiss: () => void;
}) {
  const panel = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const dialog = panel.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      className="reader-panel"
      ref={panel}
      aria-labelledby={heading}
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
    >
      <header>
        <h2 id={heading}>{title}</h2>
        <button
          className="reader-icon-button"
          aria-label="Close panel"
          onClick={onDismiss}
        >
          <Icon name="close" />
        </button>
      </header>
      {children}
    </dialog>
  );
}
