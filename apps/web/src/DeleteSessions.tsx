import type { Session } from '@joc/protocol';
import { Code, ConfirmDialog } from '@joc/ui';
import { useState } from 'react';
import { machinesOf } from './deletes.ts';
import { askDeletes } from './hooks.ts';

const UNTITLED = 'New session';

export interface DeleteDialogProps {
  /** The ended sessions to delete, named in the dialog. */
  sessions: Session[];
  /** The request went through: the deletes wait for their machines now. */
  onAsked: () => void;
  onClose: () => void;
}

/** Asks before deleting sessions for good: on their machines and in JOC. */
export function DeleteDialog({ sessions, onAsked, onClose }: DeleteDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const one = sessions.length === 1 ? sessions[0] : undefined;
  const where = machinesOf(sessions);

  async function confirm() {
    setBusy(true);
    setError(undefined);
    const result = await askDeletes(sessions.map((s) => s.id));
    setBusy(false);
    if ('error' in result) return setError(result.error);
    onAsked();
  }

  return (
    <ConfirmDialog
      title={one ? 'Delete this session?' : `Delete ${sessions.length} sessions?`}
      confirmLabel={one ? 'Delete session' : `Delete ${sessions.length} sessions`}
      danger
      busy={busy}
      error={error}
      onConfirm={() => void confirm()}
      onCancel={onClose}
    >
      <ul className="joc-confirm__list">
        {sessions.map((s) => (
          <li key={s.id}>
            <span>{s.title ?? UNTITLED}</span>
            <span>{s.machine}</span>
          </li>
        ))}
      </ul>
      <p>
        Deletes {one ? 'the session' : 'them'} on {where} and in JOC. {one ? "It's" : "They're"}{' '}
        gone from <Code>claude --resume</Code>. This can't be undone.
      </p>
    </ConfirmDialog>
  );
}
