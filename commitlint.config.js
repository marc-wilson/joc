export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Every commit and PR title is type(scope): description.
    'scope-empty': [2, 'never'],
    'scope-enum': [
      2,
      'always',
      ['web', 'server', 'plugin', 'protocol', 'db', 'ui', 'repo', 'deps', 'docs'],
    ],
  },
};
