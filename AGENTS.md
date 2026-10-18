# AGENTS.md

Guidance for coding agents working in this repo. Human contributors: see `README.md` and `CONTRIBUTING.md`.

## What JOC is

JOC (Joint Operations Command) is an open-source, hosted web dashboard for developers who work with Claude Code and GitHub.
It shows every live Claude Code session (state, conversation, background tasks, branch changes) and the GitHub work around them (PRs, CI).
From the dashboard you can prompt a session, answer its questions, review its diff and start new sessions.

```
Claude Code session ── plugin ──▶ server ──▶ web dashboard (live via SSE)
                    ◀── prompts, answers, launches (plugin polls) ──
```

- The plugin runs inside each session, pushes reports to the server, and polls it for prompts, question answers and new-session requests.
- Nothing reaches into the user's machine. A new session starts because a running session's plugin picks up the request.
- Hosted: a token links a person's sessions to the site, no sign-up. Each token sees only its own data; never let a query cross tokens.
- GitHub data comes from the `gh` CLI on the user's machine, using its sign-in.

## Repo map

| Path | Package | What |
|---|---|---|
| `apps/web` | `@joc/web` | React 19 + Vite dashboard |
| `apps/server` | `@joc/server` | Hono on Node; `/health`, `/health/db` |
| `apps/plugin` | `@joc/plugin` | The Claude Code plugin (`.claude-plugin/plugin.json`) |
| `packages/protocol` | `@joc/protocol` | zod schemas for every shared message shape |
| `packages/db` | `@joc/db` | The shared MongoDB client (`getClient`, `closeClient`) |
| `packages/ui` | `@joc/ui` | The design system: React components + CSS tokens |

- pnpm workspaces (`apps/*`, `packages/*`), Node >= 24. Use `pnpm`, never npm or yarn.
- Packages export TS source directly (`"exports": "./src/index.ts"`); there is no library build step.
- The server runs `.ts` directly with Node type stripping. So, everywhere (`erasableSyntaxOnly` is on in `tsconfig.base.json`):
  - only erasable TS: no `enum`, `namespace` or constructor parameter properties;
  - relative imports carry explicit `.ts` / `.tsx` extensions;
  - type-only imports use `import type` (`verbatimModuleSyntax`).
- Anything crossing the network (plugin, server, web) is defined once in `@joc/protocol` as a zod schema with an inferred type of the same name. Validate on receipt; don't hand-write duplicate types.
- One MongoDB client per process, from `@joc/db`. Keep pool settings at driver defaults until real traffic justifies a change.
- Formatting and lint are Biome: 2 spaces, single quotes, 100 columns, organised imports. Run `pnpm fix` rather than formatting by hand.

## Commands

Run from the repo root.

| Command | Does |
|---|---|
| `pnpm install` | Install all workspaces |
| `pnpm dev` | Every package's `dev` in parallel (web via Vite, server with `--watch`) |
| `pnpm check` | Biome lint + format check |
| `pnpm fix` | Biome with safe fixes written |
| `pnpm typecheck` | `tsc` in every package |
| `pnpm build` | Build packages that have a build (currently `@joc/web`) |

- One package: `pnpm --filter @joc/server dev` (or `@joc/web`, etc.).
- Server secrets live in `apps/server/.env` (git-ignored; template in `.env.example`: `MONGODB_URI`, `PORT`). Never commit, print, log or paste their values.

## Definition of done

Before committing:

1. `pnpm check && pnpm typecheck && pnpm build` passes.
2. UI changes: look at the result in both the dark and light theme.

## Commits

Full rules are in `CONTRIBUTING.md`. In short:

- Conventional Commits, enforced by commitlint (`@commitlint/config-conventional`) via a `commit-msg` hook installed by `simple-git-hooks`.
- Scope optional; if used, one of: `web`, `server`, `plugin`, `protocol`, `db`, `ui`, `repo`, `deps`, `docs`.
- Subject: imperative, lower case, no trailing period. Example: `feat(server): stream session reports over sse`.
- One concern per commit.

## Product rules

- **Mirror real Claude Code sessions only.** Never invent a separate session concept of our own.
- **Use the screen space.** Nothing cramped, no narrow first columns. Wide panes; truncate list text with an ellipsis, but never clip code (diff lines wrap).
- **Calm UI.** Nothing auto-switches, reorders under the cursor, flickers, jumps or disappears. Live updates replace text in place and fade in. New content arrives at the bottom of a conversation, never above what the user is reading.

## UI rules

- Build with `@joc/ui` components and its CSS tokens (`var(--bg-raised)`, `var(--text-secondary)`, ...). No one-off colours, sizes, radii or shadows.
- Missing a component? Add it to `packages/ui/src` and export it from `index.ts`; don't build it inline in an app.
- `packages/ui/src/styles/**` (`tokens.css`, `components.css`) mirrors the design system and is excluded from Biome. Don't hand-edit it to diverge: style changes and new component styles go into the JOC design system first, then get copied here.
- Themes: `data-theme="dark"` (default) or `"light"` on any element. Every token has both values; dark and light are equals.

### Session states

Identical everywhere. `StateDot` (used by `StateBadge`, `SessionRow`, `Tabs`, `QuestionCard`, `Toast`) is the only way to draw a state. The enum is `SessionState` in `@joc/protocol`.

| State | Colour | Dot | Motion | Row rail |
|---|---|---|---|---|
| `working` | green | filled circle | soft pulse | solid 3px |
| `background` | blue | open ring | spins | dashed |
| `needs` | orange | filled diamond + halo | none | solid 4px + soft tint |
| `idle` | grey | hollow circle | none | none |
| `offline` | red | slashed circle | none | dotted |

- States never rely on hue alone: shape, motion, rail pattern and the badge word carry meaning. Under `prefers-reduced-motion` the pulse and spin stop.
- `needs` orange is the only loud colour. Everything else is neutral surfaces, text levels and hairlines.
- One meaning per signal: a dot is always a session state; a check/cross is always an outcome; `accent` (indigo) is always interactive/selected, never a state.

### CI marks

- Separate from states: `CIMark` / `CIBadge` with `CIStatus` (`pass`, `fail`, `pending`, `skipped`). Stroked marks, never dots, never animated.
- `CIBadge` is square-cornered and outlined; only a failure colours its border. Never fill a pending chip or outline a needs badge.
- Tool results, finished background tasks and setup checks reuse the same marks.

### Motion, type, voice

- Motion is opacity and colour only, never position or size. Use the duration tokens (`--duration-instant`, `-fast`, `-fade`). Nothing slides, bounces or auto-scrolls.
- Updating numbers (context %, counts, times) use tabular figures and fixed widths.
- Hover and selection change fills only, never size. Visible focus ring on everything focusable.
- Voice: plain, short, sentence case ("Needs you", "No live sessions"). No emoji, no exclamation marks, no jokes. Claude is "Claude"; the user is "you".
- Commands, paths and branches are always mono (`Code`, `Branch` from `@joc/ui`).
- Icons come from `Icon`; they inherit text colour and never carry state on their own.

## Data and privacy

- Fixtures, examples, tests and screenshots use made-up data only: the `harbor-labs` org (e.g. `harbor-labs/atlas-web`) and fictional people. Never real repos, companies or people.
- No tokens, connection strings or private URLs in code, fixtures or docs.
