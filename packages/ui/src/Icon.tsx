import { cx } from './cx.ts';

// 16px grid, 1.5 stroke, currentColor.
const PATHS = {
  chevronRight: 'M6 4l4 4-4 4',
  chevronDown: 'M4 6l4 4 4-4',
  chevronLeft: 'M10 4L6 8l4 4',
  arrowDown: 'M8 3v10M4 9l4 4 4-4',
  at: 'M10.5 8a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zM10.5 8v1a1.75 1.75 0 003.5 0V8a6 6 0 10-2.4 4.8',
  person: 'M10.5 5.5a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zM3 13.5c.6-2.4 2.6-4 5-4s4.4 1.6 5 4',
  check: 'M3.5 8.5l3 3 6-7',
  x: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  copy: 'M5.5 5.5V3.5a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1h-2M3.5 5.5h6a1 1 0 011 1v6a1 1 0 01-1 1h-6a1 1 0 01-1-1v-6a1 1 0 011-1z',
  branch: 'M5 3v7M5 10a2 2 0 100 4 2 2 0 000-4zM11 6a2 2 0 100-4 2 2 0 000 4zM11 6c0 3-6 2-6 4',
  send: 'M3 8h9M8.5 4.5L12 8l-3.5 3.5',
  file: 'M4 2.5h5l3 3v8H4zM9 2.5v3h3',
  folder: 'M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z',
  comment: 'M3 3.5h10v7H7l-3 2.5v-2.5H3z',
  terminal: 'M3.5 5l3 3-3 3M8 11.5h4.5',
  pr: 'M5 3v10M5 3a1.5 1.5 0 100 .01M11 13a1.5 1.5 0 100-.01M11 11.5V6.5a2 2 0 00-2-2H7.5M9 3l-1.5 1.5L9 6',
  plus: 'M8 3.5v9M3.5 8h9',
  pin: 'M9.5 2.5l4 4-1.5.5-2.75 2.75.5 3-1 1-6.5-6.5 1-1 3 .5L9 3.5zM5.5 10.5l-3 3',
  stop: 'M5 5h6v6H5z',
  sparkle: 'M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3',
  lock: 'M4.5 7.5h7v5.5h-7zM6 7.5V5.5a2 2 0 014 0v2',
  inbox: 'M2.5 9.5l1.5-6h8l1.5 6v3h-11zM2.5 9.5h3.5l.5 1.5h3l.5-1.5h3.5',
  bell: 'M4 10.5V7a4 4 0 018 0v3.5l1.5 2h-11zM6.5 13.5a1.5 1.5 0 003 0',
  settings: 'M2.5 5h7M12.5 5h1M2.5 11h1M6.5 11h7M11 3.5v3M5 9.5v3',
  clock: 'M13.5 8a5.5 5.5 0 11-11 0 5.5 5.5 0 0111 0zM8 5v3l2 1.5',
  sidebar:
    'M4 3h8a1.5 1.5 0 011.5 1.5v7A1.5 1.5 0 0112 13H4a1.5 1.5 0 01-1.5-1.5v-7A1.5 1.5 0 014 3zM6 3v10',
  external: 'M9 3h4v4M13 3L7.5 8.5M11.5 9.5v3a1 1 0 01-1 1h-7a1 1 0 01-1-1v-7a1 1 0 011-1h3',
  plug: 'M6 1.5v3M10 1.5v3M4 4.5h8v3a4 4 0 01-8 0zM8 11.5v3',
  update: 'M14 8A6 6 0 112 8a6 6 0 0112 0zM8 5v6M5.5 8.5L8 11l2.5-2.5',
  more: 'M3.5 8h.5M7.75 8h.5M12 8h.5',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5',
} as const;

export type IconName = keyof typeof PATHS;

export interface IconProps {
  name: IconName;
  size?: number;
  title?: string;
  className?: string;
  /** Filled with the text colour, e.g. a pin that's on. */
  filled?: boolean;
}

export function Icon({ name, size = 16, title, className, filled }: IconProps) {
  // Decorative (aria-hidden) unless a title is given.
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: hidden from assistive tech when untitled
    <svg
      className={cx('joc-icon', className)}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}
