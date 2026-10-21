# JOC

JOC (Joint Operations Command) is a web dashboard for developers who work with Claude Code and
GitHub. It mirrors every live Claude Code session (status, what Claude is doing, context left,
background tasks), lets you talk to those sessions from the browser, and shows the GitHub work
around them: PRs to review, your PRs with CI, and a PR-style diff of each session's branch that
you can comment on and send back to Claude.

## Status

**Early.** The repo is scaffolded and the design system is ported into `packages/ui`. The real
screens, the plugin and the server's session API are in progress. Nothing is usable end to end
yet.

It's hosted at [joc.marcswilson.com](https://joc.marcswilson.com): sign in with GitHub, link each
machine with `/joc-login` in Claude Code, and you see only your own sessions.

## How it fits together

```
  your machine                          hosted                  browser
┌─────────────────────┐   reports    ┌──────────┐  live (SSE)  ┌───────────────┐
│ Claude Code session │ ───────────▶ │          │ ───────────▶ │ web dashboard │
│   └─ JOC plugin     │              │  server  │              │               │
│       └─ gh CLI     │ ◀─────────── │          │ ◀─────────── │               │
└─────────────────────┘   polls for  └──────────┘   prompts,   └───────────────┘
                          prompts                   answers
```

- The **plugin** runs inside each Claude Code session. It pushes reports to the server and polls
  it for prompts and answers.
- **GitHub** data comes from the JOC GitHub App's webhooks, the moment it changes
  ([docs/github-app.md](docs/github-app.md)). Without the App, the plugin reads it with the `gh`
  CLI on your machine instead.
- The **server** streams live updates to the dashboard over Server-Sent Events.
- Nothing reaches into your machine: every connection starts from the plugin.

## Repo layout

```
.
├── apps/
│   ├── web/          React 19 + Vite dashboard
│   ├── server/       Hono on Node, run straight from .ts (no build step)
│   └── plugin/       Claude Code plugin (skeleton)
├── packages/
│   ├── protocol/     Shared zod schemas for plugin, server and web
│   ├── db/           Shared MongoDB client
│   └── ui/           JOC design system: React components + CSS tokens
└── .claude-plugin/
    └── marketplace.json   Makes this repo installable as a Claude Code plugin marketplace
```

## Quick start

Needs Node 24+ and pnpm (the version is pinned in `package.json`; Corepack or pnpm itself will
fetch it).

```sh
pnpm install
cp apps/server/.env.example apps/server/.env   # then set MONGODB_URI
pnpm dev
```

`apps/server/.env` needs:

| Variable      | Required | Notes                                                 |
| ------------- | -------- | ----------------------------------------------------- |
| `MONGODB_URI` | yes      | Any MongoDB connection string, e.g. an Atlas cluster  |
| `PORT`        | no       | Server port, defaults to `3000`                       |
| `JOC_GITHUB_CLIENT_ID`, `JOC_GITHUB_CLIENT_SECRET` | no | The GitHub App's (or an OAuth app's) client, for sign-in; unset means open (dev only) |
| `JOC_GITHUB_WEBHOOK_SECRET`, `JOC_GITHUB_APP_ID`, `JOC_GITHUB_APP_PRIVATE_KEY` | no | The JOC GitHub App ([docs/github-app.md](docs/github-app.md)); unset means the plugin reads GitHub with `gh` |
| `JOC_PUBLIC_URL` | no | Where the dashboard is reached, for the OAuth callback (dev: `http://localhost:5173`) |

`pnpm dev` starts the server (http://localhost:3000) and the Vite dev server for the dashboard
(it prints its URL, usually http://localhost:5173). Check the database connection:

```sh
curl http://localhost:3000/health/db   # {"ok":true}
```

To try the plugin in Claude Code, add this repo as a marketplace with
`/plugin marketplace add <path-or-repo>` and install `joc` from it. Run `/joc-login` to link the
machine to a JOC server (`https://joc.marcswilson.com` unless you pass another URL); its token is
kept in `~/.claude/joc/credentials.json`. Without a link the plugin reports to
`http://localhost:3000`. `JOC_URL` and `JOC_TOKEN` in Claude Code's environment override both.

The plugin never shows an error in a session. If sessions stop updating on the dashboard, run
`/joc-status`: it says where the machine reports, whether the server answers and takes its token,
and the plugin's recent problems (an unreachable server, a refused token or report, an error in
the plugin itself). They're kept, capped, in `~/.claude/joc/status.json`, and also shown under
Plugin problems on the Machines page once the server is reachable again.

With the JOC GitHub App installed on your account or org, GitHub's webhooks keep your pull
requests, reviews and CI current, and a comment on your pull request or one that @mentions you
shows in the dashboard's notifications ([docs/github-app.md](docs/github-app.md)). The plugin
then reads nothing from GitHub. Without the App, it reads your pull requests through `gh`, once a
minute per machine.

| Variable in Claude Code's environment | Effect |
| --- | --- |
| `JOC_GITHUB=0` | Keeps GitHub on your machine: the plugin reads no pull requests with `gh` |

The server expects the plugin version it was built with. The Machines page shows each machine's
plugin version, and the dashboard shows a banner while one is out of date. In Claude Code, an out
of date plugin says so once per session; run `/joc-update` to update it (it runs
`claude plugin marketplace update joc` and `claude plugin update joc@joc`, then reloads plugins).
A plugin from before `/joc-update` existed is updated by hand:

```sh
claude plugin marketplace update joc && claude plugin update joc@joc
```

then `/reload-plugins` in its sessions. An older plugin keeps working meanwhile; only newer
features miss it. A dashboard tab left open across a deploy offers to reload.

## Scripts

Run from the repo root.

| Script           | What it does                                          |
| ---------------- | ----------------------------------------------------- |
| `pnpm dev`       | Runs every package's `dev` script in parallel         |
| `pnpm build`     | Builds every package that has a `build` script        |
| `pnpm typecheck` | Type-checks every package                             |
| `pnpm test`      | Runs every package's tests                            |
| `pnpm check`     | Biome lint + format check                             |
| `pnpm fix`       | Biome lint + format, applying safe fixes              |

## More

- [CONTRIBUTING.md](CONTRIBUTING.md): setup, dev loop, commits and PRs
- [AGENTS.md](AGENTS.md): conventions for coding agents working in this repo


## Deployment

JOC ships as one image, `marcswilsoncontainers.azurecr.io/joc`: the server serves the API and
the built dashboard (`WEB_DIST`) on port 3000, so everything is same-origin.

One workflow, `.github/workflows/ci.yml`, with two jobs:

- **check** (every PR and push): `pnpm check`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and
  on PRs commitlint over the title and every commit, plus a check that a change under
  `apps/plugin/` bumps the plugin's version. `main` requires it to pass.
- **deploy** (pushes to `main`, after check): builds the `Dockerfile` for `linux/arm64`, pushes
  it to ACR tagged with the commit SHA, then runs `helm upgrade --install` of the chart in `k8s/`
  into namespace `joc` on AKS, in the `production` environment. One deploy runs at a time, and
  only the current tip of `main` deploys: a run for an older commit (a late one, or a re-run)
  skips, so production always ends on the newest `main`.
- Deploys have no downtime: the new pod starts first, takes traffic once it's ready, and the
  old one stops only after the ingress has stopped routing to it. Live streams end on shutdown
  and browsers reconnect to the new pod, which starts them with a fresh snapshot.
- The chart runs exactly one replica (live updates fan out in-process) behind
  `joc.marcswilson.com`. `MONGODB_URI` and `JOC_GITHUB_CLIENT_SECRET` are secrets, and
  `JOC_GITHUB_CLIENT_ID` a variable (it's public), in the GitHub `production` environment; the
  chart turns them into the `joc-secrets` Kubernetes secret at deploy time, and the deploy fails
  if any is empty. The GitHub App's `JOC_GITHUB_APP_PRIVATE_KEY` (base64, one line) and
  `JOC_GITHUB_WEBHOOK_SECRET` are secrets and `JOC_GITHUB_APP_ID` a variable there too; they're
  optional.
- Every `/api/*` route acts for one user: a browser signed in with GitHub (an HttpOnly session
  cookie) or a linked machine (its own bearer token). Everything stored belongs to that user.
  `/health` and `/health/db` stay open for the probes.

Build and run the image locally:

```sh
docker build -t joc:local .
docker run --rm -p 3000:3000 --env-file apps/server/.env joc:local
curl http://localhost:3000/health/db   # {"ok":true}
```

## License

Not yet chosen.
