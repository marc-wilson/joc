// How long a session's polls hold off while the server is down. Every poll keeps its own fixed
// pace otherwise, so an outage would be each session asking every few seconds for as long as it
// lasts, each failure another line in the problem log.
//
// The wait grows with how long the server has been down rather than with how many requests failed,
// as several polls report here and each would otherwise speed the others' backoff up. A deploy's
// few seconds barely slow anything; a real outage settles at one attempt per MAX_WAIT_MS.
//
// Pure functions, no runtime imports: register.ts runs in the engine, which has no Node.
import type { Outcome } from './problems.ts';

/** The longest a session goes without trying, and so the longest it takes to notice a recovery. */
export const MAX_WAIT_MS = 60_000;

export interface Backoff {
  /** When the current run of failures began; unset while the server answers. */
  downSince?: number;
  /** No poll before this, ms since epoch. */
  until: number;
}

export const NOT_WAITING: Backoff = { until: 0 };

/** Whether this attempt says the server is down, says it's up, or says nothing about it. */
function verdict(outcome: Outcome): 'down' | 'up' | undefined {
  if (outcome.ok) return outcome.where.startsWith('/') ? 'up' : undefined;
  if (outcome.kind === 'unreachable' || outcome.kind === 'server-error') return 'down';
  // A request refused or a token turned down: the server answered, so it's up.
  return outcome.kind === 'crash' ? undefined : 'up';
}

/** The backoff after an attempt. A single 5xx route clears as soon as another route answers. */
export function afterOutcome(backoff: Backoff, outcome: Outcome): Backoff {
  const seen = verdict(outcome);
  if (seen === 'up') return NOT_WAITING;
  if (seen !== 'down') return backoff;
  const downSince = backoff.downSince ?? outcome.at;
  return { downSince, until: outcome.at + Math.min(outcome.at - downSince, MAX_WAIT_MS) };
}

export const holdsOff = (backoff: Backoff, now: number) => now < backoff.until;
