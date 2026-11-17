import type { CSSProperties, ReactNode } from "react";

const shapes = {
  chat: <path d="M4 5.5h16v10.5H10l-5 4v-4H4z" />,
  inbox: (
    <>
      <path d="M3 13.5h5l1.5 2.5h5l1.5-2.5h5" />
      <path d="M5.5 5h13L21 13.5V19H3v-5.5z" />
    </>
  ),
  history: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  memory: <path d="M6.5 3.5h11v17L12 16.5l-5.5 4z" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" />
    </>
  ),
  send: <path d="M12 19V5M6 11l6-6 6 6" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" />,
  chev: <path d="M9.5 6l6 6-6 6" />,
  down: <path d="M6 9.5l6 6 6-6" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  plus: <path d="M12 5v14M5 12h14" />,
  alert: (
    <>
      <path d="M12 4l9 15.5H3z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M7 10l3 2.5L7 15M12.5 15H17" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c.7-3.7 3.4-5.5 7-5.5s6.3 1.8 7 5.5" />
    </>
  ),
  folder: <path d="M3 7.5a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  swap: <path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5" />,
  repo: (
    <>
      <path d="M5.5 18.5V5.5a2 2 0 0 1 2-2h11v14h-11a2 2 0 0 0-2 2 2 2 0 0 0 2 2h11" />
      <path d="M9 7.5h6" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof shapes;

export function Icon({ name, size }: { readonly name: IconName; readonly size?: number }) {
  return (
    <svg
      className="od-icon"
      style={size === undefined ? undefined : ({ "--od-icon-size": `${size}px` } as CSSProperties)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {shapes[name]}
    </svg>
  );
}

export function Logo({ size = 22 }: { readonly size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="var(--accent)" />
      <g transform="translate(2.16 2.16) scale(.82)">
        <circle cx="12" cy="12" r="3.3" fill="var(--accent-on)" />
        <path d="M19.24 10.06A7.5 7.5 0 1 1 13.94 4.76" fill="none" stroke="var(--accent-on)" strokeWidth="2" strokeLinecap="round" />
        <circle cx="17.4" cy="6.6" r="2.1" fill="var(--accent-on)" />
      </g>
    </svg>
  );
}
