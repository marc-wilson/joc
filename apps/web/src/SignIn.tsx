import { Button, EmptyState } from '@joc/ui';
import type { ReactNode } from 'react';
import { signIn, signInNote, useAuth } from './auth.ts';

function SignIn() {
  return (
    <div className="joc-app app">
      <main className="joc-app__main">
        <EmptyState
          icon="lock"
          title="Sign in to JOC"
          body={
            signInNote && signInNote !== 'requested'
              ? "GitHub sign-in didn't finish. Try again."
              : 'JOC shows your live Claude Code sessions. Sign in with your GitHub account to see yours.'
          }
          action={
            <Button variant="primary" onClick={signIn}>
              Sign in with GitHub
            </Button>
          }
        />
      </main>
    </div>
  );
}

/** Shows the sign-in screen until the server knows this browser, and again after any 401. */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  if (auth.status === 'checking') return null;
  return auth.status === 'signedOut' ? <SignIn /> : children;
}
