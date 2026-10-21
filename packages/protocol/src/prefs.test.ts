import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyPrefsPatch,
  channelsOf,
  chimes,
  combinePrefsPatches,
  DEFAULT_NOTIFICATION_CHANNELS,
  DEFAULT_PREFS,
  MAX_PREF_SESSIONS,
  NOTIFYING_KINDS,
  Prefs,
  PrefsPatch,
} from './prefs.ts';

test('a patch replaces only the fields it gives', () => {
  const next = applyPrefsPatch(DEFAULT_PREFS, { pinned: ['s1'], listFolded: undefined }, 1);
  assert.deepEqual(next, { ...DEFAULT_PREFS, pinned: ['s1'] });
});

test("a session's lists merge by id, and an emptied session is dropped", () => {
  const one = applyPrefsPatch(
    DEFAULT_PREFS,
    { sessions: [{ id: 's1', foldedMessages: ['m1'] }] },
    1,
  );
  const two = applyPrefsPatch(one, { sessions: [{ id: 's1', viewedFiles: ['src/app.ts'] }] }, 2);
  assert.deepEqual(two.sessions, [
    {
      id: 's1',
      at: 2,
      foldedMessages: ['m1'],
      viewedFiles: ['src/app.ts'],
      foldedFiles: [],
      openedFiles: [],
    },
  ]);
  const gone = applyPrefsPatch(
    two,
    { sessions: [{ id: 's1', foldedMessages: [], viewedFiles: [] }] },
    3,
  );
  assert.deepEqual(gone.sessions, []);
});

test('past the cap, the least recently changed sessions go', () => {
  let prefs = DEFAULT_PREFS;
  for (let i = 0; i < MAX_PREF_SESSIONS + 5; i++) {
    prefs = applyPrefsPatch(prefs, { sessions: [{ id: `s${i}`, foldedMessages: ['m'] }] }, i);
  }
  assert.equal(prefs.sessions.length, MAX_PREF_SESSIONS);
  assert.equal(prefs.sessions[0]?.id, 's5');
});

test('pending patches combine, the later winning', () => {
  const combined = combinePrefsPatches(
    { pinned: ['a'], sessions: [{ id: 's1', foldedMessages: ['m1'], viewedFiles: ['f'] }] },
    {
      pinned: ['a', 'b'],
      sessions: [
        { id: 's1', foldedMessages: [] },
        { id: 's2', foldedFiles: ['g'] },
      ],
    },
  );
  assert.deepEqual(combined, {
    pinned: ['a', 'b'],
    sessions: [
      { id: 's1', foldedMessages: [], viewedFiles: ['f'] },
      { id: 's2', foldedFiles: ['g'] },
    ],
  });
});

test('a patch with an unbounded list is refused', () => {
  const many = Array.from({ length: 1000 }, (_, i) => `s${i}`);
  assert.equal(PrefsPatch.safeParse({ pinned: many }).success, false);
  assert.equal(PrefsPatch.safeParse({ diffMode: 'sideways' }).success, false);
});

test('a kind never set has its default, and a session waiting on you stays in the panel', () => {
  assert.deepEqual(channelsOf(DEFAULT_PREFS, 'review'), DEFAULT_NOTIFICATION_CHANNELS.review);
  const off = { panel: false, toast: false, desktop: false, sound: false };
  const prefs = applyPrefsPatch(
    DEFAULT_PREFS,
    { notificationKinds: { mention: off, question: off } },
    1,
  );
  assert.deepEqual(channelsOf(prefs, 'mention'), off);
  assert.deepEqual(channelsOf(prefs, 'question'), { ...off, panel: true });
  assert.equal(PrefsPatch.safeParse({ notificationKinds: { pager: off } }).success, false);
});

test('only the defined kinds notify, and the long-turn kind is off until chosen', () => {
  for (const kind of ['finished', 'github'] as const) {
    const on = { panel: true, toast: true, desktop: true, sound: true };
    const prefs = applyPrefsPatch(DEFAULT_PREFS, { notificationKinds: { [kind]: on } }, 1);
    assert.deepEqual(channelsOf(prefs, kind), {
      panel: false,
      toast: false,
      desktop: false,
      sound: false,
    });
  }
  assert.deepEqual(channelsOf(DEFAULT_PREFS, 'long-turn'), {
    panel: false,
    toast: false,
    desktop: false,
    sound: false,
  });
});

test('sound is on for needs you only, under the master switch', () => {
  const on = NOTIFYING_KINDS.filter((k) => chimes(DEFAULT_PREFS, k));
  assert.deepEqual(on, ['question', 'permission']);
  const quiet = applyPrefsPatch(DEFAULT_PREFS, { notificationSound: false }, 1);
  assert.deepEqual(
    NOTIFYING_KINDS.filter((k) => chimes(quiet, k)),
    [],
  );
});

test('a kind stored before sound existed keeps its sound default', () => {
  const stored = Prefs.parse({
    ...DEFAULT_PREFS,
    notificationKinds: { question: { panel: true, toast: false, desktop: false } },
  });
  assert.deepEqual(channelsOf(stored, 'question'), {
    panel: true,
    toast: false,
    desktop: false,
    sound: true,
  });
  const muted = applyPrefsPatch(
    stored,
    {
      notificationKinds: { question: { panel: true, toast: false, desktop: false, sound: false } },
    },
    2,
  );
  assert.equal(chimes(muted, 'question'), false);
});
