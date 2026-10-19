import type { SessionState } from '@joc/protocol';
import { Button } from './controls.tsx';
import { Icon, type IconName } from './Icon.tsx';
import { SessionLink } from './session.tsx';

export interface InboxRowProps {
  title: string;
  /** The repo's short name, e.g. `atlas-web`. */
  repo: string;
  /** The pull request or issue number, when the thread is one. */
  number?: number;
  /** GitHub's subject type (`PullRequest`, `Issue`, `CheckSuite`, ...): picks the icon. */
  type: string;
  /** A short label for the type, e.g. "Pull request". */
  kind?: string;
  updated: string;
  /** Marked read: the row stays where it is and says so, rather than leaving the list. */
  read?: boolean;
  session?: { title: string; state: SessionState; href?: string };
  /** Opens the thread, from a click or Enter anywhere on the row but its link and button. */
  onOpen?: () => void;
  onMarkRead?: () => void;
}

const ICONS = new Map<string, IconName>([
  ['PullRequest', 'pr'],
  ['Issue', 'comment'],
  ['Discussion', 'comment'],
  ['CheckSuite', 'terminal'],
  ['Commit', 'branch'],
]);

/** One unread GitHub notification. Laid out as a PRRow, so the two lists line up. */
export function InboxRow({
  title,
  repo,
  number,
  type,
  kind,
  updated,
  read,
  session,
  onOpen,
  onMarkRead,
}: InboxRowProps) {
  return (
    // The row opens the thread; the session link and button inside it stay their own.
    // biome-ignore lint/a11y/useSemanticElements: an <a> can't hold the session link (no nested links)
    <div
      className="joc-pr"
      role="link"
      tabIndex={0}
      onClick={(e) => {
        if (e.target instanceof Element && e.target.closest('a, button')) return;
        onOpen?.();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) onOpen?.();
      }}
    >
      <span className="joc-pr__icon is-draft">
        <Icon name={ICONS.get(type) ?? 'inbox'} size={16} />
      </span>
      <span className="joc-pr__main">
        <span className="joc-pr__line1">
          <span className="joc-pr__title">{title}</span>
          {kind ? <span className="joc-tag">{kind}</span> : null}
        </span>
        <span className="joc-pr__line2">
          <span className="joc-pr__num">
            {repo}
            {number ? `#${number}` : ''}
          </span>
          <span>{updated}</span>
        </span>
      </span>
      <span />
      <span className="joc-pr__session">{session ? <SessionLink {...session} /> : null}</span>
      <span className="joc-pr__ci">
        {read ? (
          <span className="joc-tag">Read</span>
        ) : onMarkRead ? (
          <Button variant="ghost" size="sm" icon="check" onClick={onMarkRead}>
            Mark read
          </Button>
        ) : null}
      </span>
    </div>
  );
}
