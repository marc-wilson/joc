# Contributing to JOC

Thanks for helping out. JOC is early, so things move fast and conventions are still settling. If
something here doesn't match the code, the code wins; please open a PR to fix this file.

Coding agents (Claude Code and others) should also read [AGENTS.md](AGENTS.md).

## Prerequisites

- **Node 24 or newer.** The server runs `.ts` files directly with Node's built-in type stripping.
- **pnpm 12.14.** Pinned in `package.json` (`packageManager`); Corepack or pnpm will fetch the
  right version.
- **A MongoDB database** for the server, e.g. a free MongoDB Atlas cluster or a local `mongod`.
- **Claude Code**, if you're working on the plugin. The `gh` CLI will be needed for GitHub
  features.

## Setup

```sh
pnpm install
cp apps/server/.env.example apps/server/.env
```

Set `MONGODB_URI` in `apps/server/.env` (`PORT` is optional, default `3000`). Leave the GitHub
settings empty for local dev so the API stays open. To try sign-in, create a separate GitHub OAuth
app for development with callback `http://localhost:5173/auth/github/callback`, and set
`JOC_GITHUB_CLIENT_ID`, `JOC_GITHUB_CLIENT_SECRET` and `JOC_PUBLIC_URL=http://localhost:5173`.
Then run `/joc-login http://localhost:5173` in Claude Code to link your machine to it. `.env` is
git-ignored; never commit it.

`pnpm install` also installs the `commit-msg` git hook (see [Commits](#commits)).

## Dev loop

```sh
pnpm dev
```

This runs every package's `dev` script in parallel:

- **server**: `node --watch`, restarts on change, http://localhost:3000
- **web**: Vite with hot reload, prints its URL (usually http://localhost:5173)

Check the server can reach the database: `curl http://localhost:3000/health/db`.

Before you push:

```sh
pnpm check && pnpm typecheck && pnpm test && pnpm build
```

| Script           | What it does                                  |
| ---------------- | --------------------------------------------- |
| `pnpm dev`       | Runs every package's `dev` script in parallel |
| `pnpm build`     | Builds every package that has a `build` step  |
| `pnpm typecheck` | Type-checks every package                     |
| `pnpm test`      | Runs every package's tests                    |
| `pnpm check`     | Biome lint + format check                     |
| `pnpm fix`       | Biome lint + format, applying safe fixes      |

To run a script in one package: `pnpm --filter @joc/web <script>`.

## Code style

- **Biome** is the linter and formatter. Run `pnpm fix` before committing; `pnpm check` must pass.
- **Match the surrounding code.** Follow the patterns already in the file and package rather than
  introducing new ones.
- **Don't format `packages/ui/src/styles/**`.** It's excluded from Biome on purpose so it stays
  identical to the design system source.

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org/). A `commit-msg` hook
(commitlint with `@commitlint/config-conventional`, installed by `simple-git-hooks` on
`pnpm install`) rejects messages that don't.

```
<type>(<scope>): <summary>

[optional body]

[optional footer(s)]
```

- **Type**: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`, `style`,
  `revert`.
- **Scope**: required, one of:

  | Scope      | Covers                         |
  | ---------- | ------------------------------ |
  | `web`      | `apps/web`                     |
  | `server`   | `apps/server`                  |
  | `plugin`   | `apps/plugin`                  |
  | `protocol` | `packages/protocol`            |
  | `db`       | `packages/db`                  |
  | `ui`       | `packages/ui`                  |
  | `repo`     | Root config and tooling        |
  | `deps`     | Dependency updates             |
  | `docs`     | Documentation                  |

- **Summary**: imperative, lower case, no trailing period.

Examples:

```
feat(web): show session list grouped by repo
fix(server): close SSE stream when the client disconnects
chore(deps): bump hono
refactor(protocol): split session schemas into their own module
docs(plugin): explain the plugin marketplace setup
```

**Breaking changes** get a `!` after the type/scope and a `BREAKING CHANGE:` footer:

```
feat(protocol)!: rename session `ctx` to `contextLeft`

BREAKING CHANGE: plugins sending `ctx` must send `contextLeft` instead.
```

Check a message locally without committing:

```sh
echo "feat(web): add PR list" | pnpm exec commitlint   # check a message
pnpm exec commitlint --edit                            # check the last commit message
```

## Branches

Work on short-lived branches off `main`, named after the change:

```
feat/session-list
fix/sse-disconnect
docs/contributing
```

Rebase on `main` to stay current, and keep branches small enough to merge in a day or two.

## Pull requests

- **Small, one concern.** Split unrelated changes into separate PRs.
- **Green locally**: `pnpm check && pnpm typecheck && pnpm test && pnpm build` passes.
- **Screenshots for UI changes**, in both the dark and light themes.
- **Plugin changes bump its version.** Anything changed under `apps/plugin/` needs a new
  `version` in `apps/plugin/.claude-plugin/plugin.json`: patch for a fix, minor for a feature.
  Installs from GitHub only update when the version changes, and CI fails the PR otherwise.
- **Describe the why**, not just the what, and link the issue if there is one.
- PR titles follow the same `type(scope): description` format as commits; CI checks them.

## UI rules

- **Use `@joc/ui`.** Build screens from its components and CSS tokens, not one-off styles or
  hard-coded colors.
- **Missing a component?** Add it to `packages/ui` and use it from there, rather than building it
  inside `apps/web`.
- **Support both themes.** Tokens cover dark and light; check your change in each.
- **Fixtures use made-up data only.** No real people, GitHub handles, orgs or repos in fixtures,
  tests, screenshots or examples. Use fictional names like the `harbor-labs` org.

## Reporting issues

Open a GitHub issue with:

- what you expected and what happened
- steps to reproduce
- your Node and pnpm versions, OS, and Claude Code version if the plugin is involved
- logs or screenshots, with tokens, connection strings and private repo names removed

For security problems, don't open a public issue; contact the maintainers privately instead.

License: not yet chosen.
