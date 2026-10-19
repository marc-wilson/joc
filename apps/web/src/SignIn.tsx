import { Button, EmptyState, TextInput } from '@joc/ui';
import { type FormEvent, type ReactNode, useState } from 'react';
import { signIn, useAuth } from './auth.ts';

function SignIn() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const token = String(new FormData(e.currentTarget).get('token') ?? '').trim();
    if (!token) return setError('Paste your token first');
    setBusy(true);
    setError(undefined);
    if (!(await signIn(token))) {
      setError("That token didn't work");
      setBusy(false);
    }
  }

  return (
    <div className="joc-app app">
      <main className="joc-app__main">
        <EmptyState
          icon="lock"
          title="Sign in to JOC"
          body="Paste your JOC token. It's the JOC_TOKEN this site runs with."
          action={
            <form className="joc-stack" onSubmit={(e) => void submit(e)}>
              <TextInput
                id="joc-token"
                name="token"
                type="password"
                autoComplete="current-password"
                placeholder="Paste your JOC token"
                mono
                autoFocus
                error={error}
              />
              <Button type="submit" variant="primary" loading={busy}>
                Sign in
              </Button>
            </form>
          }
        />
      </main>
    </div>
  );
}

/** Shows the sign-in screen until the server accepts this browser, and again after any 401. */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  if (auth === 'checking') return null;
  return auth === 'signedOut' ? <SignIn /> : children;
}
