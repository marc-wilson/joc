import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Device } from '@joc/protocol';
import { behindTitle } from './version.ts';

const machine = (name: string, plugin?: string): Device => ({
  id: name,
  name,
  createdAt: '2026-10-01T09:00:00.000Z',
  lastSeenAt: '2026-10-18T09:00:00.000Z',
  plugin,
  outdated: true,
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
