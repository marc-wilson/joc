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

The plan is a hosted site where a token links a person's sessions to the dashboard, with no
sign-up.

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
  it for prompts and answers. GitHub data comes from the `gh` CLI on your machine, via the plugin.
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

`pnpm dev` starts the server (http://localhost:3000) and the Vite dev server for the dashboard
(it prints its URL, usually http://localhost:5173). Check the database connection:

```sh
curl http://localhost:3000/health/db   # {"ok":true}
```

To try the plugin in Claude Code, add this repo as a marketplace with
`/plugin marketplace add <path-or-repo>` and install `joc` from it. It doesn't report anything yet.

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

- **CI** (`.github/workflows/ci.yml`, pull requests): `pnpm check`, `pnpm typecheck`,
  `pnpm build` and commitlint over the PR's commits.
- **Release** (`.github/workflows/release.yml`, push to `main`): builds the `Dockerfile` for
  `linux/arm64`, pushes `latest` and the commit SHA, then runs `helm upgrade --install` of the
  chart in `k8s/` into namespace `joc` on AKS (`production` environment).
- The chart runs exactly one replica (live updates fan out in-process) behind
  `joc.marcswilson.com`. `MONGODB_URI` comes from the `joc-secrets` Kubernetes secret, which is
  created by hand and never by the chart.

Build and run the image locally:

```sh
docker build -t joc:local .
docker run --rm -p 3000:3000 --env-file apps/server/.env joc:local
curl http://localhost:3000/health/db   # {"ok":true}
```

## License

Not yet chosen.
