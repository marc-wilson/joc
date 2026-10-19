import { Device, PendingDevice } from '@joc/protocol';
import { Button, EmptyState, SectionHeader, TextInput } from '@joc/ui';
import { type FormEvent, useEffect, useState } from 'react';
import { z } from 'zod';
import { apiFetch, signOut, useAuth } from './auth.ts';
import { Nav } from './Nav.tsx';
import { ago } from './time.ts';

const Devices = z.array(Device);
const ErrorBody = z.object({ error: z.string() });

async function fetchDevices(): Promise<Device[] | undefined> {
  const res = await apiFetch('/api/devices').catch(() => undefined);
  return res?.ok ? Devices.parse(await res.json()) : undefined;
}

async function errorText(res: Response | undefined): Promise<string> {
  const body = ErrorBody.safeParse(await res?.json().catch(() => undefined));
  return body.success ? body.data.error : "Couldn't reach JOC. Try again.";
}

/** The code from a /joc-login link (`/link?code=WXYZ-4821`), if the page was opened with one. */
const codeFromUrl = () => new URLSearchParams(location.search).get('code')?.trim() || undefined;

/** /link: approve a machine's /joc-login code, and see or revoke linked machines. */
export function LinkPage() {
  const auth = useAuth();
  const user = auth.status === 'signedIn' ? auth.user : undefined;
  const [devices, setDevices] = useState<Device[]>();
  const [code, setCode] = useState(codeFromUrl);
  // The machine behind a code from the URL, shown before anything is linked.
  const [pending, setPending] = useState<PendingDevice>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [linked, setLinked] = useState(false);

  const load = () => fetchDevices().then((list) => list && setDevices(list));

  useEffect(() => {
    void fetchDevices().then((list) => list && setDevices(list));
    const fromUrl = codeFromUrl();
    if (!fromUrl) return;
    void apiFetch(`/api/devices/pending?code=${encodeURIComponent(fromUrl)}`)
      .then(async (res) => {
        if (res.ok) setPending(PendingDevice.parse(await res.json()));
        else setError(await errorText(res));
      })
      .catch(() => setError("Couldn't reach JOC. Try again."));
  }, []);

  // Never on its own: the person always clicks, so a link someone else sent can't link their
  // machine to this account unseen.
  async function approve(userCode: string) {
    if (!userCode) return setError('Enter the code /joc-login showed');
    setBusy(true);
    setError(undefined);
    const res = await apiFetch('/api/devices/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userCode }),
    }).catch(() => undefined);
    setBusy(false);
    if (!res?.ok) return setError(await errorText(res));
    setLinked(true);
    setPending(undefined);
    history.replaceState(null, '', '/link');
    // The machine shows up once its plugin picks up the token, within a few seconds.
    setTimeout(() => void load(), 4000);
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void approve(String(new FormData(e.currentTarget).get('code') ?? '').trim());
  }

  async function revoke(id: string) {
    const res = await apiFetch(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) setDevices((list) => list?.filter((d) => d.id !== id));
  }

  function startOver() {
    setLinked(false);
    setPending(undefined);
    setCode(undefined);
    setError(undefined);
    history.replaceState(null, '', '/link');
  }

  let linking: React.ReactNode;
  if (linked) {
    linking = (
      <EmptyState
        compact
        icon="check"
        title="Machine linked"
        body="Claude Code says which account it reports to. Its sessions show up as they work."
        action={
          <Button variant="secondary" onClick={startOver}>
            Link another
          </Button>
        }
      />
    );
  } else if (pending && code) {
    linking = (
      <EmptyState
        compact
        icon="terminal"
        title={`Link ${pending.name}?`}
        body={`It asked ${ago(pending.requestedAt)} with the code ${code}. Only link it if you just ran /joc-login there yourself: it will report to your account.`}
        action={
          <div className="app-actions">
            <Button variant="primary" loading={busy} onClick={() => void approve(code)}>
              Link {pending.name}
            </Button>
            <Button variant="ghost" onClick={startOver}>
              Not me
            </Button>
          </div>
        }
      />
    );
  } else {
    linking = (
      <form className="app-link-form" onSubmit={submit}>
        <TextInput
          id="link-code"
          name="code"
          label="Code"
          placeholder="WXYZ-4821"
          value={code}
          autoComplete="off"
          mono
          autoFocus
          error={error}
        />
        <Button type="submit" variant="primary" loading={busy}>
          Link machine
        </Button>
      </form>
    );
  }

  return (
    <div className="joc-app app">
      <Nav page="machines" />
      <main className="joc-app__main app-page">
        <SectionHeader
          size="lg"
          title="Link a machine"
          description="In Claude Code, run /joc-login and open the link it shows."
        >
          {user ? (
            <Button variant="ghost" onClick={() => void signOut()}>
              Sign out @{user.login}
            </Button>
          ) : null}
        </SectionHeader>
        {linking}

        <SectionHeader title="Your machines" count={devices?.length} />
        {devices?.length ? (
          <ul className="app-machines">
            {devices.map((d) => (
              <li key={d.id} className="app-machines__row">
                <span className="app-machines__name">{d.name}</span>
                <span className="app-machines__meta">
                  linked {ago(d.createdAt)} · last seen {ago(d.lastSeenAt)}
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
