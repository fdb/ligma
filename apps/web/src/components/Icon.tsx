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
  minus: <path d="M3.5 8h9" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  fit: <path d="M2.5 5.5v-3h3M13.5 5.5v-3h-3M2.5 10.5v3h3M13.5 10.5v3h-3" />,
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
