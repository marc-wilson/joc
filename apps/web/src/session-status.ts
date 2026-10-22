import type { Session, SessionStatus } from '@joc/protocol';
import { runsAtLeast } from './slash-commands.ts';

/** The first plugin version that sends its session's status. */
const SENDS_STATUS = [0, 15, 0];

const UNTITLED = 'New session';

/** What SessionStatusPanel in @joc/ui takes (named here: this file is tested in Node). */
export interface StatusView {
  name: string;
  id: string;
  folder?: string;
  model?: string;
  version?: string;
  mcp?: SessionStatus['mcp'];
  missing: string;
}

/**
 * What a session's Status view shows: the session's own name, id and folder, then what its plugin
 * reported (null: nothing yet; undefined: still loading). What's missing says why.
 */
export function statusView(
  session: Pick<Session, 'id' | 'title' | 'cwd' | 'model' | 'plugin'>,
  status: SessionStatus | null | undefined,
): StatusView {
  const missing =
    status === undefined
      ? 'Loading'
      : runsAtLeast(session.plugin, SENDS_STATUS)
        ? 'Not reported yet'
        : 'Its plugin is too old to report this: run /joc-update in the session';
  const cwd = status?.cwd ?? session.cwd;
  const model = status?.model ?? session.model;
  return {
    name: session.title ?? UNTITLED,
    id: session.id,
    ...(cwd ? { folder: cwd } : {}),
    ...(model ? { model } : {}),
    ...(status?.version ? { version: status.version } : {}),
    ...(status ? { mcp: status.mcp } : {}),
    missing,
  };
}
