export interface LogoMarkProps {
  size?: number;
}

// The Join ring: a C (text colour) and a J (accent) that close into an O where they meet.
// At 16px and below a separately drawn version keeps strokes on whole pixels.
export function LogoMark({ size = 20 }: LogoMarkProps) {
  const small = size <= 16;
  return (
    <svg
      width={size}
      height={size}
      viewBox={small ? '0 0 16 16' : '0 0 32 32'}
      fill="none"
      strokeWidth={small ? 2 : 3}
      aria-hidden="true"
      style={{ flex: 'none', display: 'block' }}
    >
      {small ? (
        <>
          <path d="M3.3 10.71A5 5 0 0 1 9.71 4.3" stroke="currentColor" />
          <path d="M10 2H14M13 1V9A5 5 0 0 1 4.79 12.83" stroke="var(--accent)" />
        </>
      ) : (
        <>
          <path d="M6.81 19.83A9 9 0 0 1 19.3 9.34" stroke="currentColor" />
          <path d="M19 4H26M24.5 4V17.5A9 9 0 0 1 8.61 23.29" stroke="var(--accent)" />
        </>
      )}
    </svg>
  );
}
