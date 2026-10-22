import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SlashCommand } from '@joc/protocol';
import {
  BUILTIN_COMMANDS,
  sendsCommands,
  sessionSuggestions,
  suggestion,
} from './slash-commands.ts';

const reported: SlashCommand[] = [
  { name: 'code-review', description: 'Review a PR', argumentHint: '<pr>', source: 'project' },
  { name: 'release-notes', description: 'Draft notes', source: 'project', skill: true },
  { name: 'rollout', description: 'Roll out', source: 'plugin', plugin: 'ops-kit' },
];

test('a reported command becomes a suggestion; a skill says whose it is', () => {
  assert.deepEqual(reported.map(suggestion), [
    { name: 'code-review', description: 'Review a PR', args: '<pr>', source: 'project' },
    { name: 'release-notes', description: 'Draft notes', source: 'skill', scope: 'project' },
    { name: 'rollout', description: 'Roll out', plugin: 'ops-kit', source: 'plugin' },
  ]);
});

test('built-ins that only open a panel in the terminal say so', () => {
  const terminal = (name: string, source: SlashCommand['source'] = 'builtin') =>
    suggestion({ name, description: '', source }).terminal;
  assert.equal(terminal('status'), true);
  assert.equal(terminal('config'), true);
  assert.equal(terminal('compact'), undefined);
  // A project's own command of the same name runs as any other.
  assert.equal(terminal('status', 'project'), undefined);
  const fallback = (name: string) => BUILTIN_COMMANDS.find((c) => c.name === name)?.terminal;
  assert.deepEqual([fallback('usage'), fallback('clear')], [true, undefined]);
});

test('plugins from 0.11.0 send their commands', () => {
  assert.equal(sendsCommands('0.11.0'), true);
  assert.equal(sendsCommands('1.0.0'), true);
  assert.equal(sendsCommands('0.10.1'), false);
  assert.equal(sendsCommands(undefined), false);
});

test('built-ins show while the session list loads, then the session list', () => {
  const live = { state: 'working' as const, plugin: '0.11.0' };
  assert.deepEqual(sessionSuggestions(live, undefined), {
    suggestions: BUILTIN_COMMANDS,
    status: 'loading',
  });
  assert.equal(sessionSuggestions(live, reported).status, 'ready');
  assert.equal(sessionSuggestions(live, reported).suggestions.length, 3);
  // An older plugin never sends a list: the built-ins, not loading.
  assert.equal(sessionSuggestions({ state: 'idle', plugin: '0.10.1' }, undefined).status, 'ready');
  assert.equal(
    sessionSuggestions({ state: 'offline', plugin: '0.11.0' }, reported).status,
    'offline',
  );
});
