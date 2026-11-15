/**
 * The interface's icons: one set, one stroke, drawn here rather than typed as
 * characters. A character such as ▶ or ⌕ is drawn by whatever font the device
 * falls back to, and some platforms swap in a colour emoji.
 */
const shapes = {
  play: <path d="M8 5.2v13.6L19.2 12z" fill="currentColor" stroke="none" />,
  "arrow-left": <path d="M19 12H5m6-6-6 6 6 6" />,
  "arrow-up-right": <path d="M7 17 17 7M9 7h8v8" />,
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
