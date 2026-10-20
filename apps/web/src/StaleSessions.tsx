import type { StaleSession } from '@joc/protocol';
import { SessionLink } from '@joc/ui';
import { useState } from 'react';
import { apiFetch } from './auth.ts';
import { RELOAD_COMMAND, sessionHref, staleName } from './version.ts';

// Live sessions that still run an old copy of the plugin, and reloading them from here: the
// dashboard sends `/reload-plugins` to each as it sends any slash command, and the session's
// plugin runs it (every plugin that names its version can).

/** Links to each session still running an old copy, with the version it runs. */
export function StaleSessions({ sessions }: { sessions: StaleSession[] }) {
  return (
    <ul className="app-stale">
      {sessions.map((s) => (
        <li key={s.id} className="app-stale__item">
          <SessionLink title={staleName(s)} state={s.state} href={sessionHref(s.id)} />
          <span className="app-stale__version">{s.plugin}</span>
        </li>
      ))}
    </ul>
  );
}

export interface Reload {
  /** Sends `/reload-plugins` to each session. */
  send: (ids: string[]) => Promise<void>;
  busy: boolean;
  /** The sessions it was sent to, from this page. */
  sent: ReadonlySet<string>;
  /** The last send didn't reach every session. */
  failed: boolean;
}

/** Sending `/reload-plugins`; `onSent` hears when it went, to check again once they reload. */
export function useReload(onSent: () => void): Reload {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState(false);

  async function sendOne(id: string): Promise<boolean> {
    const res = await apiFetch(`/api/sessions/${encodeURIComponent(id)}/prompts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: RELOAD_COMMAND }),
    }).catch(() => undefined);
    return !!res?.ok;
  }

  async function send(ids: string[]) {
    setBusy(true);
    setFailed(false);
    const pending = ids.filter((id) => !sent.has(id));
    const results = await Promise.all(pending.map(sendOne));
    const reached = pending.filter((_, i) => results[i]);
    setSent((before) => new Set([...before, ...reached]));
    setFailed(reached.length < pending.length);
    setBusy(false);
    if (reached.length) onSent();
  }

  return { send, busy, sent, failed };
}
