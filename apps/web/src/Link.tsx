import { Device } from '@joc/protocol';
import { Button, EmptyState, NavBar, SectionHeader, TextInput } from '@joc/ui';
import { type FormEvent, useEffect, useState } from 'react';
import { z } from 'zod';
import { apiFetch, signOut, useAuth } from './auth.ts';
import { age } from './time.ts';

const Devices = z.array(Device);

async function fetchDevices(): Promise<Device[] | undefined> {
  const res = await apiFetch('/api/devices').catch(() => undefined);
  return res?.ok ? Devices.parse(await res.json()) : undefined;
}

/** /link: approve a machine's /joc-login code, and see or revoke linked machines. */
export function LinkPage() {
  const auth = useAuth();
  const user = auth.status === 'signedIn' ? auth.user : undefined;
  const [devices, setDevices] = useState<Device[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [linked, setLinked] = useState(false);

  const load = () => fetchDevices().then((list) => list && setDevices(list));

  useEffect(() => {
    void fetchDevices().then((list) => list && setDevices(list));
  }, []);

  async function approve(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const userCode = String(new FormData(e.currentTarget).get('code') ?? '').trim();
    if (!userCode) return setError('Enter the code /joc-login showed');
    setBusy(true);
    setError(undefined);
    const res = await apiFetch('/api/devices/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userCode }),
    }).catch(() => undefined);
    setBusy(false);
    if (res?.ok) {
      setLinked(true);
      // The machine shows up once its plugin picks up the token, within a few seconds.
      setTimeout(() => void load(), 4000);
      return;
    }
    const body: unknown = await res?.json().catch(() => undefined);
    const message = z.object({ error: z.string() }).safeParse(body);
    setError(message.success ? message.data.error : "Couldn't reach JOC. Try again.");
  }

  async function revoke(id: string) {
    const res = await apiFetch(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) setDevices((list) => list?.filter((d) => d.id !== id));
  }

  return (
    <div className="joc-app app">
      <NavBar
        items={[
          { id: 'sessions', label: 'Sessions', href: '/' },
          { id: 'machines', label: 'Machines', href: '/link' },
        ]}
        value="machines"
        user={user?.login}
      />
      <main className="joc-app__main app-page">
        <SectionHeader
          size="lg"
          title="Link a machine"
          description="In Claude Code, run /joc-login and enter the code it shows."
        >
          {user ? (
            <Button variant="ghost" onClick={() => void signOut()}>
              Sign out @{user.login}
            </Button>
          ) : null}
        </SectionHeader>
        {linked ? (
          <EmptyState
            compact
            icon="check"
            title="Machine linked"
            body="Claude Code says which account it reports to. Its sessions show up as they work."
            action={
              <Button variant="secondary" onClick={() => setLinked(false)}>
                Link another
              </Button>
            }
          />
        ) : (
          <form className="app-link-form" onSubmit={(e) => void approve(e)}>
            <TextInput
              id="link-code"
              name="code"
              label="Code"
              placeholder="WXYZ-4821"
              autoComplete="off"
              mono
              autoFocus
              error={error}
            />
            <Button type="submit" variant="primary" loading={busy}>
              Link machine
            </Button>
          </form>
        )}

        <SectionHeader title="Your machines" count={devices?.length} />
        {devices?.length ? (
          <ul className="app-machines">
            {devices.map((d) => (
              <li key={d.id} className="app-machines__row">
                <span className="app-machines__name">{d.name}</span>
                <span className="app-machines__meta">
                  linked {age(d.createdAt)} ago · last seen {age(d.lastSeenAt)} ago
                </span>
                <Button variant="ghost" size="sm" onClick={() => void revoke(d.id)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        ) : devices ? (
          <EmptyState compact title="No machines yet" body="Link one with /joc-login." />
        ) : null}
      </main>
    </div>
  );
}
