import { cx } from './cx.ts';

export interface AvatarProps {
  name: string;
  size?: number;
  claude?: boolean;
  /** Their GitHub avatar (avatars.githubusercontent.com only); initials show until it loads. */
  src?: string;
}

export function Avatar({ name, size = 20, claude, src }: AvatarProps) {
  const parts = name
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .split(/[\s_-]+/)
    .filter(Boolean);
  const initials = (parts[0] ?? '?').charAt(0) + (parts[1] ? parts[1].charAt(0) : '');
  return (
    <span
      className={cx('joc-avatar', claude && 'is-claude')}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
      title={name}
      aria-label={name}
      role="img"
    >
      {claude ? (
        <span className="joc-avatar__mark" />
      ) : src && /^https:\/\/avatars\.githubusercontent\.com\//.test(src) ? (
        <img
          className="joc-avatar__img"
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : (
        initials.toUpperCase()
      )}
    </span>
  );
}
