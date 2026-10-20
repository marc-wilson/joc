import type { ReviewOutcome, SessionState } from '@joc/protocol';
import type { ReactNode } from 'react';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';
import { STATE_LABEL, StateBadge, StateDot } from './state.tsx';

export interface ReviewSessionRowProps {
  /** Stable key when titles can repeat. */
  id?: string;
  /** The session's state while the review runs. */
  state?: SessionState;
  /**
   * The review is over: no state dot and no rail, as the session no longer runs. The PR glyph
   * takes the dot's place and the outcome the activity's.
   */
  done?: boolean;
  /** The PR's title. */
  title: string;
  /** The PR, short: the repo's name and number, "atlas-web#512". */
  pr: string;
  /** The PR in full, for the tooltip: "harbor-labs/atlas-web#512". */
  prTitle?: string;
  /** What the review is doing; once done, what it left, e.g. "3 comments posted". */
  activity?: ReactNode;
  /** "3m"; once done, "Done 4m". */
  time?: string;
  outcome?: ReviewOutcome;
  selected?: boolean;
  onSelect?: () => void;
  /** Shows a dismiss button on hover or focus, for a finished review. */
  onDismiss?: () => void;
}

const OUTCOME_CLASS: Record<ReviewOutcome, string | undefined> = {
  Approved: 'joc-tag--approved',
  'Changes requested': 'joc-tag--changes-requested',
  Commented: undefined,
};

/**
 * A session that reviews a pull request, in the list's Reviews group: a compact row with the PR
 * title on top and the PR and what the review is doing below. The dot and rail mean only the
 * session's state, as in SessionRow.
 */
export function ReviewSessionRow({
  state = 'idle',
  done,
  title,
  pr,
  prTitle,
  activity,
  time,
  outcome,
  selected,
  onSelect,
  onDismiss,
}: ReviewSessionRowProps) {
  const needs = !done && state === 'needs';
  return (
    <div
      className={cx('joc-rrow', `joc-rrow--${done ? 'done' : state}`, selected && 'is-selected')}
      role="option"
      aria-selected={!!selected}
      aria-label={`${title}, review of ${prTitle ?? pr}, ${done ? 'finished' : STATE_LABEL[state]}`}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect?.();
        }
      }}
    >
      <span className="joc-rrow__rail" aria-hidden="true" />
      <span className="joc-rrow__glyph">
        {done ? <Icon name="pr" size={14} title="Finished review" /> : <StateDot state={state} />}
      </span>
      <span className="joc-rrow__main">
        <span className="joc-rrow__line1">
          <span className="joc-rrow__link" title={title}>
            {title}
          </span>
          {needs ? <StateBadge state="needs" /> : null}
          <span className="joc-rrow__time">{time}</span>
          {done && onDismiss ? (
            <button
              className="joc-rrow__dismiss"
              type="button"
              aria-label={`Dismiss finished review of ${prTitle ?? pr}`}
              title="Dismiss"
              onClick={(e) => {
                e.stopPropagation();
                onDismiss();
              }}
            >
              <Icon name="x" size={12} />
            </button>
          ) : null}
        </span>
        <span className="joc-rrow__line2">
          <span className="joc-rrow__pr" title={prTitle}>
            {done ? null : <Icon name="pr" size={12} />}
            {pr}
          </span>
          {done && outcome ? (
            <span className={cx('joc-tag', OUTCOME_CLASS[outcome])}>{outcome}</span>
          ) : null}
          {/* Keyed on the text so each new activity line fades in. */}
          <span
            className="joc-rrow__activity joc-fade-in"
            key={typeof activity === 'string' ? activity : undefined}
          >
            {activity}
          </span>
        </span>
      </span>
    </div>
  );
}
