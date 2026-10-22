// The database a test file runs against. One MongoDB serves the whole run (run-tests.ts starts
// it, or CI provides one in JOC_TEST_MONGODB_URI); each file keeps to a database of its own in
// it, so files running side by side never see each other's data.
import { getDb } from '@joc/db';

/**
 * Points this process at its own, empty database `name`. Call it from the file's `before`, and
 * close the client (`closeClient`) in its `after`.
 */
export async function useTestDb(name: string): Promise<void> {
  // Only under run-tests.ts, so a MONGODB_URI exported for a real database is never dropped.
  if (process.env.JOC_TEST_RUN !== '1' || !process.env.MONGODB_URI) {
    throw new Error('Run the tests with `pnpm test`, which starts their MongoDB');
  }
  process.env.MONGODB_DB = name;
  await getDb().dropDatabase();
}
