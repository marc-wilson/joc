// The owner's dashboard preferences: pins, folds, the notifications switch. Kept in the owner's
// settings document (see settings.ts) under `prefs`, so they follow them to every browser.
import { getDb } from '@joc/db';
import {
  applyPrefsPatch,
  DEFAULT_PREFS,
  Prefs,
  type PrefsPatch,
  type PrefsSnapshot,
} from '@joc/protocol';
import { publish } from './bus.ts';
import type { Owner } from './owner.ts';
import { knownSessionIds } from './sessions.ts';

interface PrefsDoc {
  /** The owner. */
  _id: string;
  prefs?: Prefs;
  /** Bumped on every write, so concurrent patches from two tabs both land. */
  prefsRev?: number;
  updatedAt: Date;
}

const settings = () => getDb().collection<PrefsDoc>('settings');

/** Well under Mongo's 16MB document limit, with room for the other settings. */
const MAX_PREFS_BYTES = 256 * 1024;

/** A stored value from an older shape keeps what still fits, over the defaults. */
function parse(stored: unknown): Prefs {
  const parsed = Prefs.safeParse({ ...DEFAULT_PREFS, ...(stored as object) });
  return parsed.success ? parsed.data : DEFAULT_PREFS;
}

export async function getPrefs(owner: Owner): Promise<PrefsSnapshot> {
  const doc = await settings().findOne({ _id: owner }, { projection: { prefs: 1 } });
  return { saved: doc?.prefs !== undefined, prefs: parse(doc?.prefs) };
}

/** Drops pins and per-session entries for sessions the owner doesn't have, and keeps it small. */
async function prune(owner: Owner, prefs: Prefs): Promise<Prefs> {
  const known = await knownSessionIds(owner, [
    ...new Set([...prefs.pinned, ...prefs.sessions.map((s) => s.id)]),
  ]);
  const sessions = prefs.sessions.filter((s) => known.has(s.id));
  const pruned = { ...prefs, pinned: prefs.pinned.filter((id) => known.has(id)), sessions };
  // Sessions are oldest first: drop from the front until it fits.
  while (sessions.length && JSON.stringify(pruned).length > MAX_PREFS_BYTES) sessions.shift();
  return pruned;
}

const isDuplicateKey = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;

/** Applies `patch` to the owner's prefs, tells their open tabs, and returns the result. */
export async function patchPrefs(owner: Owner, patch: PrefsPatch): Promise<Prefs> {
  for (let attempt = 0; ; attempt++) {
    const doc = await settings().findOne({ _id: owner }, { projection: { prefs: 1, prefsRev: 1 } });
    const rev = doc?.prefsRev;
    const next = await prune(owner, applyPrefsPatch(parse(doc?.prefs), patch, Date.now()));
    try {
      // Only if nobody wrote since the read; otherwise read again and reapply.
      const { matchedCount, upsertedCount } = await settings().updateOne(
        { _id: owner, prefsRev: rev ?? { $exists: false } },
        { $set: { prefs: next, prefsRev: (rev ?? 0) + 1, updatedAt: new Date() } },
        { upsert: true },
      );
      if (matchedCount + upsertedCount === 1) {
        // Every open tab of the owner hears the new prefs.
        publish(owner, { type: 'prefs', prefs: next });
        return next;
      }
    } catch (error) {
      // Another write landed first: the upsert hit the existing _id.
      if (!isDuplicateKey(error) || attempt >= 4) throw error;
    }
  }
}
