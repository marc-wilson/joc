import {
  MAX_PREF_ITEMS,
  MAX_PREF_SESSIONS,
  type PrefsPatch,
  type SessionPrefsPatch,
} from '@joc/protocol';

// What dashboards before server-kept prefs stored in the browser, read once to move it over.

const SESSION_PREFIXES = ['joc:folded-messages:', 'joc:folded:', 'joc:viewed:'] as const;
const KEYS = [
  'joc.browserNotifications',
  'joc:pinned',
  'joc:folded-groups',
  'joc:list-folded',
  'joc:diff-mode',
  'joc.plugin-banner.dismissed',
];

/** Which of `keys` (a browser storage's) an older dashboard wrote. */
export const legacyKeys = (keys: string[]) =>
  keys.filter((k) => KEYS.includes(k) || SESSION_PREFIXES.some((p) => k.startsWith(p)));

const json = (raw: string | null): unknown => {
  try {
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
};

/** Its strings, newest last, within the cap; undefined when there are none. */
function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return list.length ? list.slice(-MAX_PREF_ITEMS) : undefined;
}

/** The prefs an older dashboard kept under `keys`, as a patch the server takes. */
export function legacyPatch(read: (key: string) => string | null, keys: string[]): PrefsPatch {
  const patch: PrefsPatch = {};
  if (read('joc.browserNotifications') === 'on') patch.browserNotifications = true;
  const pinned = strings(json(read('joc:pinned')));
  if (pinned) patch.pinned = pinned;
  const groups = strings(json(read('joc:folded-groups')));
  if (groups) patch.foldedGroups = groups;
  if (json(read('joc:list-folded')) === true) patch.listFolded = true;
  if (json(read('joc:diff-mode')) === 'split') patch.diffMode = 'split';
  const banner = read('joc.plugin-banner.dismissed');
  if (banner && banner.length <= 100) patch.dismissedPluginBanner = banner;

  const sessions = new Map<string, SessionPrefsPatch>();
  for (const key of keys) {
    const prefix = SESSION_PREFIXES.find((p) => key.startsWith(p));
    const id = prefix && key.slice(prefix.length);
    if (!id) continue;
    const session = sessions.get(id) ?? { id };
    const value = json(read(key));
    if (prefix === 'joc:folded-messages:') session.foldedMessages = strings(value);
    if (prefix === 'joc:viewed:') session.viewedFiles = strings(value);
    if (prefix === 'joc:folded:' && value && typeof value === 'object') {
      const entries = Object.entries(value);
      session.foldedFiles = strings(entries.filter(([, v]) => v === true).map(([k]) => k));
      session.openedFiles = strings(entries.filter(([, v]) => v === false).map(([k]) => k));
    }
    sessions.set(id, session);
  }
  const kept = [...sessions.values()]
    .filter((s) => s.foldedMessages || s.viewedFiles || s.foldedFiles || s.openedFiles)
    .slice(-MAX_PREF_SESSIONS);
  if (kept.length) patch.sessions = kept;
  return patch;
}
