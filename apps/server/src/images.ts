import { createHash } from 'node:crypto';
import { Binary, getDb } from '@joc/db';
import { type ImageRef, type ImageType, MAX_IMAGE_BYTES } from '@joc/protocol';
import type { Owner } from './owner.ts';

/** `_id` is `owner/id`; `owner` is filtered on every read. Images are at most 5 MB, well inside
 * a document's 16 MB. */
interface ImageDoc {
  _id: string;
  owner: string;
  id: string;
  type: ImageType;
  bytes: number;
  data: Binary;
  createdAt: Date;
}

const images = () => getDb().collection<ImageDoc>('images');

const imageKey = (owner: Owner, id: string) => `${owner}/${id}`;

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  prefix.every((b, i) => bytes[at + i] === b);

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** What an image really is, by its first bytes; undefined for anything else (SVG included). */
export function sniffImageType(bytes: Uint8Array): ImageType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  return undefined;
}

export type SaveResult = { ok: true; image: ImageRef } | { ok: false; status: 413 | 415 };

/**
 * Stores an image for its owner, named by the hash of its bytes, so the same image saved twice
 * is one record and an id always means the same bytes. The bytes must be the type they claim.
 */
export async function saveImage(
  owner: Owner,
  declared: string | undefined,
  bytes: Uint8Array,
): Promise<SaveResult> {
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, status: 413 };
  const type = sniffImageType(bytes);
  if (!type || type !== declared?.split(';')[0]?.trim().toLowerCase()) {
    return { ok: false, status: 415 };
  }
  const id = createHash('sha256').update(bytes).digest('hex');
  await images().updateOne(
    { _id: imageKey(owner, id) },
    {
      $setOnInsert: {
        owner,
        id,
        type,
        bytes: bytes.length,
        data: new Binary(bytes),
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );
  return { ok: true, image: { id, type, bytes: bytes.length } };
}

/** One of the owner's images, bytes and all. */
export async function getImage(
  owner: Owner,
  id: string,
): Promise<{ type: ImageType; data: Uint8Array<ArrayBuffer> } | undefined> {
  const doc = await images().findOne({ _id: imageKey(owner, id), owner });
  return doc ? { type: doc.type, data: new Uint8Array(doc.data.buffer) } : undefined;
}

/** The owner's images with these ids, in the order asked; undefined if any isn't theirs. */
export async function findImages(owner: Owner, ids: string[]): Promise<ImageRef[] | undefined> {
  if (!ids.length) return [];
  const docs = await images()
    .find(
      { _id: { $in: ids.map((id) => imageKey(owner, id)) }, owner },
      { projection: { data: 0 } },
    )
    .toArray();
  const byId = new Map(docs.map((d) => [d.id, { id: d.id, type: d.type, bytes: d.bytes }]));
  const found = ids.flatMap((id) => byId.get(id) ?? []);
  return found.length === ids.length ? found : undefined;
}

/** Deletes these of the owner's images. */
export async function deleteImages(owner: Owner, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await images().deleteMany({ _id: { $in: ids.map((id) => imageKey(owner, id)) }, owner });
}
