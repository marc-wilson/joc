// What a calm re-sort of the session list moves (see held-order.ts).

/** At most one live settle in this long. */
export const SETTLE_EVERY_MS = 5_000;

/** The rows a settle fades: those whose slot changes, and those that leave. */
export function movedIds(shown: string[], target: string[]): string[] {
  const at = new Map(target.map((id, i) => [id, i]));
  return shown.filter((id, i) => at.get(id) !== i);
}

/**
 * How many rows wait to move: the fewest that must change place (those off the longest run
 * already in order), plus the ones waiting to leave.
 */
export function waitingCount(shown: string[], target: string[]): number {
  const at = new Map(target.map((id, i) => [id, i]));
  const places = shown.flatMap((id) => at.get(id) ?? []);
  const leaving = shown.length - places.length;
  // Longest increasing run, by patience sorting.
  const tails: number[] = [];
  for (const p of places) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((tails[mid] ?? 0) < p) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = p;
  }
  return places.length - tails.length + leaving;
}
