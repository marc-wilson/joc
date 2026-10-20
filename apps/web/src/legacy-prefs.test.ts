import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrefsPatch } from '@joc/protocol';
import { legacyKeys, legacyPatch } from './legacy-prefs.ts';

test("an older dashboard's browser storage becomes one patch the server takes", () => {
  const storage: Record<string, string> = {
    'joc.browserNotifications': 'on',
    'joc:pinned': JSON.stringify(['s1', 's2']),
    'joc:folded-groups': JSON.stringify(['harbor-labs/atlas-web']),
    'joc:list-folded': 'true',
    'joc:diff-mode': JSON.stringify('split'),
    'joc.plugin-banner.dismissed': '0.9.0',
    'joc.reload-banner.dismissed': 's1@0.8.0',
    'joc:folded-messages:s1': JSON.stringify(['m1']),
    'joc:folded:s1': JSON.stringify({ 'src/app.ts': true, 'src/index.ts': false }),
    'joc:viewed:s2': JSON.stringify(['README.md']),
    'joc:viewed:s3': JSON.stringify([]),
    'joc:folded-messages:s4': 'not json',
    'someone-else': 'x',
  };
  const keys = legacyKeys(Object.keys(storage));
  assert.equal(keys.includes('someone-else'), false);
  const patch = legacyPatch((k) => storage[k] ?? null, keys);
  assert.deepEqual(patch, {
    browserNotifications: true,
    pinned: ['s1', 's2'],
    foldedGroups: ['harbor-labs/atlas-web'],
    listFolded: true,
    diffMode: 'split',
    dismissedPluginBanner: '0.9.0',
    dismissedReloadBanner: 's1@0.8.0',
    sessions: [
      {
        id: 's1',
        foldedMessages: ['m1'],
        foldedFiles: ['src/app.ts'],
        openedFiles: ['src/index.ts'],
      },
      { id: 's2', viewedFiles: ['README.md'] },
    ],
  });
  assert.equal(PrefsPatch.safeParse(patch).success, true);
});

test('nothing stored is no patch', () => {
  assert.deepEqual(
    legacyPatch(() => null, []),
    {},
  );
});
