// `pnpm test` for the server: one MongoDB for the whole run, then `node --test`.
//
// - JOC_TEST_MONGODB_URI set (CI runs MongoDB in a container): the tests use it. Never plain
//   MONGODB_URI, which a shell may have exported for a real database.
// - Otherwise this starts an in-memory single-node replica set (live updates need change
//   streams) on a free port, and always stops it: when the tests pass, fail, hang or are
//   interrupted.
//
// Each test file keeps to a database of its own in it (test-db.ts).
//
// Arguments go to `node --test` in place of the default file list.
import { spawn } from 'node:child_process';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

/** A test that runs this long fails, naming itself, instead of holding up the run. */
const TEST_TIMEOUT_MS = 30_000;

/** A run still going after this is stuck (a file that never exits): it's stopped and fails. */
const RUN_TIMEOUT_MS = 10 * 60_000;

const files = process.argv.slice(2);

let mongo: MongoMemoryReplSet | undefined;
if (!process.env.JOC_TEST_MONGODB_URI) {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
}
const uri = process.env.JOC_TEST_MONGODB_URI ?? mongo?.getUri();

const child = spawn(
  process.execPath,
  [`--test-timeout=${TEST_TIMEOUT_MS}`, '--test', ...(files.length ? files : ['src/*.test.ts'])],
  { stdio: 'inherit', env: { ...process.env, MONGODB_URI: uri, JOC_TEST_RUN: '1' } },
);

// Ctrl-C reaches the tests too; this process waits for them to end, then stops MongoDB.
const forward = (signal: NodeJS.Signals) => child.kill(signal);
process.on('SIGINT', forward);
process.on('SIGTERM', forward);

const stuck = setTimeout(() => {
  console.error(
    `The tests were still running after ${RUN_TIMEOUT_MS / 60_000} minutes; stopping them.`,
  );
  child.kill('SIGKILL');
}, RUN_TIMEOUT_MS);

const code = await new Promise<number>((resolve) => {
  child.on('error', (error) => {
    console.error('The tests could not start:', error);
    resolve(1);
  });
  child.on('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
});

clearTimeout(stuck);
await mongo?.stop().catch((error: unknown) => console.error('Stopping MongoDB failed:', error));
process.exit(code);
