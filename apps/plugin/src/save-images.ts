// Saves the images of a prompt sent from the JOC dashboard where Claude can read them, for
// register.ts, which has no Node of its own and can't write bytes. Reads `{ images: [{ id, type }] }`
// on stdin and prints `{ lines: [...] }`: one line per image for the prompt, naming its file.
// Files go in a folder of JOC's own, named by the server-made id; a request never picks a path.
// Like hook.ts it never fails: an image it can't save gets a line saying so, and it exits 0.
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connection, readCredentials } from './credentials.ts';
import { EXTENSIONS, imageLine, imageType, isImageId, MAX_IMAGES } from './images.ts';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Saved images are only needed while Claude reads them; older ones are cleared away. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const UNSAVED = '[An image sent from JOC could not be loaded]';

const imagesDir = () => join(homedir(), '.claude', 'joc', 'images');

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** The `{ id, type }` pairs asked for, keeping only well-formed ones. */
function requested(input: unknown): { id: string; type: string }[] {
  if (!input || typeof input !== 'object' || !('images' in input)) return [];
  if (!Array.isArray(input.images)) return [];
  return input.images.slice(0, MAX_IMAGES).flatMap((image: unknown) => {
    if (!image || typeof image !== 'object' || !('id' in image) || !('type' in image)) return [];
    return typeof image.id === 'string' && typeof image.type === 'string'
      ? [{ id: image.id, type: image.type }]
      : [];
  });
}

/** Downloads one of the person's images and saves it; the file's path, or undefined. */
async function save(dir: string, id: string, declared: string): Promise<string | undefined> {
  const type = imageType(declared);
  if (!isImageId(id) || !type) return undefined;
  const { url, token } = connection(process.env, readCredentials());
  const res = await fetch(`${url}/api/images/${id}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok || res.headers.get('content-type') !== type) return undefined;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return undefined;
  const path = join(dir, `${id}.${EXTENSIONS.get(type)}`);
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

/** Clears images saved more than a week ago. */
function prune(dir: string, now = Date.now()) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > KEEP_MS) rmSync(path, { force: true });
    } catch {
      // Gone already, or not ours to remove: either way nothing to clear.
    }
  }
}

async function main() {
  const images = requested(JSON.parse(await readStdin()));
  const dir = imagesDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const lines: string[] = [];
  for (const { id, type } of images) {
    // Unreachable server or a bad reply: the prompt then says the image is missing.
    const path = await save(dir, id, type).catch(() => undefined);
    lines.push(path ? imageLine(path) : UNSAVED);
  }
  // Written in full before exiting: a pipe's writes can be asynchronous.
  await new Promise<void>((resolve) =>
    process.stdout.write(JSON.stringify({ lines }), () => resolve()),
  );
  prune(dir);
}

main()
  .catch(() => {
    // Nothing saved: register.ts sends the prompt's text with a line per missing image.
  })
  .finally(() => process.exit(0));
