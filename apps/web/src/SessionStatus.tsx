import type { Session } from '@joc/protocol';
import { Dialog, SessionStatusPanel } from '@joc/ui';
import { useSessionStatus } from './hooks.ts';
import { statusView } from './session-status.ts';

/**
 * A session's status over the page, from the header's menu: what `/status` shows in the
 * terminal, less the login. Kept current while it's open.
 */
export function SessionStatusDialog({
  session,
  onClose,
}: {
  session: Session;
  onClose: () => void;
}) {
  const status = useSessionStatus(session.id, true);
  return (
    <Dialog
      label="Session status"
      title="Status"
      className="app-status-dialog"
      footer="As this session's plugin last reported it. Never the login or email."
      onClose={onClose}
    >
      <SessionStatusPanel {...statusView(session, status)} />
    </Dialog>
  );
}
