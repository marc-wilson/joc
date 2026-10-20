import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installedList, installedVersion } from './version.ts';

test('an installed copy finds the list of installed plugins and its key in it', () => {
  assert.deepEqual(installedList('/Users/harbor/.claude/plugins/cache/joc/joc/0.7.0/'), {
    file: '/Users/harbor/.claude/plugins/installed_plugins.json',
    key: 'joc@joc',
  });
  assert.deepEqual(installedList('/srv/claude-config/plugins/cache/harbor-labs/joc/0.6.0'), {
    file: '/srv/claude-config/plugins/installed_plugins.json',
    key: 'joc@harbor-labs',
  });
  // A checkout run with --plugin-dir isn't installed.
  assert.equal(installedList('/Users/harbor/dev/atlas-web/apps/plugin'), undefined);
});

test('the installed version is the user-wide install, else the first listed', () => {
  const list = (entries: unknown) =>
    JSON.stringify({ version: 2, plugins: { 'joc@joc': entries } });
  assert.equal(
    installedVersion(
      list([
        { scope: 'project', projectPath: '/Users/harbor/dev/atlas-web', version: '0.6.0' },
        { scope: 'user', installPath: '/x/cache/joc/joc/0.7.0', version: '0.7.0' },
      ]),
      'joc@joc',
    ),
    '0.7.0',
  );
  assert.equal(
    installedVersion(list([{ scope: 'project', version: '0.6.0' }]), 'joc@joc'),
    '0.6.0',
  );
  assert.equal(installedVersion(list([]), 'joc@joc'), undefined);
  assert.equal(installedVersion(list([{ scope: 'user' }]), 'joc@joc'), undefined);
  assert.equal(installedVersion(list([{ version: '0.7.0' }]), 'other@joc'), undefined);
  assert.equal(installedVersion('{"plugins": null}', 'joc@joc'), undefined);
  assert.equal(installedVersion('not json', 'joc@joc'), undefined);
});
