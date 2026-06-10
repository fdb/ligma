const paths: Record<string, React.ReactNode> = {
  select: <path fill="currentColor" stroke="none" d="M4.5 1.8 13 9.9l-4.7.5 2.6 4.6-1.8 1-2.6-4.6-3 3.6z" />,
  frame: (
    <>
      <path d="M5.5 2v12M10.5 2v12M2 5.5h12M2 10.5h12" />
    </>
  ),
  rect: <rect x="2.5" y="3.5" width="11" height="9" rx="1" />,
  ellipse: <circle cx="8" cy="8" r="5.5" />,
  text: <path d="M3.5 4.5v-1h9v1M8 3.5V13M6.5 13h3" />,
  hand: (
    <path d="M5.2 8.4V4.6a1.1 1.1 0 0 1 2.2 0V8m0-3.9V3a1.1 1.1 0 0 1 2.2 0v5m0-3.6a1.1 1.1 0 0 1 2.2 0v5.2c0 2.9-1.7 4.6-4.1 4.6-2 0-3-.9-4-2.8L2.6 9.7c-.5-.9.7-1.7 1.4-1l1.2 1.3" />
  ),
  image: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1" />
      <circle cx="6" cy="6.5" r="1" fill="currentColor" stroke="none" />
      <path d="M2.5 11l3-3 2.5 2.5L11 7.5l2.5 3" />
    </>
  ),
  comment: (
    <path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H8l-3 3v-3H4.5a2 2 0 0 1-2-2z" />
  ),
  minus: <path d="M3.5 8h9" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  fit: <path d="M2.5 5.5v-3h3M13.5 5.5v-3h-3M2.5 10.5v3h3M13.5 10.5v3h-3" />,
  group: (
    <>
      <rect x="2.5" y="2.5" width="7" height="7" rx="1" />
      <path d="M6.5 11.5v1a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1h-1" />
    </>
  ),
  eye: (
    <>
      <path d="M1.8 8s2.2-4 6.2-4 6.2 4 6.2 4-2.2 4-6.2 4-6.2-4-6.2-4z" />
      <circle cx="8" cy="8" r="1.8" />
    </>
  ),
  "eye-off": <path d="M3 3l10 10M5.2 5.6C3 6.9 1.8 8 1.8 8s2.2 4 6.2 4c1 0 1.9-.2 2.7-.6M7 4.1c.3 0 .7-.1 1-.1 4 0 6.2 4 6.2 4s-.6 1.1-1.8 2.2" />,
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  unlock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.6" />
    </>
  ),
  chevron: <path d="M6 4.5L10 8l-4 3.5" />,
  download: <path d="M8 2.5V10M5 7.5L8 10.5l3-3M3 13h10" />,
  "align-left": <path d="M3 2.5v11M3 6h7M3 10h4.5" />,
  "align-hcenter": <path d="M8 2.5v11M4 6h8M5.5 10h5" />,
  "align-right": <path d="M13 2.5v11M6 6h7M8.5 10h4.5" />,
  "align-top": <path d="M2.5 3h11M6 3v7M10 3v4.5" />,
  "align-vcenter": <path d="M2.5 8h11M6 4v8M10 5.5v5" />,
  "align-bottom": <path d="M2.5 13h11M6 6v7M10 8.5v4.5" />,
  "dist-h": (
    <>
      <path d="M2.5 2.5v11M13.5 2.5v11" />
      <rect x="6.5" y="5" width="3" height="6" />
    </>
  ),
  "dist-v": (
    <>
      <path d="M2.5 2.5h11M2.5 13.5h11" />
      <rect x="5" y="6.5" width="6" height="3" />
    </>
  ),
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths[name]}
    </svg>
  );
}
