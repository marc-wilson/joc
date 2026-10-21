// The owner's dashboard settings. One document per owner; an owner who never saved any gets the
// defaults.
import { getDb } from '@joc/db';
import {
  DEFAULT_SESSION_SETTINGS,
  ReviewSettings,
  type SessionSettings,
  StoredSessionSettings,
  settleSessionSettings,
} from '@joc/protocol';
import type { Owner } from './owner.ts';

interface SettingsDoc {
  /** The owner. */
  _id: string;
  /** Saved before the keep times changed, it may hold one no longer offered (settled on read). */
  sessions?: StoredSessionSettings;
  review?: ReviewSettings;
  updatedAt: Date;
}

const settings = () => getDb().collection<SettingsDoc>('settings');

/**
 * Which sessions the owner's live list keeps. A keep time saved before the choices changed reads
 * as the nearest one offered now.
 */
export async function getSessionSettings(owner: Owner): Promise<SessionSettings> {
  const doc = await settings().findOne({ _id: owner });
  // A stored value from an older shape falls back to the defaults rather than failing the list.
  const parsed = StoredSessionSettings.safeParse(doc?.sessions);
  return parsed.success ? settleSessionSettings(parsed.data) : DEFAULT_SESSION_SETTINGS;
}

export async function saveSessionSettings(owner: Owner, value: SessionSettings): Promise<void> {
  await settings().updateOne(
    { _id: owner },
    { $set: { sessions: value, updatedAt: new Date() } },
    { upsert: true },
  );
}

/** The owner's review instructions; none means Claude's standard review. */
export async function getReviewSettings(owner: Owner): Promise<ReviewSettings> {
  const stored: unknown = (await settings().findOne({ _id: owner }))?.review;
  // The older shape: `{ method: 'standard' | 'own', command }`. Their own command carries over.
  const old = stored as { method?: unknown; command?: unknown } | undefined;
  if (old?.method === 'own' && typeof old.command === 'string') {
    return { instructions: old.command };
  }
  const parsed = ReviewSettings.safeParse(stored);
  return parsed.success && parsed.data.instructions ? parsed.data : {};
}

export async function saveReviewSettings(owner: Owner, review: ReviewSettings): Promise<void> {
  const value = review.instructions ? { instructions: review.instructions } : {};
  await settings().updateOne(
    { _id: owner },
    { $set: { review: value, updatedAt: new Date() } },
    { upsert: true },
  );
}
