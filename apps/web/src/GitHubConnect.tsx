import type { GitHubSignInNote } from '@joc/protocol';
import { Banner, Button } from '@joc/ui';
import { useState } from 'react';
import { reconnect, signInNote, useAuth } from './auth.ts';

// The app-wide notice that the person's GitHub doesn't reach JOC live yet, and how a GitHub
// sign-in that didn't finish came back. Dismissing hides it in this tab only: it's back next
// visit until it's done.

const DISMISSED_KEY = 'joc.githubBanner.dismissed';

function dismissedHere(): string | undefined {
  try {
    return sessionStorage.getItem(DISMISSED_KEY) ?? undefined;
  } catch {
    // Storage blocked: the banner shows, as if never dismissed.
    return undefined;
  }
}

function dismissHere(what: string) {
  try {
    sessionStorage.setItem(DISMISSED_KEY, what);
  } catch {
    // Storage blocked: it stays hidden until the page reloads.
  }
}

export const NOTE_TEXT: Record<GitHubSignInNote, string> = {
  failed: "GitHub sign-in didn't work. You're still signed in as before.",
  expired: 'That GitHub sign-in expired. You’re still signed in as before.',
  denied: 'GitHub sign-in was cancelled. You’re still signed in as before.',
  requested: 'Install requested. An owner of the org needs to approve it on GitHub.',
};

/** Under the nav bar on every page. */
export function GitHubConnect() {
  const auth = useAuth();
  const [dismissed, setDismissed] = useState(dismissedHere);
  const [noteShown, setNoteShown] = useState(!!signInNote);
  const github = auth.status === 'signedIn' ? auth.github : undefined;

  const dismiss = (what: string) => {
    dismissHere(what);
    setDismissed(what);
  };

  return (
    <>
      {signInNote && noteShown ? (
        <Banner
          title={NOTE_TEXT[signInNote]}
          icon="person"
          actions={
            signInNote === 'requested' ? undefined : (
              <Button variant="secondary" size="sm" onClick={reconnect}>
                Try again
              </Button>
            )
          }
          onDismiss={() => setNoteShown(false)}
        />
      ) : null}
      {github === 'reconnect' && dismissed !== 'reconnect' ? (
        <Banner
          title="Reconnect GitHub to get live updates."
          icon="plug"
          actions={
            <Button variant="secondary" size="sm" onClick={reconnect}>
              Reconnect
            </Button>
          }
          onDismiss={() => dismiss('reconnect')}
        >
          <span>Until then, JOC reads GitHub from your machine every minute.</span>
        </Banner>
      ) : null}
    </>
  );
}
