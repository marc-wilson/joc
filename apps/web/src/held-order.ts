import { useCallback, useEffect, useRef, useState } from 'react';
import { movedIds, SETTLE_EVERY_MS, waitingCount } from './resort.ts';

// The session list re-sorts calmly: while the pointer or keyboard focus is in it, rows keep their
// places and the sort bar counts what waits. Once it's left alone for --delay-settle, only the
// rows that change place fade out, swap while invisible, and fade back in. Coming back mid-swap
// fades them back where they were. Live settles come at most once every SETTLE_EVERY_MS.

const ms = (name: string, fallback: number) => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n)) return fallback;
  return raw.endsWith('ms') ? n : raw.endsWith('s') ? n * 1000 : n;
};

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export interface HeldOrder {
  /** The ids in the order shown. */
  order: string[];
  /** Fading out before a swap, or back in after one. */
  leaving: Set<string>;
  arriving: Set<string>;
  /** Rows waiting to move while the list is held. */
  waiting: number;
  /** Bumped on every settle that moved rows, for a screen reader's "Sessions re-sorted". */
  settles: number;
}

/**
 * The order the list shows `target` in. `arrange` lays out the rows as shown for an order held
 * from before: rows still there keep their places, new ones join the end of their group, and
 * rows due to leave (a finished review past its time) may stay until the next settle. `held`
 * keeps the order in place; `immediate` changing (a new sort, filter or pin: something you asked
 * for) applies the target at once.
 */
export function useHeldOrder(
  target: string[],
  arrange: (order: string[]) => string[],
  held: boolean,
  immediate: string,
): HeldOrder {
  const [order, setOrder] = useState(target);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [arriving, setArriving] = useState<Set<string>>(new Set());
  const [settles, setSettles] = useState(0);
  const latest = useRef({ target, arrange, held });
  latest.current = { target, arrange, held };
  const lastSettle = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearTimers = useCallback(() => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  }, []);
  const later = (fn: () => void, wait: number) => {
    timers.current.push(setTimeout(fn, wait));
  };

  const shown = arrange(order);
  const key = target.join('\n');
  const shownKey = shown.join('\n');

  // Something you asked for applies at once, pointer or not.
  const asked = useRef(immediate);
  if (asked.current !== immediate) {
    asked.current = immediate;
    setOrder(target);
    setLeaving(new Set());
    setArriving(new Set());
  }

  const fadeIn = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () => () => {
      clearTimers();
      clearTimeout(fadeIn.current);
    },
    [clearTimers],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the orders' contents
  useEffect(() => {
    clearTimers();
    // Back mid-swap, or the sessions changed during it: the rows fade back in where they were,
    // and a later settle moves them.
    setLeaving((l) => (l.size ? new Set() : l));
    if (held) return;
    if (key === shownKey) {
      // Nothing to move: what's shown becomes the order to hold from.
      if (order.join('\n') !== key) setOrder(target);
      return;
    }
    const settle = () => {
      const now = latest.current;
      if (now.held) return;
      const from = now.arrange(order);
      const moved = movedIds(from, now.target);
      lastSettle.current = Date.now();
      if (!moved.length) {
        setOrder(now.target);
        return;
      }
      const fade = reducedMotion() ? 0 : ms('--duration-fade', 240);
      const swap = () => {
        const then = latest.current;
        if (then.held) {
          setLeaving(new Set());
          return;
        }
        setOrder(then.target);
        setLeaving(new Set());
        setSettles((n) => n + 1);
        if (!fade) return;
        // Rendered invisible in their new places first, then faded in.
        setArriving(new Set(moved));
        // Not one of the settle's timers: the reorder re-runs the effect, which clears those.
        clearTimeout(fadeIn.current);
        fadeIn.current = setTimeout(() => setArriving(new Set()), 32);
      };
      if (!fade) return swap();
      setLeaving(new Set(moved));
      later(swap, fade);
    };
    const settleAfter = ms('--delay-settle', 400);
    const wait = Math.max(settleAfter, lastSettle.current + SETTLE_EVERY_MS - Date.now());
    later(settle, wait);
  }, [held, key, shownKey]);

  return {
    order: shown,
    leaving,
    arriving,
    waiting: held ? waitingCount(shown, target) : 0,
    settles,
  };
}
