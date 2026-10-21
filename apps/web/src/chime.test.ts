import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ChimeAudio, createChime, THROTTLE_MS } from './chime.ts';

// The chime against a fake AudioContext that logs what it's asked to do.

function fakeAudio() {
  const calls: string[] = [];
  const param = (name: string) => ({
    setValueAtTime: (v: number) => calls.push(`${name}=${v}`),
    linearRampToValueAtTime: (v: number) => calls.push(`${name}->${v}`),
    exponentialRampToValueAtTime: (v: number) => calls.push(`${name}~>${v}`),
  });
  const ctx: ChimeAudio = {
    currentTime: 0,
    state: 'running',
    destination: 'out',
    resume: async () => {
      calls.push('resume');
    },
    createOscillator: () => ({
      type: '',
      frequency: param('hz'),
      connect: () => calls.push('connect'),
      start: (at: number) => calls.push(`start@${at.toFixed(3)}`),
      stop: (at: number) => calls.push(`stop@${at.toFixed(3)}`),
    }),
    createGain: () => ({ gain: param('gain'), connect: () => calls.push('connect') }),
  };
  return { ctx, calls };
}

function setup() {
  let now = 1_000_000;
  let made = 0;
  const audio = fakeAudio();
  const chime = createChime({
    audio: () => {
      made++;
      return audio.ctx;
    },
    now: () => now,
  });
  return {
    chime,
    calls: audio.calls,
    made: () => made,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

test('silent until the person has interacted with the page', () => {
  const s = setup();
  assert.equal(s.chime.play(), false);
  assert.equal(s.made(), 0, 'no AudioContext before an interaction');
  s.chime.interacted();
  assert.equal(s.chime.play(), true);
  assert.equal(s.made(), 1);
});

test('two soft notes rising a fourth, about 300ms in all', () => {
  const s = setup();
  s.chime.interacted();
  s.chime.play();
  const notes = s.calls.filter((c) => c.startsWith('hz='));
  assert.equal(notes.length, 2);
  assert.deepEqual(
    notes.map((c) => Number(c.slice(3))),
    [659.25, 880],
  );
  const peaks = s.calls
    .filter((c) => c.startsWith('gain~>'))
    .map((c) => Number(c.slice(6)))
    .filter((p) => p > 0.001);
  assert.ok(peaks.length === 2 && peaks.every((p) => p > 0 && p <= 0.12), 'soft');
  const starts = s.calls.filter((c) => c.startsWith('start@')).map((c) => Number(c.slice(6)));
  const stops = s.calls.filter((c) => c.startsWith('stop@')).map((c) => Number(c.slice(5)));
  const length = Math.max(...stops) - Math.min(...starts);
  assert.ok(length > 0.25 && length < 0.35, `lasts ${length}s`);
});

test('at most once every two seconds, however many arrive', () => {
  const s = setup();
  s.chime.interacted();
  assert.equal(s.chime.play(), true);
  assert.equal(s.chime.play(), false);
  s.tick(THROTTLE_MS - 1);
  assert.equal(s.chime.play(), false);
  s.tick(1);
  assert.equal(s.chime.play(), true);
  assert.equal(s.calls.filter((c) => c.startsWith('start@')).length, 4);
  assert.equal(s.made(), 1, 'one AudioContext for the page');
});

test('a test plays at once, and counts as an interaction', () => {
  const s = setup();
  assert.equal(s.chime.test(), true);
  assert.equal(s.chime.test(), true);
});
