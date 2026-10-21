// Where the person's GitHub data comes from. Once the JOC GitHub App covers them, the server says
// so on its answers, and the plugin reads nothing from GitHub with `gh`: webhooks bring it.

/** The response header that says so; the server's GITHUB_SOURCE_HEADER. */
export const GITHUB_SOURCE_HEADER = 'x-joc-github';

/** Whether a server answer says the App brings this person's GitHub data. */
export const githubByApp = (headers: Pick<Headers, 'get'>) =>
  headers.get(GITHUB_SOURCE_HEADER) === 'app';
