import type { PullRequest, Session } from '@joc/protocol';
import { EmptyState, PRRow, SectionHeader, SetupCheck } from '@joc/ui';
import { useGitHub, useNow, useSessions } from './hooks.ts';
import { sessionFor } from './links.ts';
import { Nav } from './Nav.tsx';
import { ago } from './time.ts';

function PullRequests({
  prs,
  sessions,
  now,
}: {
  prs: PullRequest[];
  sessions: Session[];
  now: number;
}) {
  return (
    <div className="app-list">
      {prs.map((pr) => {
        const session = sessionFor(pr, sessions);
        return (
          <PRRow
            key={pr.url}
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
                title: session.title ?? 'New session',
                state: session.state,
                href: `/?session=${encodeURIComponent(session.id)}`,
              }
            }
            onOpen={() => window.open(pr.url, '_blank', 'noopener,noreferrer')}
          />
        );
      })}
    </div>
  );
}

/** /github: the person's open pull requests, as their plugin reads them through `gh`. */
export function GitHubPage() {
  const github = useGitHub();
  const { sessions, connected } = useSessions();
  const now = useNow();

  let body: React.ReactNode = null;
  if (github?.state === 'none') {
    body = (
      <EmptyState
        title="No GitHub data yet"
        body="Your plugin reads your pull requests through the GitHub CLI about once a minute. Link a machine with /joc-login, and they show up here."
      />
    );
  } else if (github?.state === 'reported' && github.status === 'not-installed') {
    body = (
      <SetupCheck
        status="missing"
        title="GitHub CLI not installed"
        detail="JOC reads your pull requests through gh on your machine."
        command="brew install gh && gh auth login"
      />
    );
  } else if (github?.state === 'reported' && github.status === 'signed-out') {
    body = (
      <SetupCheck
        status="missing"
        title="GitHub CLI not signed in"
        detail="Sign gh in on your machine; JOC picks it up within a minute."
        command="gh auth login"
      />
    );
  } else if (github?.state === 'reported' && github.status === 'error') {
    body = (
      <EmptyState
        title="GitHub didn't answer"
        body="The last read through gh failed. Your plugin tries again every minute."
      />
    );
  } else if (github?.state === 'reported') {
    body = (
      <>
        <SectionHeader title="Waiting on your review" count={github.reviewRequested.length} />
        {github.reviewRequested.length ? (
          <PullRequests prs={github.reviewRequested} sessions={sessions} now={now} />
        ) : (
          <EmptyState compact title="Nothing waiting on you" />
        )}
        <SectionHeader title="Your pull requests" count={github.mine.length} />
        {github.mine.length ? (
          <PullRequests prs={github.mine} sessions={sessions} now={now} />
        ) : (
          <EmptyState compact title="No open pull requests" />
        )}
      </>
    );
  }

  return (
    <div className="joc-app app">
      <Nav page="github" connected={connected} />
      <main className="joc-app__main app-page">
        <SectionHeader
          size="lg"
          title="GitHub"
          description={
            github?.state === 'reported'
              ? `Open pull requests from your GitHub sign-in on your machine, as of ${ago(github.updatedAt, now)}. Each links to the session on its branch.`
              : 'Open pull requests from your GitHub sign-in on your machine.'
          }
        />
        {body}
      </main>
    </div>
  );
}
