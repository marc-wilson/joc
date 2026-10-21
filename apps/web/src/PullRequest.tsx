import { type Launch, type PullRequest, reviewPrompt, type Session } from '@joc/protocol';
import {
  Button,
  Card,
  CardNote,
  ChangedFile,
  CIBadge,
  CIRow,
  Code,
  DiffStat,
  EmptyState,
  PRHeader,
  ReviewAction,
  ReviewRow,
  SectionHeader,
  SessionLink,
  TextLink,
} from '@joc/ui';
import { useEffect, useState } from 'react';
import {
  startLaunch,
  useGitHub,
  useHistory,
  useLaunches,
  useNow,
  useReviewSettings,
  useSessions,
} from './hooks.ts';
import { launched, launchFrom, launchStatus } from './launches.ts';
import { sessionFor } from './links.ts';
import { Nav } from './Nav.tsx';
import { type PRReviewRow, prReviewRows } from './review-rows.ts';
import { findPR, prFromSearch } from './reviews.ts';
import { ago } from './time.ts';

const UNTITLED = 'New session';

const sessionHref = (id: string) => `/?session=${encodeURIComponent(id)}`;

/** How long a check ran: "48s", "2m 10s", "1h 5m". */
function ran(seconds: number | undefined): string | undefined {
  if (seconds == null) return undefined;
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m}m ${seconds % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

interface ReviewProps {
  pr: PullRequest;
  sessions: Session[];
  launches: Launch[];
}

/**
 * One button: a new session, started beside one on the PR's repo (on its branch if one is),
 * runs the person's review instructions, or Claude's review. Once it reports, it opens.
 */
function Review({ pr, sessions, launches }: ReviewProps) {
  const settings = useReviewSettings();
  const from = launchFrom(
    sessions.filter((s) => s.repo === pr.repo),
    pr.branch,
  );
  const [launchId, setLaunchId] = useState<string>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const launch = launches.find((l) => l.id === launchId);
  const started = launched(launch, sessions);

  // The person clicked Review and waited here: take them to the session once it reports.
  useEffect(() => {
    if (started) location.assign(sessionHref(started.id));
  }, [started]);

  async function review() {
    if (!from) return;
    setSending(true);
    setError(undefined);
    const result = await startLaunch({
      from: from.id,
      review: { repo: pr.repo, number: pr.number, url: pr.url },
    });
    setSending(false);
    if ('error' in result) setError(result.error);
    else setLaunchId(result.id);
  }

  if (!from) {
    return (
      <EmptyState
        compact
        title={`No open session on ${pr.repo}`}
        body="A review runs in a new Claude Code session, started from one that's running on the repo. Open one there, and the Review button shows here."
      />
    );
  }

  const own = settings?.instructions?.trim();
  const failed = launch?.status === 'failed';
  // Where it stands shows in the list beside it; only a failure shows here too.
  const note = error ?? (launch && failed ? launchStatus(launch, started) : undefined);
  // A command reads as what runs; a prompt of the person's own is too long to show here.
  const runs = !own || own.startsWith('/') ? reviewPrompt(pr, own) : undefined;
  return (
    <>
      <ReviewAction
        what={
          <>
            {runs ? (
              <>
                Runs <Code>{runs}</Code>
              </>
            ) : (
              'Sends your review prompt'
            )}{' '}
            in a new session beside "{from.title ?? UNTITLED}".{' '}
            <TextLink href="/settings#review">Change</TextLink>
          </>
        }
      >
        <Button
          variant="primary"
          loading={sending || (!!launch && !failed && !started)}
          onClick={() => void review()}
        >
          {failed ? 'Try again' : 'Review'}
        </Button>
      </ReviewAction>
      {note ? <p className="app-review__error">{note}</p> : null}
    </>
  );
}

/**
 * Every review of the PR: the session's state while it runs, a check once Claude said how it went,
 * a cross if it couldn't start.
 */
function ReviewList({ rows }: { rows: PRReviewRow[] }) {
  return rows.map((r) => (
    <ReviewRow
      key={r.key}
      session={r.title}
      href={r.sessionId ? sessionHref(r.sessionId) : undefined}
      state={r.state}
      result={r.result}
      status={r.status}
      time={r.time}
    />
  ));
}

/** /pr?repo=&number=: one of the person's pull requests, and reviewing it in a new session. */
export function PullRequestPage() {
  const [target] = useState(() => prFromSearch(location.search));
  const github = useGitHub();
  const { sessions, connected } = useSessions();
  const launches = useLaunches(target);
  // Review sessions that left the live list are still this PR's reviews.
  const history = useHistory(!!target);
  const now = useNow();
  const reviews = target ? prReviewRows(target, sessions, history ?? [], launches, now) : [];
  const pr =
    github?.state === 'reported' && target
      ? findPR([github.reviewRequested, github.mine], target)
      : undefined;

  // The session already on its branch, if one is.
  const session = pr && sessionFor(pr, sessions);
  let body: React.ReactNode = null;
  if (!target) {
    body = <EmptyState title="No pull request named" body="Open one from the GitHub page." />;
  } else if (github && !pr) {
    body = (
      <EmptyState
        title="Not one of your open pull requests"
        body={`${target.repo}#${target.number} isn't waiting on your review or yours, or it's closed. JOC shows the open pull requests your plugin reads through gh.`}
      />
    );
  } else if (pr) {
    const shown = pr.files?.length ?? 0;
    const more = (pr.changedFiles ?? shown) - shown;
    body = (
      <div className="joc-prgrid">
        <div className="joc-prgrid__main">
          <Card
            title="Checks"
            count={pr.checks?.length}
            aside={pr.ci === 'skipped' ? null : <CIBadge status={pr.ci} detail={pr.ciDetail} />}
          >
            {pr.checks?.length ? (
              pr.checks.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: two checks can share a name
                <CIRow key={i} status={c.status} name={c.name} time={ran(c.seconds)} />
              ))
            ) : pr.ci === 'skipped' ? (
              <CardNote>No checks ran on the last commit.</CardNote>
            ) : (
              <CardNote>Plugins from 0.8.1 list each check. See them on GitHub.</CardNote>
            )}
          </Card>
          <Card
            title="Changed files"
            count={pr.changedFiles}
            aside={<DiffStat additions={pr.additions} deletions={pr.deletions} />}
          >
            {pr.files?.length ? (
              pr.files.map((f) => (
                <ChangedFile
                  key={f.path}
                  path={f.path}
                  status={f.status}
                  additions={f.additions}
                  deletions={f.deletions}
                  href={`${pr.url}/files`}
                />
              ))
            ) : (
              <CardNote>
                No file list yet. Plugins from 0.6.0 send it with the pull request; see the diff on
                GitHub.
              </CardNote>
            )}
            {more > 0 ? (
              <CardNote>
                {more} more {more === 1 ? 'file' : 'files'} on GitHub.
              </CardNote>
            ) : null}
          </Card>
        </div>
        <aside className="joc-prgrid__side">
          <Card label="Review">
            <Review pr={pr} sessions={sessions} launches={launches} />
          </Card>
          {reviews.length ? (
            <Card title="Reviews from JOC" count={reviews.length}>
              <ReviewList rows={reviews} />
            </Card>
          ) : null}
        </aside>
      </div>
    );
  }

  return (
    <div className="joc-app app">
      <Nav page="github" connected={connected} />
      <main className="joc-app__main app-pr">
        <div className="joc-prpage">
          {pr ? (
            <PRHeader
              back={{ label: `GitHub · ${pr.repo.split('/')[1] ?? pr.repo}`, href: '/github' }}
              title={pr.title}
              number={pr.number}
              draft={pr.draft}
              branch={pr.branch}
              base={pr.base}
              byline={`${pr.author} · updated ${ago(pr.updatedAt, now)}`}
              additions={pr.additions}
              deletions={pr.deletions}
              review={pr.review}
              links={
                <>
                  {session ? (
                    <SessionLink
                      title={session.title ?? UNTITLED}
                      state={session.state}
                      href={sessionHref(session.id)}
                    />
                  ) : null}
                  <TextLink href={pr.url}>Open on GitHub</TextLink>
                </>
              }
            />
          ) : (
            <SectionHeader
              size="lg"
              title={target ? `${target.repo}#${target.number}` : 'Pull request'}
            >
              <Button variant="ghost" onClick={() => location.assign('/github')}>
                All pull requests
              </Button>
            </SectionHeader>
          )}
          {body}
        </div>
      </main>
    </div>
  );
}
