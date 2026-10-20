import { channelsOf, type NotificationKind, PINNED_KINDS } from '@joc/protocol';
import {
  Button,
  CIMark,
  Dialog,
  Icon,
  NotificationMatrix,
  type NotificationMatrixKind,
} from '@joc/ui';
import { useEffect, useState } from 'react';
import { supported } from './notify.ts';
import { updatePrefs, usePrefs } from './prefs.ts';

// Where each kind of notification shows up: Panel, Toast, Desktop, kept with the person's prefs.
// Whether this browser may show desktop notifications is the browser's own, asked for here.

const GROUPS: { label: string; kinds: { id: NotificationKind; label: string; note?: string }[] }[] =
  [
    {
      label: 'Sessions',
      kinds: [
        { id: 'question', label: 'Asks a question' },
        { id: 'permission', label: 'Wants permission' },
        { id: 'finished', label: 'Finished a turn', note: 'Not while you’re viewing that session' },
      ],
    },
    {
      label: 'GitHub',
      kinds: [
        { id: 'review', label: 'Review requested' },
        { id: 'mention', label: 'Comment or mention' },
        { id: 'ci-failed', label: 'CI failed on your PR' },
        {
          id: 'github',
          label: 'Other GitHub activity',
          note: 'Assignments, state changes, threads you watch',
        },
      ],
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

function DesktopStatus() {
  const prefs = usePrefs();
  const [permission, ask] = usePermission();
  const on = prefs.browserNotifications;
  const allowed = permission === 'granted';
  const title =
    permission === 'unsupported'
      ? 'This browser can’t show desktop notifications'
      : permission === 'denied'
        ? 'Desktop notifications are blocked in this browser'
        : allowed
          ? 'Desktop notifications are allowed in this browser'
          : 'Desktop notifications aren’t allowed in this browser yet';

  function test() {
    const n = new Notification('Notifications are on', {
      body: 'This is how JOC tells you when a session needs you.',
      tag: 'joc-test',
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  }

  return (
    <div className="app-notif-desktop">
      <span className="app-notif-desktop__lead">
        {allowed ? (
          <CIMark status="pass" />
        ) : permission === 'denied' ? (
          <CIMark status="fail" />
        ) : (
          <Icon name="bell" size={14} />
        )}
      </span>
      <div className="app-notif-desktop__text">
        <span className="app-notif-desktop__title">{title}</span>
        {permission === 'denied' ? (
          <span className="app-notif-desktop__hint">
            Allow notifications for this site in the browser’s settings.
          </span>
        ) : null}
        {permission !== 'unsupported' ? (
          <>
            <label className="app-notif-desktop__check">
              <input
                type="checkbox"
                className="jn-check"
                checked={on}
                onChange={(e) => {
                  updatePrefs({ browserNotifications: e.target.checked });
                  if (e.target.checked && permission === 'default') void ask();
                }}
              />
              Show desktop notifications for the kinds set to Desktop
            </label>
            <label className="app-notif-desktop__check">
              <input
                type="checkbox"
                className="jn-check"
                checked={prefs.desktopWhenAway}
                disabled={!on}
                onChange={(e) => updatePrefs({ desktopWhenAway: e.target.checked })}
              />
              Only when JOC isn’t the focused window
            </label>
          </>
        ) : null}
      </div>
      {permission === 'default' ? (
        <Button variant="secondary" size="sm" onClick={() => void ask()}>
          Allow in this browser
        </Button>
      ) : allowed ? (
        <Button variant="ghost" size="sm" onClick={test}>
          Send a test
        </Button>
      ) : null}
    </div>
  );
}

/** The desktop status and the Panel / Toast / Desktop matrix. */
export function NotificationSettingsForm() {
  const prefs = usePrefs();
  const groups = GROUPS.map((g) => ({
    label: g.label,
    kinds: g.kinds.map(
      (k): NotificationMatrixKind => ({
        ...k,
        channels: channelsOf(prefs, k.id),
        locked: PINNED_KINDS.includes(k.id),
      }),
    ),
  }));
  return (
    <div className="app-notif-settings">
      <DesktopStatus />
      <NotificationMatrix
        groups={groups}
        onChange={(kind, channel, on) => {
          const id = kind as NotificationKind;
          updatePrefs({
            notificationKinds: {
              ...prefs.notificationKinds,
              [id]: { ...channelsOf(prefs, id), [channel]: on },
            },
          });
        }}
      />
    </div>
  );
}

export const resetNotificationSettings = () =>
  updatePrefs({ notificationKinds: {}, desktopWhenAway: true });

/** The settings as a dialog, from the panel's settings button. */
export function NotificationSettingsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      label="Notification settings"
      title="Notification settings"
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
      <p className="app-notif-dialog__desc">
        Choose where each kind shows up. Everything is kept in history for 30 days.
      </p>
      <NotificationSettingsForm />
    </Dialog>
  );
}
