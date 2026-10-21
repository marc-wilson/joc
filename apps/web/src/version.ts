import type { Device, StaleSession } from '@joc/protocol';

/** Updates the plugin, in a terminal on the machine. `/reload-plugins` then loads it. */
export const UPDATE_COMMAND =
  'claude plugin marketplace update joc && claude plugin update joc@joc';

/** Loads the installed plugin into a session that still runs an old copy. */
export const RELOAD_COMMAND = '/reload-plugins';

/**
 * What changed in the plugin: its commits in JOC's public repo, newest first. Releases aren't
 * tagged, so there's no range between two versions to link to; each commit bumps the version it
 * ships in.
 */
export const WHATS_NEW_URL = 'https://github.com/marc-wilson/joc/commits/main/apps/plugin';

/** "harbor-mbp", "harbor-mbp and studio-mini", "harbor-mbp, studio-mini and ci-box". */
function names(list: string[]): string {
  return list.length < 2 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}

/** The banner's title for the machines whose plugin is behind `latest`. */
export function behindTitle(behind: Device[], latest: string): string {
  const [only] = behind;
  if (behind.length === 1 && only?.installed) {
    return `${only.name} has JOC plugin ${only.installed} installed, behind ${latest}`;
  }
  if (behind.length === 1 && only?.plugin) {
    return `${only.name} runs JOC plugin ${only.plugin}, behind ${latest}`;
  }
  const verb = behind.length === 1 ? 'runs' : 'run';
  return `${names(behind.map((d) => d.name))} ${verb} an older JOC plugin than ${latest}`;
}

/**
 * The live sessions that only need `/reload-plugins`: those still running an old copy on a
 * machine that has the current plugin installed. A machine that needs the update first is the
 * other banner's, which says to reload afterwards.
 */
export const reloadable = (devices: Device[]): StaleSession[] =>
  devices.filter((d) => !d.outdated).flatMap((d) => d.stale);

/** "1 session still runs JOC plugin 0.6.0", "3 sessions still run older JOC plugins". */
export function staleTitle(stale: StaleSession[]): string {
  const versions = new Set(stale.map((s) => s.plugin));
  const [version] = versions;
  const count = stale.length === 1 ? '1 session still runs' : `${stale.length} sessions still run`;
  return versions.size === 1 ? `${count} JOC plugin ${version}` : `${count} older JOC plugins`;
}

/** What a stale session is called in the banner: Claude Code's name for it, else its repo. */
export const staleName = (s: StaleSession): string => s.title ?? s.repo;

const staleId = (s: StaleSession) => `${s.id}@${s.plugin}`;

/** Names a set of stale sessions, to remember a dismissed banner by. */
export const staleKey = (stale: StaleSession[]): string => stale.map(staleId).sort().join(' ');

/**
 * Whether the banner for `stale` was dismissed: every session in it was in the set dismissed.
 * One reloading keeps it dismissed; a new one brings it back.
 */
export function staleDismissed(stale: StaleSession[], dismissed: string | undefined): boolean {
  if (!dismissed) return false;
  const seen = new Set(dismissed.split(' '));
  return stale.every((s) => seen.has(staleId(s)));
}

/** The link that opens a session on the dashboard. */
export const sessionHref = (id: string) => `/?session=${encodeURIComponent(id)}`;
