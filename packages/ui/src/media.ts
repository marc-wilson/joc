// Plain helpers for images: sizes, type names and stepping through a set. No React here, so
// Node's test runner loads it directly.

/** A file size the way people read it: `840 B`, `84 KB`, `1.2 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const TYPE_NAMES = new Map([
  ['image/png', 'PNG'],
  ['image/jpeg', 'JPEG'],
  ['image/gif', 'GIF'],
  ['image/webp', 'WebP'],
]);

/** An image's MIME type as a short name: `PNG`, `JPEG`. Other types use their subtype. */
export function imageTypeName(type: string): string {
  return TYPE_NAMES.get(type) ?? type.replace(/^image\//, '').toUpperCase();
}

/** The index one step on from `index` in a set of `count`, held at the ends, never wrapping. */
export function stepIndex(index: number, step: -1 | 1, count: number): number {
  return Math.min(Math.max(index + step, 0), Math.max(count - 1, 0));
}

/** The composer's hint while images wait to be sent. */
export function attachedHint(count: number, max: number, hasText: boolean): string {
  const images = count === 1 ? '1 image' : `${count} images`;
  if (!hasText) return `${images} · ↵ sends ${count === 1 ? 'it' : 'them'} without a message`;
  return count < max ? `${images} · paste or drop more` : `${images}, the most a message takes`;
}
