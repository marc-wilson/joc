// The owner's dashboard settings. One document per owner; an owner who never saved any gets the
// defaults.
import { getDb } from '@joc/db';
import { DEFAULT_SESSION_SETTINGS, type ReviewSettings, SessionSettings } from '@joc/protocol';
import type { Owner } from './owner.ts';

interface SettingsDoc {
  /** The owner. */
  _id: string;
  sessions?: SessionSettings;
  review?: ReviewSettings;
  updatedAt: Date;
}

const settings = () => getDb().collection<SettingsDoc>('settings');

/** Which sessions the owner's live list keeps. */
export async function getSessionSettings(owner: Owner): Promise<SessionSettings> {
  const doc = await settings().findOne({ _id: owner });
  // A stored value from an older shape falls back to the defaults rather than failing the list.
  const parsed = SessionSettings.safeParse(doc?.sessions);
  return parsed.success ? parsed.data : DEFAULT_SESSION_SETTINGS;
}

export async function saveSessionSettings(owner: Owner, value: SessionSettings): Promise<void> {
  await settings().updateOne(
    { _id: owner },
    { $set: { sessions: value, updatedAt: new Date() } },
    { upsert: true },
  );
}

/** Claude's standard review until the person picks their own. */
const DEFAULT_REVIEW: ReviewSettings = { method: 'standard' };

export async function getReviewSettings(owner: Owner): Promise<ReviewSettings> {
  return (await settings().findOne({ _id: owner }))?.review ?? DEFAULT_REVIEW;
}

export async function saveReviewSettings(owner: Owner, review: ReviewSettings): Promise<void> {
  await settings().updateOne(
    { _id: owner },
    { $set: { review, updatedAt: new Date() } },
    { upsert: true },
  );
}
