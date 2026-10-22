// Session titles: always the name Claude Code shows. Runs against an in-memory MongoDB.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { closeClient } from '@joc/db';
import type { SessionReport } from '@joc/protocol';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ownerFrom } from './owner.ts';
import { applyReport, listSessions } from './sessions.ts';

let mongo: MongoMemoryServer;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  process.env.MONGODB_DB = 'joc_titles_test';
});

after(async () => {
  await closeClient();
  await mongo.stop();
});

const owner = ownerFrom('titles');
let at = Date.now();
const report = (fields: Partial<SessionReport>) =>
  applyReport(owner, {
    sessionId: 's1',
    at: ++at,
    repo: 'harbor-labs/atlas-web',
    state: 'working',
    ...fields,
  });
const title = async () => (await listSessions(owner)).find((s) => s.id === 's1')?.title;

test('a session shows its first prompt until Claude Code names it, then that name', async () => {
  await report({ title: 'fix the login loop' });
  assert.equal(await title(), 'fix the login loop');
  await report({ name: 'Login loop fix' });
  assert.equal(await title(), 'Login loop fix');
});

test('a /rename name stays over every title Claude Code generates after it', async () => {
  await report({ customName: 'Auth cleanup' });
  assert.equal(await title(), 'Auth cleanup');
  await report({ name: 'Refresh token rotation' });
  assert.equal(await title(), 'Auth cleanup');
  await report({ customName: 'Auth cleanup, part 2' });
  assert.equal(await title(), 'Auth cleanup, part 2');
});
