import { type DropAfter, QUIET_AFTER_MS, type Session, type SessionSettings } from '@joc/protocol';

/** The choices for how long a session stays, in the order the settings show them. */
export const DROP_AFTER_OPTIONS: { id: DropAfter; label: string }[] = [
  { id: '1h', label: '1 hour' },
  { id: '1d', label: '1 day' },
  { id: '1w', label: '1 week' },
  { id: '30d', label: '30 days' },
  { id: 'never', label: 'Never' },
];

const LABEL = new Map(DROP_AFTER_OPTIONS.map((o) => [o.id, o.label.toLowerCase()]));

/** One line on what the live list leaves out, e.g. "Quiet sessions leave after 1 week, ...". */
export function keepNote({ quiet, ended }: SessionSettings): string {
  const part = (what: string, after: DropAfter) =>
    after === 'never' ? `${what} stay` : `${what} leave after ${LABEL.get(after)}`;
  if (quiet === ended) return `${part('Quiet and ended sessions', quiet)}.`;
  return `${part('Quiet sessions', quiet)}, ${part('ended ones', ended).toLowerCase()}.`;
}

/** Whether a session's text matches what was typed in the filter, ignoring case. */
export function matchesFilter(s: Session, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [s.title, s.repo, s.branch].some((field) => field?.toLowerCase().includes(q));
}

/**
 * A session that stopped reporting without ending: its machine asleep, offline, or Claude Code
 * killed. An open session syncs every 30s, so it's never quiet for long.
 */
export function isQuiet(s: Session, now = Date.now()): boolean {
  return s.state !== 'offline' && now - Date.parse(s.updatedAt) > QUIET_AFTER_MS;
}
