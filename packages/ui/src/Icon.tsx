/**
 * The interface's icons: one set, one stroke, drawn here rather than typed as
 * characters. A character such as ▶ or ⌕ is drawn by whatever font the device
 * falls back to, and some platforms swap in a colour emoji.
 */
const shapes = {
  play: <path d="M8 5.2v13.6L19.2 12z" fill="currentColor" stroke="none" />,
  next: (
    <>
      <path d="M5 5.5v13L14.5 12z" fill="currentColor" stroke="none" />
      <path d="M18 5.5v13" />
    </>
  ),
  "arrow-left": <path d="M19 12H5m6-6-6 6 6 6" />,
  "arrow-up-right": <path d="M7 17 17 7M9 7h8v8" />,
  "arrow-right": <path d="M5 12h14m-6-6 6 6-6 6" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  pause: (
    <path
      d="M7 5h3.4v14H7zM13.6 5H17v14h-3.4z"
      fill="currentColor"
      stroke="none"
    />
  ),
  back: (
    <>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
      <path d="M4.5 4.5v4.2h4.2" />
    </>
  ),
  forward: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.5 4.5v4.2h-4.2" />
    </>
  ),
  volume: (
    <>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
      <path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" />
    </>
  ),
  mute: (
    <>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
      <path d="m16 9.5 5 5m0-5-5 5" />
    </>
  ),
  expand: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  shrink: <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />,
  pip: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="1.5" />
      <rect x="12" y="11.5" width="7" height="5.5" rx="0.8" />
    </>
  ),
  settings: <path d="M3 7h7m4 0h7M3 17h11m4 0h3M10 4v6m4 4v6" />,
  index: (
    <>
      <rect x="3" y="4" width="7" height="16" rx="1" />
      <path d="M14 5h7m-7 7h7m-7 7h7" />
    </>
  ),
  folder: (
    <path d="M3.5 7.5a2 2 0 0 1 2-2h3.7l2 2.2h7.3a2 2 0 0 1 2 2v6.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4.5V9h-4.5" />
    </>
  ),
};
export type IconName = keyof typeof shapes;
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shapes[name]}
    </svg>
  );
}
