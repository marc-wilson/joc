import { MongoClient } from 'mongodb';

let client: MongoClient | undefined;

// One client for the whole process, reused by every request. Pool settings stay at the
// driver defaults until real traffic tells us otherwise.
export function getClient(uri = process.env.MONGODB_URI): MongoClient {
  if (!uri) throw new Error('MONGODB_URI is not set');
  client ??= new MongoClient(uri);
  return client;
}

export async function closeClient(): Promise<void> {
  await client?.close();
  client = undefined;
}
