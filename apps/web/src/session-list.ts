import {
  type EndedAfter,
  QUIET_AFTER_MS,
  type QuietAfter,
  type Session,
  type SessionSettings,
} from '@joc/protocol';

/** How long a quiet session stays, in the order the settings show the choices. */
export const QUIET_OPTIONS: { id: QuietAfter; label: string }[] = [
  { id: '1d', label: '1 day' },
  { id: '3d', label: '3 days' },
  { id: '1w', label: '1 week' },
  { id: '30d', label: '1 month' },
];

/** How long an ended session stays, in the order the settings show the choices. */
export const ENDED_OPTIONS: { id: EndedAfter; label: string }[] = [
  { id: 'now', label: 'Right away' },
  { id: '1d', label: '1 day' },
  { id: '1w', label: '1 week' },
];

const LABEL = new Map<string, string>(
  [...QUIET_OPTIONS, ...ENDED_OPTIONS].map((o) => [o.id, o.label.toLowerCase()]),
);

/** One line on what the live list leaves out, e.g. "Quiet sessions leave after 1 week, ...". */
export function keepNote({ quiet, ended }: SessionSettings): string {
  const part = (what: string, after: string) =>
    after === 'now' ? `${what} leave right away` : `${what} leave after ${LABEL.get(after)}`;
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
