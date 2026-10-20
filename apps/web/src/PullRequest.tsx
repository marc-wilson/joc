import { type Launch, type PullRequest, type Session, STANDARD_REVIEW } from '@joc/protocol';
import {
  Button,
  Code,
  EmptyState,
  FileTree,
  PRRow,
  SectionHeader,
  SessionLink,
  TaskRow,
} from '@joc/ui';
import { useEffect, useState } from 'react';
import {
  startLaunch,
  useGitHub,
  useLaunches,
  useNow,
  useReviewSettings,
  useSessions,
} from './hooks.ts';
import { launched, launchFrom, launchStatus } from './launches.ts';
import { sessionFor } from './links.ts';
import { Nav } from './Nav.tsx';
import { findPR, prFromSearch } from './reviews.ts';
import { age, ago } from './time.ts';

const UNTITLED = 'New session';

const sessionHref = (id: string) => `/?session=${encodeURIComponent(id)}`;
const openOnGitHub = (pr: PullRequest) => window.open(pr.url, '_blank', 'noopener,noreferrer');

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

  const own = settings?.instructions;
  const failed = launch?.status === 'failed';
  // Where it stands shows in the list below; only a failure shows here too.
  const note = error ?? (launch && failed ? launchStatus(launch, started) : undefined);
  return (
    <div className="app-review">
      <div className="app-review__send">
        <span className="app-review__prompt">
          {own ? (
            'Runs your review instructions'
          ) : (
            <>
              Runs <Code>{`${STANDARD_REVIEW} ${pr.number}`}</Code>
            </>
          )}{' '}
          in a new session, in the folder of "{from.title ?? UNTITLED}".
          <Button variant="ghost" size="sm" onClick={() => location.assign('/settings')}>
            Change
          </Button>
        </span>
        <Button
          variant="primary"
          loading={sending || (!!launch && !failed && !started)}
          onClick={() => void review()}
        >
          {failed ? 'Try again' : 'Review'}
        </Button>
      </div>
      {note ? <p className="app-review__error">{note}</p> : null}
    </div>
  );
}

function ReviewList({
  launches,
  sessions,
  now,
}: {
  launches: Launch[];
  sessions: Session[];
  now: number;
}) {
  return (
    <div className="app-tasks">
      {launches.map((launch) => {
        const session = launched(launch, sessions);
        return (
          <TaskRow
            key={launch.id}
            kind="subagent"
            kindLabel="New session"
            title={session?.title ?? `Review #${launch.review?.number ?? ''}`}
            command={launch.prompt}
            tail={launchStatus(launch, session)}
            elapsed={age(launch.createdAt, now)}
            state={session?.state ?? 'idle'}
            result={launch.status === 'failed' ? 'fail' : undefined}
          >
            {session ? (
              <SessionLink
                title={session.title ?? UNTITLED}
                state={session.state}
                href={sessionHref(session.id)}
              />
            ) : null}
          </TaskRow>
        );
      })}
    </div>
  );
}

/** /pr?repo=&number=: one of the person's pull requests, and reviewing it in a new session. */
export function PullRequestPage() {
  const [target] = useState(() => prFromSearch(location.search));
  const github = useGitHub();
  const { sessions, connected } = useSessions();
  const launches = useLaunches(target);
  const now = useNow();
  const pr =
    github?.state === 'reported' && target
      ? findPR([github.reviewRequested, github.mine], target)
      : undefined;

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
    const session = sessionFor(pr, sessions);
    const shown = pr.files?.length ?? 0;
    const more = (pr.changedFiles ?? shown) - shown;
    body = (
      <>
        <div className="app-list">
          <PRRow
            number={pr.number}
            repo={pr.repo.split('/')[1]}
            title={pr.title}
            branch={pr.branch}
            author={pr.author}
            updated={ago(pr.updatedAt, now)}
            ci={pr.ci}
            ciDetail={pr.ciDetail}
            review={pr.review}
            draft={pr.draft}
            additions={pr.additions}
            deletions={pr.deletions}
            session={
              session && {
                title: session.title ?? UNTITLED,
                state: session.state,
                href: sessionHref(session.id),
              }
            }
            onOpen={() => openOnGitHub(pr)}
          />
        </div>

        <SectionHeader title="Review" />
        <Review pr={pr} sessions={sessions} launches={launches} />

        {launches.length ? (
          <>
            <SectionHeader title="Reviews from JOC" count={launches.length} />
            <ReviewList launches={launches} sessions={sessions} now={now} />
          </>
        ) : null}

        <SectionHeader title="Changed files" count={pr.changedFiles} />
        {pr.files?.length ? (
          <div className="app-list">
            <FileTree
              items={pr.files.map((f) => ({ name: f.path, type: 'file', status: f.status }))}
            />
          </div>
        ) : (
          <EmptyState
            compact
            title="No file list yet"
            body="Plugins from 0.6.0 send it with the pull request. See the diff on GitHub."
          />
        )}
        {more > 0 ? (
          <p className="app-changes__note">
            {more} more {more === 1 ? 'file' : 'files'} on GitHub.
          </p>
        ) : null}
      </>
    );
  }

  return (
    <div className="joc-app app">
      <Nav page="github" connected={connected} />
      <main className="joc-app__main app-page app-pr">
        <SectionHeader
          size="lg"
          title={pr?.title ?? (target ? `${target.repo}#${target.number}` : 'Pull request')}
          description={
            pr && `${pr.repo}#${pr.number}: ${pr.branch} into ${pr.base ?? 'the default branch'}`
          }
        >
          <Button variant="ghost" onClick={() => location.assign('/github')}>
            All pull requests
          </Button>
          {pr ? (
            <Button variant="secondary" onClick={() => openOnGitHub(pr)}>
              Open on GitHub
            </Button>
          ) : null}
        </SectionHeader>
        {body}
      </main>
    </div>
  );
}
