// Delivers prompts typed in the JOC dashboard into this session, and keeps the server in sync
// with it between hooks. Reporting the session's state and conversation is done by the command
// hooks in hooks.json (src/hook.ts). This module polls the server for queued prompts and
// submits them as if typed here, and every SYNC_MS runs hook.ts with a `Sync` event, so a
// session shows up without activity (e.g. open before the plugin loaded), a backlog the server
// missed while down gets sent, and the diff refreshes when files change outside Claude.
import type { Register } from 'claude-code';

const POLL_MS = 2000;
const SYNC_MS = 30_000;
const SYNC_TIMEOUT_MS = 60_000;

interface QueuedPrompt {
  id: string;
  text: string;
}

/**
 * The folder Claude Code gives the plugin's command hooks as CLAUDE_PLUGIN_DATA, where hook.ts
 * keeps its read positions. Not on `$`, so it's worked out from where an installed plugin lives:
 * `<config>/plugins/cache/<marketplace>/<plugin>/<version>` keeps its data in
 * `<config>/plugins/data/<plugin>-<marketplace>`.
 */
function pluginData(root: string): string | undefined {
  const installed = root.match(/^(.*)\/plugins\/cache\/([^/]+)\/([^/]+)\/[^/]+$/);
  if (!installed) return undefined;
  const [, config, marketplace, plugin] = installed;
  return `${config}/plugins/data/${`${plugin}@${marketplace}`.replace(/[^\w-]/g, '-')}`;
}

/** Runs `task` unless its last run is still going; never throws. */
function oneAtATime(task: () => Promise<unknown>): () => void {
  let busy = false;
  return () => {
    if (busy) return;
    busy = true;
    task()
      .catch(() => {}) // The server being down must never bother the session.
      .finally(() => {
        busy = false;
      });
  };
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e);
    const server = ((await $.env.get('JOC_URL')) ?? 'http://localhost:3000').replace(/\/$/, '');
    const token = await $.env.get('JOC_TOKEN');
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    const root = $.plugin.root.replace(/\/+$/, '').replace(/\/\.claude-plugin$/, '');

    // Every session, as the command hooks report every session.
    const sync = oneAtATime(async () => {
      // Read each time: a /clear starts a new session id without a new session.start.
      const event = {
        hook_event_name: 'Sync',
        session_id: await $.session.id(),
        cwd: await $.session.cwd(),
      };
      await $.process.run(['node', `${root}/src/hook.ts`], {
        stdin: JSON.stringify(event),
        // An empty value makes hook.ts use its own folder rather than one this process has.
        env: {
          CLAUDE_PLUGIN_ROOT: root,
          CLAUDE_PLUGIN_DATA: pluginData(root) ?? '',
          // Passed on explicitly so the sync reports where, and as whom, the prompt poll does.
          JOC_URL: server,
          ...(token ? { JOC_TOKEN: token } : {}),
        },
        timeoutMs: SYNC_TIMEOUT_MS,
      });
    });
    $.clock.after(1, sync);
    $.clock.every(SYNC_MS, sync);

    // Nobody reads a -p run's dashboard; only take prompts for sessions a person runs.
    if (!e.isInteractive) return result;

    async function takePrompts() {
      const sessionId = await $.session.id();
      const res = await $.http.fetch(
        `${server}/api/sessions/${encodeURIComponent(sessionId)}/prompts/claim`,
        { method: 'POST', headers },
      );
      if (!res.ok) return;
      const { prompts } = JSON.parse(res.text) as { prompts: QueuedPrompt[] };
      // Each starts its own turn once the session is idle, in the order they were sent.
      for (const prompt of prompts) await $.prompt.submit({ text: prompt.text, asUser: true });
    }

    $.clock.every(POLL_MS, oneAtATime(takePrompts));
    return result;
  });
};
