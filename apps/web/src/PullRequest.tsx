import {
  type PullRequest,
  type Review,
  type ReviewMethod,
  type ReviewSettings,
  reviewPrompt,
  type Session,
} from '@joc/protocol';
import {
  Button,
  Code,
  EmptyState,
  FileTree,
  PRRow,
  SectionHeader,
  SegmentedControl,
  SessionLink,
  SessionRow,
  TaskRow,
  TextInput,
} from '@joc/ui';
import { useState } from 'react';
import { apiFetch } from './auth.ts';
import { useGitHub, useNow, useReviewSettings, useReviews, useSessions } from './hooks.ts';
import { sessionFor } from './links.ts';
import { Nav } from './Nav.tsx';
import { plain } from './plain.ts';
import { findPR, prFromSearch, reviewSessions, reviewStatus } from './reviews.ts';
import { age, ago } from './time.ts';

const UNTITLED = 'New session';

const sessionHref = (id: string) => `/?session=${encodeURIComponent(id)}`;
const openOnGitHub = (pr: PullRequest) => window.open(pr.url, '_blank', 'noopener,noreferrer');

type Where = 'new' | 'session';

interface FormProps {
  pr: PullRequest;
  sessions: Session[];
  settings: ReviewSettings;
  now: number;
}

/** How to review, and where: Claude's standard review or the person's own, in a session. */
function ReviewForm({ pr, sessions, settings, now }: FormProps) {
  const [method, setMethod] = useState<ReviewMethod>(settings.method);
  const [command, setCommand] = useState(settings.command ?? '');
  const [where, setWhere] = useState<Where>('new');
  const [chosen, setChosen] = useState<string>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  const open = reviewSessions(pr, sessions);
  // The choice holds while its session is open; otherwise the first one on the repo.
  const session = open.find((s) => s.id === chosen) ?? open[0];
  const own = command.trim();
  const ready = !!session && (method === 'standard' || !!own);
  const prompt = reviewPrompt(pr, method, own);

  async function start() {
    if (!session || !ready) return;
    setSending(true);
    setError(undefined);
    try {
      // Remembered as the default, whichever way the review goes.
      void apiFetch('/api/settings/review', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, command: own || undefined }),
      }).catch(() => {});
      const res = await apiFetch('/api/reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repo: pr.repo,
          number: pr.number,
          url: pr.url,
          method,
          command: own || undefined,
          target:
            where === 'new'
              ? { kind: 'new', from: session.id }
              : { kind: 'session', sessionId: session.id },
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        setError(typeof body.error === 'string' ? body.error : "JOC couldn't start the review.");
      }
    } catch {
      setError("JOC couldn't reach the server. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="app-review">
      <div className="app-review__field">
        <span className="joc-field__label">Review with</span>
        <SegmentedControl
          label="Review with"
          value={method}
          onChange={(id) => setMethod(id as ReviewMethod)}
          options={[
            { id: 'standard', label: "Claude's review" },
            { id: 'own', label: 'Your own' },
          ]}
        />
      </div>
      {method === 'own' ? (
        <TextInput
          label="Your skill or command"
          placeholder="/prep-pr"
          value={command}
          mono
          onChange={setCommand}
          hint="{pr} is the PR number and {url} its address. With neither, the address goes after it."
        />
      ) : null}

      <div className="app-review__field">
        <span className="joc-field__label">Run it in</span>
        <SegmentedControl
          label="Run it in"
          value={where}
          onChange={(id) => setWhere(id as Where)}
          options={[
            { id: 'new', label: 'A new session' },
            { id: 'session', label: 'An open session' },
          ]}
        />
      </div>

      {open.length ? (
        <div className="app-review__field">
          <span className="joc-field__label">
            {where === 'new' ? 'Started in the folder of' : 'Session'}
          </span>
          <div className="app-list app-review__sessions" role="listbox" aria-label="Sessions">
            {open.map((s) => (
              <SessionRow
                key={s.id}
                id={s.id}
                state={s.state}
                title={s.title ?? UNTITLED}
                branch={s.branch}
                contextLeft={s.contextLeft}
                activity={s.activity && plain(s.activity)}
                time={age(s.updatedAt, now)}
                selected={s.id === session?.id}
                onSelect={() => setChosen(s.id)}
              />
            ))}
          </div>
        </div>
      ) : (
        <EmptyState
          compact
          title={`No open session on ${pr.repo}`}
          body="A review runs in Claude Code, in a checkout of the repo. Start a session there, and it shows up here."
        />
      )}

      <div className="app-review__send">
        <span className="app-review__prompt">
          <span className="joc-field__label">Sends</span>
          {method === 'own' && !own ? (
            <span className="app-review__empty">Your command, once you type it</span>
          ) : (
            <Code>{prompt}</Code>
          )}
        </span>
        <Button variant="primary" disabled={!ready} loading={sending} onClick={() => void start()}>
          {where === 'new' ? 'Start review' : 'Send review'}
        </Button>
      </div>
      {error ? <p className="app-review__error">{error}</p> : null}
    </div>
  );
}

function ReviewList({
  reviews,
  sessions,
  now,
}: {
  reviews: Review[];
  sessions: Session[];
  now: number;
}) {
  return (
    <div className="app-tasks">
      {reviews.map((review) => {
        const session = sessions.find((s) => s.id === review.sessionId);
        return (
          <TaskRow
            key={review.id}
            kind="subagent"
            kindLabel={review.kind === 'new' ? 'New session' : 'Open session'}
            title={session?.title ?? `Review #${review.number}`}
            command={review.prompt}
            tail={reviewStatus(review, session)}
            elapsed={age(review.createdAt, now)}
            state={session?.state ?? 'idle'}
            result={review.status === 'failed' ? 'fail' : undefined}
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

/** /pr?repo=&number=: one of the person's pull requests, and reviewing it in a session. */
export function PullRequestPage() {
  const [target] = useState(() => prFromSearch(location.search));
  const github = useGitHub();
  const { sessions, connected } = useSessions();
  const settings = useReviewSettings();
  const reviews = useReviews(target);
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
        {settings ? <ReviewForm pr={pr} sessions={sessions} settings={settings} now={now} /> : null}

        {reviews.length ? (
          <>
            <SectionHeader title="Reviews from JOC" count={reviews.length} />
            <ReviewList reviews={reviews} sessions={sessions} now={now} />
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
