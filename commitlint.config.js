export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      ['web', 'server', 'plugin', 'protocol', 'db', 'ui', 'repo', 'deps', 'docs'],
    ],
  },
};
