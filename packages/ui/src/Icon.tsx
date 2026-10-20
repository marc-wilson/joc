import { cx } from './cx.ts';

// 16px grid, 1.5 stroke, currentColor.
const PATHS = {
  chevronRight: 'M6 4l4 4-4 4',
  chevronDown: 'M4 6l4 4 4-4',
  chevronLeft: 'M10 4L6 8l4 4',
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
  pin: 'M5.5 2.5h5M6.5 2.5v4L4.5 9h7l-2-2.5v-4M8 9v4.5',
  stop: 'M5 5h6v6H5z',
  sparkle: 'M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3',
  lock: 'M4.5 7.5h7v5.5h-7zM6 7.5V5.5a2 2 0 014 0v2',
  inbox: 'M2.5 9.5l1.5-6h8l1.5 6v3h-11zM2.5 9.5h3.5l.5 1.5h3l.5-1.5h3.5',
} as const;

export type IconName = keyof typeof PATHS;

export interface IconProps {
  name: IconName;
  size?: number;
  title?: string;
  className?: string;
}

export function Icon({ name, size = 16, title, className }: IconProps) {
  // Decorative (aria-hidden) unless a title is given.
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: hidden from assistive tech when untitled
    <svg
      className={cx('joc-icon', className)}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
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
