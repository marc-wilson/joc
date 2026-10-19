// Images between a session and JOC. Claude Code keeps a pasted image inside its transcript line,
// base64; the hook uploads those so the dashboard can show them. The other way, a plugin can't
// attach an image to a prompt, but Claude reads an image file a prompt names: an image sent from
// the dashboard is saved to a folder of JOC's own and named in the prompt by `imageLine`.
import type { ImageRef } from '@joc/protocol';

/** The formats JOC takes, with the extension a saved file gets. Never SVG: it can carry script. */
export const EXTENSIONS = new Map<ImageRef['type'], string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

const TYPES = new Map([...EXTENSIONS].map(([type, ext]) => [ext, type]));

/** Server-made image ids: a SHA-256 in hex. Nothing else becomes part of a path. */
export const isImageId = (id: unknown): id is string =>
  typeof id === 'string' && /^[0-9a-f]{64}$/.test(id);

export function imageType(value: unknown): ImageRef['type'] | undefined {
  return [...EXTENSIONS.keys()].find((type) => type === value);
}

/** The most images one message carries, as the server allows. */
export const MAX_IMAGES = 10;

const LABEL = 'Image from JOC:';

/** The line a prompt carries for each image sent with it from the dashboard. */
export const imageLine = (path: string) => `[${LABEL} ${path}]`;

/**
 * A prompt's text without the image lines JOC added, and those images, read back from their
 * file names, so the dashboard shows the images rather than the paths.
 */
export function takeImageLines(text: string): { text: string; images: ImageRef[] } {
  const images: ImageRef[] = [];
  const rest = text.replace(
    /\n*\[Image from JOC: [^\]\n]*\/([0-9a-f]{64})\.([a-z]+)\]/g,
    (line, id, ext) => {
      const type = TYPES.get(ext);
      if (!type || images.length >= MAX_IMAGES) return line;
      images.push({ id, type });
      return '';
    },
  );
  return { text: images.length ? rest.trim() : text, images };
}
