// Whether this browser can show desktop notifications at all. Which kinds show, and whether the
// person wants them, is in their prefs (Notifications.tsx); each browser still allows them itself.

export const supported = () => 'Notification' in window;
