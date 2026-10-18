// Delivers prompts typed in the JOC dashboard into this session. Reporting the session's state
// and conversation is done by the command hooks in hooks.json (src/hook.ts); this module only
// polls the server for queued prompts and submits them as if typed here.
import type { Register } from 'claude-code';

const POLL_MS = 2000;

interface QueuedPrompt {
  id: string;
  text: string;
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e);
    // Nobody reads a -p run's dashboard; only take prompts for sessions a person runs.
    if (!e.isInteractive) return result;
    const server = ((await $.env.get('JOC_URL')) ?? 'http://localhost:3000').replace(/\/$/, '');

    async function takePrompts() {
      // Read each time: a /clear starts a new session id without a new session.start.
      const sessionId = await $.session.id();
      const res = await $.http.fetch(
        `${server}/api/sessions/${encodeURIComponent(sessionId)}/prompts/claim`,
        { method: 'POST' },
      );
      if (!res.ok) return;
      const { prompts } = JSON.parse(res.text) as { prompts: QueuedPrompt[] };
      // Each starts its own turn once the session is idle, in the order they were sent.
      for (const prompt of prompts) await $.prompt.submit({ text: prompt.text, asUser: true });
    }

    let busy = false;
    $.clock.every(POLL_MS, () => {
      if (busy) return;
      busy = true;
      takePrompts()
        .catch(() => {}) // The server being down must never bother the session.
        .finally(() => {
          busy = false;
        });
    });
    return result;
  });
};
