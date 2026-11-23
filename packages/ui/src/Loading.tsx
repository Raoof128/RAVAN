import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import ravanMark from "./art/ravan-copper-mark.webp";

/** The copper line carrying a current: a wait with no measured length. */
export function Flow({ className = "" }: { className?: string }) {
  return <span className={`flow ${className}`.trim()} aria-hidden="true" />;
}

/** The same line filled to a percentage the server reported. */
export function FlowProgress({
  value,
  label,
}: {
  value: number;
  label: string;
}) {
  const percent = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <progress
      className="flow-progress"
      value={percent}
      max={100}
      aria-label={label}
    />
  );
}

/** The emblem stays still while the progress line shows activity. */
export function Opening({ words }: { words: string }) {
  return (
    <div className="opening" role="status">
      <div className="opening-mark">
        <Flow />
        <img src={ravanMark} width="44" height="44" alt="" />
      </div>
      <p className="opening-words">{words}</p>
    </div>
  );
}

export function Line({
  width,
  strong,
  className = "",
}: {
  width: string;
  strong?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`sk sk-line ${strong ? "sk-strong" : ""} ${className}`.trim()}
      style={{ width }}
    />
  );
}

/**
 * Placeholders for content on its way. The wrapper is hidden from assistive
 * technology and announces one sentence instead of a grid of empty boxes.
 */
export function Placeholder({
  label,
  className = "",
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className || undefined} role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div className="sk-group" aria-hidden="true">
        {children}
      </div>
    </div>
  );
}

export function PosterPlaceholders({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div className="movie-card is-placeholder" key={i}>
          <span className="sk sk-poster" />
          <Line width="72%" strong />
          <Line width="34%" />
        </div>
      ))}
    </>
  );
}

/**
 * True once `active` has held for `delay` ms. Fast responses never show a
 * placeholder, so nothing flashes on a quick connection.
 */
export function useDelayed(active: boolean, delay = 160) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(timer);
  }, [active, delay]);
  return active && shown;
}

/**
 * Runs one action at a time. While it runs the control stays focusable and
 * keeps its label; activating it again does nothing.
 */
export function usePending() {
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function run(action: () => Promise<unknown>) {
    if (running.current) return;
    running.current = true;
    setPending(true);
    try {
      await action();
    } finally {
      running.current = false;
      if (alive.current) setPending(false);
    }
  }
  return [pending, run] as const;
}

/**
 * Says one sentence to screen-reader users through a region that exists before
 * the words arrive, which is what makes assistive technology read them.
 */
export function announce(text: string) {
  let region = document.getElementById("announcer");
  if (!region) {
    region = document.createElement("div");
    region.id = "announcer";
    region.className = "sr-only";
    region.setAttribute("aria-live", "polite");
    document.body.appendChild(region);
  }
  const target = region;
  target.textContent = "";
  setTimeout(() => {
    target.textContent = text;
  }, 60);
}

export function ActionButton({
  pending,
  pendingLabel,
  className = "",
  children,
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  pending: boolean;
  /** Announced to screen-reader users when the action starts. */
  pendingLabel: string;
  ref?: Ref<HTMLButtonElement>;
}) {
  useEffect(() => {
    if (pending) announce(pendingLabel);
  }, [pending, pendingLabel]);
  return (
    <button
      {...rest}
      className={`${className} ${pending ? "is-pending" : ""}`.trim()}
      aria-busy={pending || undefined}
      aria-disabled={pending || undefined}
      onClick={(event) => {
        if (pending) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      {children}
    </button>
  );
}
