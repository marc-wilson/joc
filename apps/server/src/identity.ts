// People and their credentials: GitHub users, browser sessions, and linked machines. Every secret
// is stored as its SHA-256 hash, so the database alone can't sign anyone in.
import { getDb } from '@joc/db';
import type {
  Device,
  DeviceStart,
  DeviceToken,
  PendingDevice,
  PluginVersion,
  StaleSession,
  User,
} from '@joc/protocol';
import { type Owner, ownerFrom } from './owner.ts';
import { hashSecret, newSecret } from './secrets.ts';
import { isBehind } from './version.ts';

const SESSION_DAYS = 30;
const LINK_MINUTES = 10;
const POLL_SECONDS = 2;
/** No 0/O or 1/I: codes get read off a screen and typed. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

interface UserDoc {
  /** `gh_<github id>`; also the owner id of everything the user stores. */
  _id: string;
  githubId: number;
  login: string;
  name?: string;
  avatarUrl?: string;
  createdAt: Date;
  lastSignInAt: Date;
  /** The JOC GitHub App's installations the user can reach: their account's, or an org's. */
  installations?: number[];
}

interface WebSessionDoc {
  /** Hash of the cookie's secret. */
  _id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

interface DeviceDoc {
  /** Hash of the machine's token. */
  _id: string;
  /** Public id, for listing and revoking. */
  id: string;
  userId: string;
  name: string;
  createdAt: Date;
  lastSeenAt: Date;
  /**
   * The plugin version the machine last sent: null when it sent none (a plugin from before
   * versions were sent), unset when it hasn't been seen since.
   */
  plugin?: string | null;
  /** The plugin version installed on the machine, as its plugin last read it; unset until one
   * new enough to say does. */
  installed?: string;
}

interface LinkDoc {
  /** Hash of the device code the plugin polls with. */
  _id: string;
  userCode: string;
  name: string;
  createdAt: Date;
  expiresAt: Date;
  /** Set when a signed-in person enters the code. */
  userId?: string;
}

const db = () => getDb();
const users = () => db().collection<UserDoc>('users');
const webSessions = () => db().collection<WebSessionDoc>('web_sessions');
const devices = () => db().collection<DeviceDoc>('devices');
const links = () => db().collection<LinkDoc>('device_links');

let indexed: Promise<unknown> | undefined;
/** TTL indexes let Mongo delete expired sessions and links on its own. */
export function ensureIdentityIndexes(): Promise<unknown> {
  indexed ??= Promise.all([
    webSessions().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    links().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    links().createIndex({ userCode: 1 }, { unique: true }),
    devices().createIndex({ id: 1 }, { unique: true }),
    devices().createIndex({ userId: 1 }),
    users().createIndex({ githubId: 1 }),
    users().createIndex({ login: 1 }),
    users().createIndex({ installations: 1 }),
  ]);
  return indexed;
}

// Mongo stores a missing name or avatar as null; the protocol leaves them out.
const toUser = (doc: UserDoc): User => ({
  login: doc.login,
  name: doc.name ?? undefined,
  avatarUrl: doc.avatarUrl ?? undefined,
});

export interface GitHubProfile {
  id: number;
  login: string;
  name?: string;
  avatarUrl?: string;
  /** With the GitHub App: the installations the user can reach, as sign-in read them. */
  installations?: number[];
}

/** Creates or refreshes the user GitHub vouched for; their owner id never changes. */
export async function signInGitHubUser(profile: GitHubProfile): Promise<Owner> {
  const now = new Date();
  const _id = `gh_${profile.id}`;
  await users().updateOne(
    { _id },
    {
      $set: {
        githubId: profile.id,
        login: profile.login,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
        lastSignInAt: now,
        ...(profile.installations ? { installations: profile.installations } : {}),
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  return ownerFrom(_id);
}

/** The JOC user behind a GitHub account, as GitHub (a webhook) names them. */
export interface GitHubPerson {
  owner: Owner;
  githubId: number;
  login: string;
  installations: number[];
}

const toPerson = (doc: UserDoc): GitHubPerson => ({
  owner: ownerFrom(doc._id),
  githubId: doc.githubId,
  login: doc.login,
  installations: doc.installations ?? [],
});

/** The owner's GitHub identity, for routing webhooks to them. */
export async function githubPerson(owner: Owner): Promise<GitHubPerson | undefined> {
  const doc = await users().findOne({ _id: owner });
  return doc ? toPerson(doc) : undefined;
}

/**
 * The JOC users among these GitHub accounts, by id or login (a mention names only a login).
 * Logins compare case-insensitively, as GitHub's do. Accounts that never signed in to JOC are
 * left out: their events go nowhere.
 */
export async function peopleOnGitHub(by: {
  ids?: number[];
  logins?: string[];
}): Promise<GitHubPerson[]> {
  const ids = [...new Set(by.ids ?? [])];
  const logins = [...new Set((by.logins ?? []).map((l) => l.toLowerCase()))];
  if (!ids.length && !logins.length) return [];
  await ensureIdentityIndexes();
  const plain = (l: string) => l.replace(/[^\w-]/g, '');
  const docs = await users()
    .find({
      $or: [
        ...(ids.length ? [{ githubId: { $in: ids } }] : []),
        ...logins.map((l) => ({ login: { $regex: `^${plain(l)}$`, $options: 'i' } })),
      ],
    })
    .toArray();
  return docs.map(toPerson);
}

/** The users who can reach an installation. */
export async function peopleOfInstallation(installationId: number): Promise<GitHubPerson[]> {
  await ensureIdentityIndexes();
  const docs = await users().find({ installations: installationId }).toArray();
  return docs.map(toPerson);
}

/** These GitHub accounts' JOC users can now reach the installation (installed or joined). */
export async function grantInstallation(githubIds: number[], installationId: number) {
  if (!githubIds.length) return;
  await users().updateMany(
    { githubId: { $in: githubIds } },
    { $addToSet: { installations: installationId } },
  );
}

/** The installation is gone: nobody reaches it any more. */
export async function revokeInstallation(installationId: number) {
  await users().updateMany(
    { installations: installationId },
    { $pull: { installations: installationId } },
  );
}

export async function getUser(owner: Owner): Promise<User | undefined> {
  const doc = await users().findOne({ _id: owner });
  return doc ? toUser(doc) : undefined;
}

// ── Browser sessions ────────────────────────────────────────────────────────

/** Starts a browser session; the returned secret goes in the cookie and nowhere else. */
export async function createWebSession(owner: Owner): Promise<string> {
  await ensureIdentityIndexes();
  const secret = newSecret();
  const now = new Date();
  await webSessions().insertOne({
    _id: hashSecret(secret),
    userId: owner,
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_DAYS * 86_400_000),
  });
  return secret;
}

export async function resolveWebSession(secret: string): Promise<Owner | undefined> {
  const doc = await webSessions().findOne({ _id: hashSecret(secret) });
  // The TTL index deletes expired sessions within a minute; this covers the minute.
  if (!doc || doc.expiresAt <= new Date()) return undefined;
  return ownerFrom(doc.userId);
}

export async function endWebSession(secret: string): Promise<void> {
  await webSessions().deleteOne({ _id: hashSecret(secret) });
}

// ── Machines ────────────────────────────────────────────────────────────────

function userCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** What a person typed, the way codes are stored: `wxyz 4821` → `WXYZ-4821`. */
export function normalizeUserCode(typed: string): string {
  const chars = typed.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return chars.length === 8 ? `${chars.slice(0, 4)}-${chars.slice(4)}` : chars;
}

/** A plugin asks to link its machine: it keeps the device code, the person gets the user code. */
export async function startLink(name: string, publicUrl: string): Promise<DeviceStart> {
  await ensureIdentityIndexes();
  const deviceCode = newSecret();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + LINK_MINUTES * 60_000);
  for (;;) {
    const code = userCode();
    try {
      await links().insertOne({
        _id: hashSecret(deviceCode),
        userCode: code,
        name,
        createdAt,
        expiresAt,
      });
      return {
        deviceCode,
        userCode: code,
        verificationUri: `${publicUrl}/link`,
        // The user code only, never the device code: the link is safe to show and to open.
        verificationUriComplete: `${publicUrl}/link?code=${code}`,
        expiresIn: LINK_MINUTES * 60,
        interval: POLL_SECONDS,
      };
    } catch (error) {
      // A user code still in use (rare): draw another.
      if (!isDuplicateKey(error)) throw error;
    }
  }
}

/** The machine waiting on a code, so the person can see what they're about to link. */
export async function pendingLink(typed: string): Promise<PendingDevice | undefined> {
  const link = await links().findOne({
    userCode: normalizeUserCode(typed),
    userId: { $exists: false },
    expiresAt: { $gt: new Date() },
  });
  return link ? { name: link.name, requestedAt: link.createdAt.toISOString() } : undefined;
}

/** The signed-in person entered a code; true when it matched a live, unclaimed link. */
export async function approveLink(owner: Owner, typed: string): Promise<boolean> {
  const result = await links().updateOne(
    {
      userCode: normalizeUserCode(typed),
      userId: { $exists: false },
      expiresAt: { $gt: new Date() },
    },
    { $set: { userId: owner } },
  );
  return result.modifiedCount === 1;
}

/** The plugin's poll. Once approved, the link is spent and its token handed over exactly once. */
export async function pollLink(deviceCode: string): Promise<DeviceToken> {
  const _id = hashSecret(deviceCode);
  const link = await links().findOne({ _id });
  if (!link || link.expiresAt <= new Date()) return { status: 'expired' };
  if (!link.userId) return { status: 'pending' };
  // Delete first: if two polls race, only the one whose delete lands gets the token.
  const { deletedCount } = await links().deleteOne({ _id, userId: link.userId });
  if (deletedCount !== 1) return { status: 'expired' };
  const owner = ownerFrom(link.userId);
  const token = await createDeviceToken(owner, link.name);
  const user = await getUser(owner);
  return { status: 'linked', token, login: user?.login ?? owner };
}

/** Issues a machine's token. Exported for tests; machines get one through a link. */
export async function createDeviceToken(owner: Owner, name: string): Promise<string> {
  await ensureIdentityIndexes();
  const token = newSecret();
  const now = new Date();
  await devices().insertOne({
    _id: hashSecret(token),
    id: newSecret(9),
    userId: owner,
    name,
    createdAt: now,
    lastSeenAt: now,
  });
  return token;
}

/** When each machine was last written down, and with which plugin versions. */
const seen = new Map<string, { at: number; plugin: string | null; installed?: string }>();

/** What a plugin's request said about its versions; `undefined` where it said nothing. */
export interface SentVersions {
  /** The version the requesting session runs. */
  plugin?: PluginVersion;
  /** The version installed on the machine. */
  installed?: PluginVersion;
}

/** A machine's token, resolved: whose it is, and the machine's public id. */
export interface ResolvedDevice {
  owner: Owner;
  device: string;
}

/**
 * The owner of a machine's token, noting that the machine was seen and the plugin versions it
 * sent. An installed version, once sent, stays until another replaces it: requests from a plugin
 * too old to read it don't clear it.
 */
export async function resolveDeviceToken(
  token: string,
  sent: SentVersions = {},
): Promise<ResolvedDevice | undefined> {
  const _id = hashSecret(token);
  const doc = await devices().findOne({ _id });
  if (!doc) return undefined;
  // At most once a minute per machine, or at once when a version changed.
  const now = Date.now();
  const plugin = sent.plugin ?? null;
  const last = seen.get(_id);
  const installed = sent.installed ?? last?.installed;
  if (!last || now - last.at > 60_000 || last.plugin !== plugin || last.installed !== installed) {
    seen.set(_id, { at: now, plugin, installed });
    await devices().updateOne(
      { _id },
      {
        $set: {
          lastSeenAt: new Date(now),
          plugin,
          ...(sent.installed ? { installed: sent.installed } : {}),
        },
      },
    );
  }
  return { owner: ownerFrom(doc.userId), device: doc.id };
}

/**
 * The owner's machines; `latest` is the plugin version they should run, and `stale` their live
 * sessions behind it, by machine id.
 */
export async function listDevices(
  owner: Owner,
  latest: PluginVersion,
  stale: ReadonlyMap<string, StaleSession[]> = new Map(),
): Promise<Device[]> {
  const docs = await devices().find({ userId: owner }).sort({ createdAt: 1 }).toArray();
  return docs.map((d) => ({
    id: d.id,
    name: d.name,
    createdAt: d.createdAt.toISOString(),
    lastSeenAt: d.lastSeenAt.toISOString(),
    plugin: d.plugin ?? undefined,
    installed: d.installed ?? undefined,
    outdated: needsUpdate(d, latest),
    stale: stale.get(d.id) ?? [],
  }));
}

/**
 * Whether a machine needs the update command. What's installed decides when the machine says;
 * an open session that hasn't reloaded doesn't make it behind. A machine whose plugins are too
 * old to say is judged as before, by the plugin its latest request ran.
 */
function needsUpdate(d: DeviceDoc, latest: PluginVersion): boolean {
  if (d.installed) return isBehind(d.installed, latest);
  // A plugin that sent no version predates sending one, so it's behind any version that does.
  return d.plugin === null || (d.plugin !== undefined && isBehind(d.plugin, latest));
}

/** Revokes one of the owner's machines; another owner's id matches nothing. */
export async function revokeDevice(owner: Owner, id: string): Promise<boolean> {
  const result = await devices().deleteOne({ id, userId: owner });
  return result.deletedCount === 1;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}
