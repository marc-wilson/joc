import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ComposerSuggestion, matchSuggestions, slashAt, slashQuery } from './slash.ts';

const commands: ComposerSuggestion[] = [
  { name: 'clear', description: 'Clear the conversation', source: 'builtin' },
  { name: 'reload-plugins', description: 'Reload plugins', source: 'builtin' },
  { name: 'resume', args: '[session]', description: 'Resume', source: 'builtin' },
  { name: 'code-review', args: '<pr>', description: 'Review a PR', source: 'project' },
  { name: 'reload-prompts', description: 'Re-read prompts', source: 'user' },
  {
    name: 'pr-tools:review',
    plugin: 'pr-tools',
    args: '<pr>',
    description: 'Inline',
    source: 'plugin',
  },
  { name: 'gh-kit:review', plugin: 'gh-kit', description: 'Branch', source: 'plugin' },
  { name: 'ops-kit:rollout', plugin: 'ops-kit', description: 'Roll out', source: 'plugin' },
  // A plugin's command registered in code runs by its bare name.
  { name: 'joc-status', plugin: 'joc', description: 'Check the link', source: 'plugin' },
  {
    name: 'release-notes',
    description: 'Draft notes',
    source: 'skill',
    scope: 'project',
  },
];

const names = (typed: string) => matchSuggestions(commands, typed).map((r) => r.shown);

test('a command is being typed until a space', () => {
  assert.equal(slashQuery('/'), '');
  assert.equal(slashQuery('/reload-p'), 'reload-p');
  assert.equal(slashQuery('/code-review 482'), undefined);
  assert.equal(slashQuery('fix /this'), undefined);
});

test('a /word at the caret anywhere in the message is a command being typed', () => {
  const at = (marked: string) => {
    const caret = marked.indexOf('|');
    return slashAt(marked.replace('|', ''), caret);
  };
  assert.deepEqual(at("don't /wor|"), { query: 'wor', start: 6, end: 10 });
  assert.deepEqual(at('/|'), { query: '', start: 0, end: 1 });
  assert.deepEqual(at('first line\n/rev|'), { query: 'rev', start: 11, end: 15 });
  assert.deepEqual(at('run /rev| then stop'), { query: 'rev', start: 4, end: 8 });
  // Inside a URL or a path, or with the caret mid-word, it isn't.
  assert.equal(at('see https://harbor-labs.dev/|'), undefined);
  assert.equal(at('open a/b|'), undefined);
  assert.equal(at('cd /usr/lo|'), undefined);
  assert.equal(at('cd src/|'), undefined);
  assert.equal(at('try /rev|iew'), undefined);
  assert.equal(at('try /review done|'), undefined);
});

test('only a slash lists everything, grouped by source', () => {
  const rows = matchSuggestions(commands, '');
  assert.equal(rows.length, commands.length);
  assert.deepEqual(
    rows.flatMap((r) => (r.group ? [r.group] : [])),
    ['Built-in', 'Project', 'User', 'Plugins', 'Skills'],
  );
});

test('typing filters to a flat list, prefix matches first, the typed part marked', () => {
  assert.deepEqual(names('reload-p'), ['reload-plugins', 'reload-prompts']);
  const [first] = matchSuggestions(commands, 'reload-p');
  assert.deepEqual([first?.pre, first?.hit, first?.post], ['', 'reload-p', 'lugins']);
  assert.equal(first?.group, undefined);
  // Prefix on the name, then the source order; a substring match comes last.
  assert.deepEqual(names('re'), [
    'reload-plugins',
    'resume',
    'reload-prompts',
    'pr-tools:review',
    'gh-kit:review',
    'release-notes',
    'code-review',
  ]);
});

test('two plugins sharing a name show plugin:command; a unique one its short name', () => {
  const rows = matchSuggestions(commands, 'r');
  const review = rows.filter((r) => r.command.name.endsWith(':review'));
  assert.deepEqual(
    review.map((r) => [r.shown, r.ns, r.label]),
    [
      ['pr-tools:review', 'pr-tools:', 'pr-tools'],
      ['gh-kit:review', 'gh-kit:', 'gh-kit'],
    ],
  );
  const rollout = rows.find((r) => r.command.name === 'ops-kit:rollout');
  assert.deepEqual([rollout?.shown, rollout?.insert], ['rollout', 'ops-kit:rollout']);
  const status = matchSuggestions(commands, 'joc-st')[0];
  assert.deepEqual([status?.shown, status?.insert], ['joc-status', 'joc-status']);
  assert.deepEqual(names('joc:joc-st'), ['joc-status']);
  // Typing the plugin's prefix matches too.
  assert.deepEqual(names('ops-kit:ro'), ['rollout']);
  assert.deepEqual(names('ops'), ['rollout']);
});

test('nothing matching leaves the list empty', () => {
  assert.deepEqual(names('reload-px'), []);
});

test('the source column names where each comes from', () => {
  const label = (name: string) =>
    matchSuggestions(commands, name).find((r) => r.command.name === name)?.label;
  assert.equal(label('clear'), 'Built-in');
  assert.equal(label('code-review'), 'Project');
  assert.equal(label('release-notes'), 'Skill · project');
  assert.equal(label('ops-kit:rollout'), 'ops-kit');
});
