import { Button } from './controls.tsx';
import { cx } from './cx.ts';
import { jumpLabel } from './jump-label.ts';

export interface JumpToLatestProps {
  /** Shown while you're scrolled up; fades in and out, and can't be reached while hidden. */
  shown: boolean;
  /** Messages that arrived below since you scrolled up. */
  count?: number;
  onJump: () => void;
}

/** Floats over the bottom of a conversation while you read further up: takes you to the newest
 * message, and says how many arrived since you left it. Place it in a positioned box. */
export function JumpToLatest({ shown, count = 0, onJump }: JumpToLatestProps) {
  return (
    <div className={cx('joc-jump', shown && 'is-shown')} aria-hidden={shown ? undefined : 'true'}>
      <Button
        size="sm"
        icon="arrowDown"
        className="joc-jump__btn"
        tabIndex={shown ? undefined : -1}
        title="Jump to latest (End)"
        onClick={onJump}
      >
        <span className="joc-jump__label">{jumpLabel(count)}</span>
      </Button>
    </div>
  );
}
