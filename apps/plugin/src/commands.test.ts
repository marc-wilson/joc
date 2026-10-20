import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type DescribedCommand,
  describedKey,
  type ListedCommand,
  providerOf,
  slashCommands,
} from './commands.ts';

const described = (entries: [string, string, DescribedCommand][]) =>
  new Map(entries.map(([provider, name, about]) => [describedKey(provider, name), about]));

test('a provider is named without its marketplace', () => {
  assert.equal(providerOf('pr-tools@harbor-labs'), 'pr-tools');
  assert.equal(providerOf('ops-kit@inline'), 'ops-kit');
  assert.equal(providerOf('engine'), 'engine');
});

test('commands carry their source, plugin, hint and skill flag', () => {
  const listed: ListedCommand[] = [
    { name: 'compact', description: 'Free up context', source: 'builtin' },
    { name: 'code-review', description: 'Review a pull request', source: 'user' },
    { name: 'standup', description: "Summarise yesterday's commits", source: 'user' },
    { name: 'release-notes', description: 'Draft release notes', source: 'user' },
    {
      name: 'pr-tools:review',
      description: 'Leave review comments',
      source: 'plugin',
      plugin: 'pr-tools',
    },
    { name: 'srv:prompt', description: 'An MCP prompt', source: 'mcp' },
  ];
  const about = described([
    ['engine', 'compact', { argumentHint: '[instructions]', hidden: false }],
    ['project', 'code-review', { argumentHint: '<pr>', hidden: false }],
    ['user', 'standup', { hidden: false }],
    ['project', 'release-notes', { argumentHint: 'since', hidden: false }],
    ['pr-tools', 'pr-tools:review', { argumentHint: '<pr>', hidden: false }],
  ]);
  assert.deepEqual(slashCommands(listed, about, new Set(['project\nrelease-notes'])), [
    {
      name: 'compact',
      description: 'Free up context',
      argumentHint: '[instructions]',
      source: 'builtin',
    },
    {
      name: 'code-review',
      description: 'Review a pull request',
      argumentHint: '<pr>',
      source: 'project',
    },
    { name: 'standup', description: "Summarise yesterday's commits", source: 'user' },
    {
      name: 'release-notes',
      description: 'Draft release notes',
      argumentHint: '[since]',
      source: 'project',
      skill: true,
    },
    {
      name: 'pr-tools:review',
      description: 'Leave review comments',
      argumentHint: '<pr>',
      source: 'plugin',
      plugin: 'pr-tools',
    },
  ]);
});

test('hidden commands and engine internals are left out', () => {
  const listed: ListedCommand[] = [
    { name: 'heapdump', description: 'Dump the heap', source: 'builtin' },
    { name: '__remote-workflow', description: '', source: 'builtin' },
    { name: 'clear', description: 'Start a new session', source: 'builtin' },
  ];
  const about = described([['engine', 'heapdump', { hidden: true }]]);
  assert.deepEqual(
    slashCommands(listed, about).map((c) => c.name),
    ['clear'],
  );
});

test('descriptions keep one line and every field stays in bounds', () => {
  const long = 'x'.repeat(900);
  const [one] = slashCommands(
    [{ name: 'deploy', description: `First line\nsecond line ${long}`, source: 'user' }],
    new Map(),
  );
  assert.equal(one?.description, 'First line');
  const [two] = slashCommands([{ name: 'deploy', description: long, source: 'user' }], new Map());
  assert.equal(two?.description.length, 500);
  assert.ok(two?.description.endsWith('…'));
  const many = Array.from({ length: 700 }, (_, i) => ({
    name: `c${i}`,
    description: '',
    source: 'user',
  }));
  assert.equal(slashCommands(many, new Map()).length, 500);
});

test('the same command listed twice shows once', () => {
  const twice: ListedCommand[] = [
    { name: 'model', description: 'Set the model', source: 'builtin' },
    { name: 'model', description: 'Set the model', source: 'builtin' },
  ];
  assert.equal(slashCommands(twice, new Map()).length, 1);
});
