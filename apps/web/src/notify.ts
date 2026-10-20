import type { BrowserAlert } from './alerts.ts';
import { currentPrefs } from './prefs.ts';

// The browser side of the opt-in notifications. The switch is the person's, kept with their
// prefs; each browser still has to allow them itself.

export const supported = () => 'Notification' in window;

export function show(alert: BrowserAlert) {
  if (!currentPrefs().browserNotifications) return;
  if (!supported() || Notification.permission !== 'granted') return;
  const n = new Notification(alert.title, { body: alert.body, tag: alert.tag });
  n.onclick = () => {
    window.focus();
    if (alert.external) window.open(alert.href, '_blank', 'noopener,noreferrer');
    else location.assign(alert.href);
    n.close();
  };
}
