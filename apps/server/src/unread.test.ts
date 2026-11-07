// When a session is unread: reports and conversation items as the plugin sends them, in the
// order its hooks send them, against the run's MongoDB.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { closeClient } from '@joc/db';
import { type ConversationItem, isUnread, type Session, type SessionState } from '@joc/protocol';
import { signInGitHubUser } from './identity.ts';
import type { Owner } from './owner.ts';
import { applyReport, markRead, noteTurn } from './sessions.ts';
import { useTestDb } from './test-db.ts';

let owner: Owner;
before(async () => {
  await useTestDb('joc_unread_test');
  owner = await signInGitHubUser({ id: 7, login: 'unread-person' });
});
after(closeClient);

let clock = Date.now();
const at = new Date().toISOString();

async function report(sessionId: string, state: SessionState): Promise<Session> {
  const session = await applyReport(owner, {
    sessionId,
    at: ++clock,
    state,
    repo: 'harbor-labs/atlas-web',
  });
  assert.ok(session);
  return session;
}

const you: ConversationItem = { id: 'u', at, kind: 'user', text: 'Fix the login page' };
const claude: ConversationItem = { id: 'c', at, kind: 'claude', text: 'Fixed the login page.' };
const teammate: ConversationItem = {
  id: 't',
  at,
  kind: 'user',
  text: 'Another Claude session sent a message:\n<teammate-message teammate_id="ci">Done.</teammate-message>',
};

/** A session as it stands, from a sync: a report that names no state. */
const latest = async (sessionId: string) => {
  const session = await applyReport(owner, {
    sessionId,
    at: ++clock,
    repo: 'harbor-labs/atlas-web',
  });
  assert.ok(session);
  return session;
};

test('a turn you started is a reply until you read it', async () => {
  await report('a', 'idle');
  await report('a', 'working');
  await noteTurn(owner, 'a', [you]);
  assert.equal(isUnread(await report('a', 'idle')), true);
  await new Promise((done) => setTimeout(done, 2));
  assert.equal(await markRead(owner, 'a'), true);
  assert.equal(isUnread(await latest('a')), false);
});

test('a turn you started that leaves work running is a reply', async () => {
  await report('b', 'working');
  await noteTurn(owner, 'b', [you]);
  assert.equal(isUnread(await report('b', 'background')), true);
});

test("a turn on a teammate's message while work runs is not, and the end of the work is", async () => {
  await report('c', 'working');
  await report('c', 'background');
  await report('c', 'working');
  await noteTurn(owner, 'c', [teammate, claude]);
  assert.equal(isUnread(await report('c', 'background')), false);
  assert.equal(isUnread(await report('c', 'idle')), true);
});

test('a short turn stays a reply though its items land after the report', async () => {
  await report('d', 'working');
  await report('d', 'idle');
  await noteTurn(owner, 'd', [you, claude]);
  const ended = await latest('d');
  assert.equal(isUnread(ended), true);
  assert.equal(ended.lastWords, 'Fixed the login page.');

  await report('e', 'working');
  await report('e', 'background');
  await noteTurn(owner, 'e', [you, claude]);
  assert.equal(isUnread(await latest('e')), true);
});

test('sending something reads what came before', async () => {
  await report('f', 'working');
  await report('f', 'idle');
  await new Promise((done) => setTimeout(done, 2));
  await report('f', 'working');
  await noteTurn(owner, 'f', [you]);
  assert.equal(isUnread(await latest('f')), false);
});

test('a session with no reply yet is not unread, and marking it needs a session', async () => {
  assert.equal(isUnread(await report('g', 'idle')), false);
  assert.equal(await markRead(owner, 'nothing'), false);
});
