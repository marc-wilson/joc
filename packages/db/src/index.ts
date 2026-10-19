import { type Db, MongoClient } from 'mongodb';

/** BSON binary data, for stores that keep bytes (e.g. images), without their own driver import. */
export { Binary } from 'mongodb';

let client: MongoClient | undefined;

// One client for the whole process, reused by every request. Pool settings stay at the
// driver defaults until real traffic tells us otherwise.
export function getClient(uri = process.env.MONGODB_URI): MongoClient {
  if (!uri) throw new Error('MONGODB_URI is not set');
  client ??= new MongoClient(uri);
  return client;
}

/** The JOC database: `MONGODB_DB` if set, else `joc`. */
export function getDb(): Db {
  return getClient().db(process.env.MONGODB_DB ?? 'joc');
}

export async function closeClient(): Promise<void> {
  await client?.close();
  client = undefined;
}
