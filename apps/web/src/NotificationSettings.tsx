import { type Channels, channelsOf, type NotificationKind, PINNED_KINDS } from '@joc/protocol';
import {
  Button,
  Dialog,
  type NotificationChannel,
  NotificationMatrix,
  type NotificationMatrixKind,
} from '@joc/ui';
import { useEffect, useState } from 'react';
import { sendTestNotification } from './Notifications.tsx';
import { supported } from './notify.ts';
import { updatePrefs, usePrefs } from './prefs.ts';

// Where each kind of notification shows up: Panel, Toast, Sound, Desktop, under the Sound master
// switch, kept with the person's prefs. Whether this browser may show desktop notifications is
// the browser's own, asked for here.

/** The settings' rows. Needs you sets both a question and a permission. */
const KINDS: { id: string; label: string; sub: string; kinds: NotificationKind[] }[] = [
  {
    id: 'needs',
    label: 'Needs you',
    sub: 'A session asks a question or permission',
    kinds: ['question', 'permission'],
  },
  {
    id: 'review',
    label: 'Review requested',
    sub: 'On a PR in your review queue',
    kinds: ['review'],
  },
  { id: 'mention', label: 'Mentions and comments', sub: 'On your PRs', kinds: ['mention'] },
  { id: 'ci-failed', label: 'CI failed', sub: 'On your PRs', kinds: ['ci-failed'] },
  {
    id: 'long-turn',
    label: 'Long session finished',
    sub: 'Sessions that ran 10 min or more',
    kinds: ['long-turn'],
  },
];

type Permission = 'unsupported' | NotificationPermission;

const permissionHere = (): Permission => (supported() ? Notification.permission : 'unsupported');

/** This browser's permission, kept current if it changes in the browser's own settings. */
function usePermission(): [Permission, () => Promise<void>] {
  const [permission, setPermission] = useState<Permission>(permissionHere);
  useEffect(() => {
    let status: PermissionStatus | undefined;
    const update = () => setPermission(permissionHere());
    navigator.permissions
      ?.query({ name: 'notifications' })
      .then((s) => {
        status = s;
        s.addEventListener('change', update);
      })
      .catch(() => {});
    return () => status?.removeEventListener('change', update);
  }, []);
  const ask = async () => setPermission(await Notification.requestPermission());
  return [permission, ask];
}

/** The line under the grid: what always holds, and what this browser still has to allow. */
function Footnote({
  desktop,
  permission,
  ask,
}: {
  desktop: boolean;
  permission: Permission;
  ask: () => Promise<void>;
}) {
  const blocked = desktop && permission !== 'granted';
  return (
    <div className="app-notif-foot">
      <p>
        Needs you always shows in the panel. Desktop notifications appear only when JOC isn’t the
        focused window.
        {blocked
          ? permission === 'unsupported'
            ? ' This browser can’t show them.'
            : permission === 'denied'
              ? ' They’re blocked in this browser: allow them for this site in its settings.'
              : ' This browser hasn’t allowed them yet.'
          : null}
      </p>
      {blocked && permission === 'default' ? (
        <Button variant="secondary" size="sm" onClick={() => void ask()}>
          Allow in this browser
        </Button>
      ) : null}
    </div>
  );
}

/** The Sound switch and the Panel / Toast / Sound / Desktop grid. */
export function NotificationSettingsForm() {
  const prefs = usePrefs();
  const [permission, ask] = usePermission();
  const kinds = KINDS.map(
    (k): NotificationMatrixKind => ({
      id: k.id,
      label: k.label,
      sub: k.sub,
      // A row of two kinds shows the first; a change sets both.
      channels: channelsOf(prefs, k.kinds[0] ?? 'question'),
      locked: k.kinds.some((kind) => PINNED_KINDS.includes(kind)),
    }),
  );
  const desktop = kinds.some((k) => k.channels.desktop);

  function change(id: string, channel: NotificationChannel, on: boolean) {
    const row = KINDS.find((k) => k.id === id);
    if (!row) return;
    const next = { ...prefs.notificationKinds };
    for (const kind of row.kinds) {
      next[kind] = { ...channelsOf(prefs, kind), [channel]: on } satisfies Channels;
    }
    updatePrefs({ notificationKinds: next });
    // Desktop asked for here: the browser asks the person once.
    if (channel === 'desktop' && on && permission === 'default') void ask();
  }

  return (
    <div className="app-notif-settings">
      <NotificationMatrix
        kinds={kinds}
        sound={prefs.notificationSound}
        onSound={(on) => updatePrefs({ notificationSound: on })}
        onTest={sendTestNotification}
        onChange={change}
      />
      <Footnote desktop={desktop} permission={permission} ask={ask} />
    </div>
  );
}

export const resetNotificationSettings = () =>
  updatePrefs({ notificationKinds: {}, notificationSound: true });

/** The settings as a dialog, from the panel's Settings button. */
export function NotificationSettingsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      label="Notification settings"
      title="Notifications"
      className="app-notif-dialog"
      onClose={onClose}
      footer={
        <div className="app-settings__foot">
          <span>
            <Button variant="ghost" onClick={resetNotificationSettings}>
              Reset to defaults
            </Button>
          </span>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      }
    >
      <p className="app-notif-dialog__desc">Each notification clears itself once it’s handled.</p>
      <NotificationSettingsForm />
    </Dialog>
  );
}
