import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Alert } from '@joc/protocol';
import { createNoteStore, type NoteResource, PROBLEM } from './note-store.ts';

// The store's races, with a fake server whose every answer is held until the test lets it go.

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>() {
  let pending!: Pending<T>;
  const promise = new Promise<T>((resolve, reject) => {
    pending = { resolve, reject };
  });
  return { promise, ...pending };
}

const alert = (id: string, read = false): Alert => ({
  id,
  kind: 'long-turn',
  title: `Session ${id}`,
  repo: 'harbor-labs/atlas-web',
  sessionId: `s${id}`,
  at: '2026-10-18T10:00:00.000Z',
  read,
});

/** Lets every settled promise's callbacks run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeServer() {
  const gets = {
    alerts: [] as Pending<Alert[] | undefined>[],
  };
  const posts: { kind: string; ids: string[]; answer: Pending<unknown> }[] = [];
  let emit: (r: NoteResource | undefined) => void = () => {};
  const store = createNoteStore({
    alerts: () => {
      const d = deferred<Alert[] | undefined>();
      gets.alerts.push(d);
      return d.promise;
    },
    changeAlerts: (action, ids) => {
      const d = deferred<Alert[] | undefined>();
      posts.push({ kind: action, ids, answer: d as Pending<unknown> });
      return d.promise;
    },
    listen: (onChange) => {
      emit = onChange;
      return () => {};
    },
  });
  store.subscribe(() => {});
  return {
    store,
    gets,
    posts,
    event: (r: NoteResource | undefined) => emit(r),
    /** Answers the oldest unanswered read of the resource. */
    async answer(r: NoteResource, value: Alert[] | undefined) {
      const next = (gets[r] as Pending<unknown>[]).shift();
      assert.ok(next, `a read of ${r} is waiting`);
      next.resolve(value);
      await flush();
    },
    async post(kind: string, value: unknown) {
      const i = posts.findIndex((p) => p.kind === kind);
      const [p] = posts.splice(i, 1);
      assert.ok(p, `a ${kind} post is waiting`);
      p.answer.resolve(value);
      await flush();
    },
  };
}

const unreadAlerts = (s: ReturnType<typeof fakeServer>) =>
  s.store
    .get()
    .alerts?.filter((a) => !a.read)
    .map((a) => a.id);
const alertIds = (s: ReturnType<typeof fakeServer>) => s.store.get().alerts?.map((a) => a.id);

async function loaded(alerts: Alert[]) {
  const s = fakeServer();
  await s.answer('alerts', alerts);
  return s;
}

test('marking read shows at once, before the server answers', async () => {
  const s = await loaded([alert('a'), alert('b')]);
  void s.store.markRead(['a']);
  assert.deepEqual(unreadAlerts(s), ['b']);
  await s.post('read', [alert('a', true), alert('b')]);
  assert.deepEqual(unreadAlerts(s), ['b']);
});

test('a stale read that lands after an action never brings its row back', async () => {
  const s = await loaded([alert('a'), alert('b')]);
  // A stream event starts a read; the person clears `a` while it's on its way.
  s.event('alerts');
  const done = s.store.clear(['a']);
  assert.deepEqual(alertIds(s), ['b']);
  // The clear's answer, with a read on its way, waits for a read after it.
  await s.post('clear', [alert('b')]);
  assert.deepEqual(alertIds(s), ['b']);
  // The read was answered before the server cleared it: it still lists `a`.
  await s.answer('alerts', [alert('a'), alert('b')]);
  assert.deepEqual(alertIds(s), ['b']);
  await s.answer('alerts', [alert('b')]);
  assert.equal(await done, true);
  assert.deepEqual(alertIds(s), ['b']);
  assert.equal(s.gets.alerts.length, 0);
});

test('a stream event mid-action keeps the action and brings in what is new', async () => {
  const s = await loaded([alert('a')]);
  const done = s.store.markRead(['a']);
  // Something new arrives on the stream; the server hasn't got to the read yet.
  s.event('alerts');
  await s.answer('alerts', [alert('n'), alert('a')]);
  assert.deepEqual(unreadAlerts(s), ['n']);
  assert.deepEqual(alertIds(s), ['n', 'a']);
  await s.post('read', [alert('n'), alert('a', true)]);
  assert.equal(await done, true);
  assert.deepEqual(unreadAlerts(s), ['n']);
});

test('two actions answered out of order both stay applied', async () => {
  const s = await loaded([alert('a'), alert('b'), alert('c')]);
  void s.store.markRead(['a']);
  void s.store.markRead(['b']);
  assert.deepEqual(unreadAlerts(s), ['c']);
  // The second answer (computed after both) comes first, then the first (only `a` read).
  const second = s.posts[1];
  assert.ok(second);
  s.posts.splice(1, 1);
  second.answer.resolve([alert('a', true), alert('b', true), alert('c')]);
  await flush();
  assert.deepEqual(unreadAlerts(s), ['c']);
  await s.post('read', [alert('a', true), alert('b'), alert('c')]);
  assert.deepEqual(unreadAlerts(s), ['c']);
  // A fresh read settles it.
  await s.answer('alerts', [alert('a', true), alert('b', true), alert('c')]);
  assert.deepEqual(unreadAlerts(s), ['c']);
});

test('a failed action rolls back and says so quietly, until the next one', async () => {
  const s = await loaded([alert('a'), alert('b')]);
  const done = s.store.clear(['a']);
  assert.deepEqual(alertIds(s), ['b']);
  await s.post('clear', undefined);
  assert.equal(await done, false);
  assert.deepEqual(alertIds(s), ['a', 'b']);
  assert.equal(s.store.get().problem, PROBLEM.clear);
  await s.answer('alerts', [alert('a'), alert('b')]);
  void s.store.markRead(['b']);
  assert.equal(s.store.get().problem, undefined);
});

test('reads are one at a time: a burst of events reads once more, not once each', async () => {
  const s = await loaded([alert('a')]);
  s.event('alerts');
  s.event('alerts');
  s.event('alerts');
  assert.equal(s.gets.alerts.length, 1);
  await s.answer('alerts', [alert('a')]);
  assert.equal(s.gets.alerts.length, 1);
  await s.answer('alerts', [alert('a')]);
  assert.equal(s.gets.alerts.length, 0);
});

test('Clear all on ninety-odd shows in the same frame, in one call, and stays cleared', async () => {
  const alerts = Array.from({ length: 90 }, (_, i) => alert(`a${i}`));
  const s = await loaded(alerts);
  let heard = 0;
  s.store.subscribe(() => heard++);
  void s.store.markRead(alerts.map((a) => a.id));
  // Synchronously: no await between the click and what the panel draws.
  assert.deepEqual(unreadAlerts(s), []);
  assert.ok(heard > 0);
  assert.deepEqual(
    s.posts.map((p) => [p.kind, p.ids.length]),
    [['read', 90]],
  );
  // A refetch that started before the server took it, answered with the old state: still gone.
  s.event(undefined);
  await s.answer('alerts', alerts);
  assert.deepEqual(unreadAlerts(s), []);
  await s.post(
    'read',
    alerts.map((a) => ({ ...a, read: true })),
  );
  assert.deepEqual(unreadAlerts(s), []);
});
