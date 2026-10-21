# The JOC GitHub App

One GitHub App does two jobs for a JOC server:

- **Sign-in.** Its web flow replaces the OAuth app's. People keep their JOC accounts: an account
  is its GitHub user id, whichever app signs it in.
- **Webhooks.** GitHub tells JOC the moment a pull request, review, CI run or comment changes.
  The plugin stops reading GitHub with `gh` for everyone the App covers.

Without the App's webhook secret, JOC works as before: each machine's plugin reads your pull
requests through `gh` about once a minute.

## Create the App

Create it once per JOC server, under the account that runs the server: **Settings → Developer
settings → GitHub Apps → New GitHub App** (for an org: the org's **Settings → Developer settings
→ GitHub Apps**). `<host>` below is where the dashboard is reached (`JOC_PUBLIC_URL`).

| Setting | Value |
| --- | --- |
| GitHub App name | Any unique name, e.g. `JOC` plus your server's name |
| Homepage URL | `https://<host>` |
| Callback URL | `https://<host>/auth/github/callback` |
| Expire user authorization tokens | Either; JOC uses the token once at sign-in (profile and installations) and keeps none |
| Request user authorization (OAuth) during installation | **On** |
| Enable Device Flow | Off |
| Setup URL | Empty |
| Webhook: Active | **On** |
| Webhook URL | `https://<host>/api/github/webhook` |
| Webhook secret | A long random string, e.g. `openssl rand -hex 32` |
| SSL verification | On |
| Where can this GitHub App be installed? | **Any account**, so other orgs can install it; **Only on this account** for yours alone |

**Repository permissions** (all read-only):

| Permission | Access | Why |
| --- | --- | --- |
| Pull requests | Read | Pull requests, reviews, review comments, changed files |
| Checks | Read | Check runs and suites (CI) |
| Commit statuses | Read | Commit statuses (CI from other services) |
| Actions | Read | Workflow runs |
| Issues | Read | Comments on pull requests and issues |
| Metadata | Read | Required by GitHub |

**Organization permissions:**

| Permission | Access | Why |
| --- | --- | --- |
| Members | Read | Who in the org uses JOC when it's installed, and who is in a team asked for review |

**Account permissions:** none. JOC reads only the public profile at sign-in.

**Subscribe to events:** Pull request, Pull request review, Pull request review comment, Issue
comment, Check run, Check suite, Workflow run, Status. (Installation events come without
subscribing.)

After creating it, on the App's page:

1. Note the **App ID** and the **Client ID**.
2. **Generate a new client secret.**
3. **Generate a private key**: GitHub downloads a `.pem` file.

## Configure the server

| Variable | Value |
| --- | --- |
| `JOC_GITHUB_CLIENT_ID` | The App's Client ID (replaces the OAuth app's) |
| `JOC_GITHUB_CLIENT_SECRET` | The App's client secret |
| `JOC_GITHUB_APP_ID` | The App ID |
| `JOC_GITHUB_APP_PRIVATE_KEY` | The private key: the PEM, or one line of base64 (`base64 -i key.pem \| tr -d '\n'`) |
| `JOC_GITHUB_WEBHOOK_SECRET` | The webhook secret |

Locally they go in `apps/server/.env`. For the Helm chart (`k8s/`), the deploy job fills
`JOC_GITHUB_APP_ID` from a `production` environment variable and the private key (base64, one
line) and webhook secret from `production` secrets. Never commit any of them.

The old OAuth app can be deleted once sign-in through the App works.

## Install it

The App is installed once per account, and covers everyone in it:

- **An org:** an org owner opens `https://github.com/apps/<app-name>/installations/new`, picks
  the org, and chooses **All repositories** or the ones JOC should see. A member who isn't an
  owner can request it, and an owner approves. From then on every JOC user in the org gets its
  pull requests, reviews, CI and comments, with no step of their own.
- **Your personal repos:** install it on your own account the same way.

Installing signs the installer in to JOC. Everyone else is picked up at once (the App reads the
org's members), or the next time they sign in.

From the dashboard, **Install** (in the banner, or **Settings → GitHub**) goes through
`/auth/github/install`, which opens the App's install page and remembers the page you were on.
GitHub returns to the callback URL (no Setup URL is needed, as "Request user authorization during
installation" is on). JOC signs you in through the App again, which GitHub answers at once, reads
your installations, and lands you back on that page with the banner gone. If an org owner still
has to approve the install, JOC says so.

## Switching an existing server to the App

People already signed in keep their browser session, which predates the App, so JOC has never
seen their installations. JOC records when each person signs in through the App; anyone without
that record:

- sees **Reconnect GitHub to get live updates** under the nav bar, and **Reconnect GitHub** in
  the avatar menu. One click signs them in through the App and back to the same page;
- keeps the plugin's `gh` reads, about once a minute, until the App covers them.

After reconnecting, someone the App doesn't cover yet sees **Install JOC Dashboard on your
account or org** (using the App's own name), with **Install** and **Check again** (signs in
through the App again to re-read installations; JOC keeps no GitHub token). Covered people see
nothing. **Settings → GitHub** shows which accounts and orgs cover you, with Manage and Install
links and Reconnect.

Nobody gets locked out. A sign-in that fails, is cancelled or expires goes back to the page it
started from and says so, and the session you already had stays. Only a sign-in that succeeds
replaces it. Machines keep their own tokens throughout and never need to link again.

The Install link needs the App's slug, which the server reads from GitHub with the App's id and
key. Without those, set `JOC_GITHUB_APP_SLUG`.

## What JOC does with it

- Pull request, review and CI events keep each person's lists (Reviews, Mine, the PR page)
  current: an event reaches only the pull request's author and the people asked to review it,
  including the members of a team asked to review.
- A comment on your pull request or issue, or one that @mentions you, is a notification that
  links to the comment. `@org/team` mentions don't notify.
- Review requests resolve when you review or the request is withdrawn, failed CI when it passes,
  either when the pull request closes.
- When you sign in, or the App is installed where you are, JOC reads your open pull requests
  once through the App. After that only webhooks update them: nothing polls.
- Repositories the App isn't installed on don't appear for people it covers.
- Uninstalling it hands GitHub back to each machine's plugin and `gh`.
