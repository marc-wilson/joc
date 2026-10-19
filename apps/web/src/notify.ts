import type { BrowserAlert } from './alerts.ts';

// The browser side of the opt-in notifications: the remembered switch, and showing one.

const SETTING = 'joc.browserNotifications';

/** Whether the person turned browser notifications on here. */
export function alertsOn(): boolean {
  try {
    return localStorage.getItem(SETTING) === 'on';
  } catch {
    // Storage blocked (private mode, a strict setting): treat as off.
    return false;
  }
}

export function setAlertsOn(on: boolean) {
  try {
    if (on) localStorage.setItem(SETTING, 'on');
    else localStorage.removeItem(SETTING);
  } catch {
    // Storage blocked: the choice lasts until the page reloads, which is all it can do.
  }
}

export const supported = () => 'Notification' in window;

export function show(alert: BrowserAlert) {
  if (!alertsOn() || !supported() || Notification.permission !== 'granted') return;
  const n = new Notification(alert.title, { body: alert.body, tag: alert.tag });
  n.onclick = () => {
    window.focus();
    if (alert.external) window.open(alert.href, '_blank', 'noopener,noreferrer');
    else location.assign(alert.href);
    n.close();
  };
}
