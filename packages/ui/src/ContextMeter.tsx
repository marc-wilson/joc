import { cx } from './cx.ts';

export interface ContextMeterProps {
  /** Percent of context left, 0–100. */
  left?: number;
  hideLabel?: boolean;
}

export function ContextMeter({ left, hideLabel }: ContextMeterProps) {
  const v = Math.max(0, Math.min(100, left ?? 100));
  const level = v < 10 ? 'critical' : v < 25 ? 'low' : 'ok';
  return (
    <span className={cx('joc-meter', `joc-meter--${level}`)} title={`${v}% context left`}>
      {/* biome-ignore lint/a11y/useSemanticElements: native <meter> can't take the token styling */}
      <span
        className="joc-meter__track"
        role="meter"
        aria-valuenow={v}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Context left"
      >
        <span className="joc-meter__fill" style={{ width: `${v}%` }} />
      </span>
      {hideLabel ? null : <span className="joc-meter__label">{v}%</span>}
    </span>
  );
}
