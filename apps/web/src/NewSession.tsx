import type { Session } from '@joc/protocol';
import { Button, Code, Dialog, EmptyState, TextArea } from '@joc/ui';
import { useEffect, useState } from 'react';
import { startLaunch, useLaunches } from './hooks.ts';
import { launched, launchFrom, launchStatus } from './launches.ts';

interface Props {
  repo: string;
  /** The repo's sessions; a live one starts the new session in its folder. */
  candidates: Session[];
  /** Every live session, to spot the new one when it reports. */
  sessions: Session[];
  /** The new session reported: show it. */
  onOpen: (sessionId: string) => void;
  onClose: () => void;
  /** The first prompt to start from, e.g. to check out a pull request's branch. */
  prompt?: string;
}

/**
 * Starts a new Claude Code session on a repo, with a first prompt or none. A session already
 * running there starts it in its folder (`claude --bg`); once the new one reports, it opens.
 */
export function NewSessionDialog({
  repo,
  candidates,
  sessions,
  onOpen,
  onClose,
  prompt: initial = '',
}: Props) {
  const from = launchFrom(candidates);
  const [prompt, setPrompt] = useState(initial);
  const [launchId, setLaunchId] = useState<string>();
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const launch = useLaunches(undefined, !!launchId).find((l) => l.id === launchId);
  const started = launched(launch, sessions);

  useEffect(() => {
    if (started) onOpen(started.id);
  }, [started, onOpen]);

  async function start() {
    if (!from) return;
    setSending(true);
    setError(undefined);
    const result = await startLaunch({ from: from.id, prompt: prompt.trim() || undefined });
    setSending(false);
    if ('error' in result) setError(result.error);
    else setLaunchId(result.id);
  }

  const failed = launch?.status === 'failed';
  const busy = sending || (!!launchId && !failed);
  const note = error ?? (launch ? launchStatus(launch, started) : undefined);

  return (
    <Dialog
      label={`New session in ${repo}`}
      title="New session"
      meta={<Code>{repo}</Code>}
      className="app-settings-dialog"
      onClose={onClose}
      footer={
        <div className="app-settings__foot">
          <span className={failed || error ? 'app-launch__error' : undefined}>{note}</span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!from}
            loading={busy}
            onClick={() => {
              setLaunchId(undefined);
              void start();
            }}
          >
            {failed ? 'Try again' : 'Start'}
          </Button>
        </div>
      }
    >
      {from ? (
        <div className="app-settings">
          <TextArea
            label="First prompt"
            placeholder="What should Claude do? Leave it empty to start without one."
            value={initial || undefined}
            rows={5}
            disabled={busy}
            onChange={setPrompt}
            hint={`Starts in the folder of "${from.title ?? 'New session'}", as a background session on that machine.`}
          />
        </div>
      ) : (
        <EmptyState
          compact
          title={`No open session on ${repo}`}
          body="JOC starts a new session from a Claude Code session that's running on the repo, in its folder. Open one there, then try again."
        />
      )}
    </Dialog>
  );
}
