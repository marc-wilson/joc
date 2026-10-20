import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Device, StaleSession } from '@joc/protocol';
import { behindTitle, reloadable, staleDismissed, staleKey, staleTitle } from './version.ts';

const machine = (name: string, plugin?: string, extra: Partial<Device> = {}): Device => ({
  id: name,
  name,
  createdAt: '2026-10-01T09:00:00.000Z',
  lastSeenAt: '2026-10-18T09:00:00.000Z',
  plugin,
  outdated: true,
  stale: [],
  ...extra,
});

const session = (id: string, plugin: string): StaleSession => ({
  id,
  title: `Fix the ${id} build`,
  repo: 'harbor-labs/atlas-web',
  state: 'idle',
  plugin,
});

test('the banner names the machines behind, and the version when it knows it', () => {
  assert.equal(
    behindTitle([machine('harbor-mbp', '0.2.0')], '0.3.0'),
    'harbor-mbp runs JOC plugin 0.2.0, behind 0.3.0',
  );
  assert.equal(
    behindTitle([machine('harbor-mbp')], '0.3.0'),
    'harbor-mbp runs an older JOC plugin than 0.3.0',
  );
  assert.equal(
    behindTitle(
      [machine('harbor-mbp', '0.2.0'), machine('studio-mini'), machine('ci-box')],
      '0.3.0',
    ),
    'harbor-mbp, studio-mini and ci-box run an older JOC plugin than 0.3.0',
  );
});

test("a machine that says what's installed is named by it, not by an old session's request", () => {
  assert.equal(
    behindTitle([machine('harbor-mbp', '0.1.0', { installed: '0.2.0' })], '0.3.0'),
    'harbor-mbp has JOC plugin 0.2.0 installed, behind 0.3.0',
  );
});

test('only sessions on up-to-date machines need just a reload', () => {
  const current = machine('harbor-mbp', '0.2.0', {
    installed: '0.3.0',
    outdated: false,
    stale: [session('a', '0.2.0')],
  });
  const behind = machine('studio-mini', '0.2.0', { stale: [session('b', '0.2.0')] });
  assert.deepEqual(
    reloadable([current, behind]).map((s) => s.id),
    ['a'],
  );
});

test('the reload banner counts the sessions, and names the version they share', () => {
  assert.equal(staleTitle([session('a', '0.6.0')]), '1 session still runs JOC plugin 0.6.0');
  assert.equal(
    staleTitle([session('a', '0.6.0'), session('b', '0.6.0')]),
    '2 sessions still run JOC plugin 0.6.0',
  );
  assert.equal(
    staleTitle([session('a', '0.5.0'), session('b', '0.6.0')]),
    '2 sessions still run older JOC plugins',
  );
});

test('a dismissed reload banner stays dismissed as sessions reload, and returns for a new one', () => {
  const both = [session('a', '0.6.0'), session('b', '0.6.0')];
  const key = staleKey(both);
  assert.equal(staleDismissed(both, undefined), false);
  assert.equal(staleDismissed(both, key), true);
  assert.equal(staleDismissed([session('a', '0.6.0')], key), true);
  assert.equal(staleDismissed([...both, session('c', '0.6.0')], key), false);
});
