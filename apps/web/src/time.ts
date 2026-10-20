/** Compact age for list rows: "now", "3m", "2h", "4d". */
export function age(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** How long something lasted: "45s", "12m", "3h 20m", "2d". */
export function duration(fromIso: string, toIso: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** "just now", "3m ago", "2h ago". */
export function ago(iso: string, now = Date.now()): string {
  const a = age(iso, now);
  return a === 'now' ? 'just now' : `${a} ago`;
}

/** The clock time it started today, "09:12"; "00:00" for anything that started before today. */
export function clock(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (at < midnight) return '00:00';
  return at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}
