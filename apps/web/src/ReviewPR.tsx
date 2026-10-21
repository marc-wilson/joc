// A review session's pull request (#88): pinned above the conversation as a card or a bar, in
// full on the session's "PR #N" tab, and Claude's verdict in the thread once it posted.
import {
  type ConversationItem,
  type PullRequest,
  ReviewedPullRequest,
  type Session,
} from '@joc/protocol';
import {
  Button,
  ButtonLink,
  Code,
  PRBar,
  PRCard,
  PRLoading,
  PRNotPosted,
  PRPage,
  PRRegion,
  type PRReviewStep,
  PRUnavailable,
  PRVerdict,
} from '@joc/ui';
import { useEffect, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { apiFetch, useAuth } from './auth.ts';
import { useGitHub, useNow } from './hooks.ts';
import { notPosted, reviewSteps, verdictSummary, yourReview } from './review-pr.ts';
import { subscribe } from './stream.ts';
import { ago, clock } from './time.ts';

export type SessionReviewState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: ReviewedPullRequest };

/** The pull request a review session reviews, read again whenever GitHub data changes. */
export function useSessionReview(session: Session | undefined): SessionReviewState | undefined {
  const id = session?.review ? session.id : undefined;
  const outcome = session?.review?.outcome;
  const [state, setState] = useState<SessionReviewState>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a verdict is read again with GitHub's copy
  useEffect(() => {
    setState(id ? { status: 'loading' } : undefined);
    if (!id) return;
    let live = true;
    const load = () =>
      apiFetch(`/api/sessions/${encodeURIComponent(id)}/review`)
        .then(async (r) => {
          if (!live) return;
          const parsed = r.ok ? ReviewedPullRequest.safeParse(await r.json()) : undefined;
          // A failed read keeps what's shown: the next update reads it again.
          setState((s) =>
            parsed?.success
              ? { status: 'ready', data: parsed.data }
              : s?.status === 'ready'
                ? s
                : { status: 'error' },
          );
        })
        // Unreachable for now: what's shown stays, and the next github event or snapshot reads it again.
        .catch(() => {});
    const unsubscribe = subscribe((event) => {
      if (event.type === 'github' || event.type === 'snapshot') void load();
    });
    void load();
    return () => {
      live = false;
      unsubscribe();
    };
  }, [id, outcome]);
  return state;
}

// A description is GitHub's markdown, written by anyone: rendered as markdown only (raw HTML in
// it shows as text), links open outside the dashboard, and images become links, so a description
// can't make the dashboard load anything.
const description: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  img: ({ src, alt }) =>
    typeof src === 'string' && /^https?:\/\//.test(src) ? (
      <a href={src} target="_blank" rel="noopener noreferrer">
        {alt || 'Image'}
      </a>
    ) : (
      <span>{alt}</span>
    ),
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h3>{children}</h3>,
};

function Description({ body }: { body: string }) {
  return (
    <div className="joc-md">
      <Markdown remarkPlugins={[remarkGfm]} components={description} skipHtml>
        {body}
      </Markdown>
    </div>
  );
}

const toSteps = (steps: ReturnType<typeof reviewSteps>): PRReviewStep[] =>
  steps.map((s) => ({
    status: s.status,
    label: s.code ? (
      <>
        {s.text} <code>{s.code}</code>
      </>
    ) : (
      s.text
    ),
  }));

/** Which pull requests you hid or opened, per session, for as long as the page is open. */
const shown = new Map<string, boolean>();

function useShown(session: Session, pull: PullRequest | undefined) {
  // Opens on a review still running; a finished one, or one whose PR closed, starts as the bar.
  // Decided once, when the pull request first shows: after that only the person opens or closes
  // it, so it never collapses on its own.
  if (pull && !shown.has(session.id)) {
    shown.set(
      session.id,
      !session.review?.outcome && pull.state !== 'merged' && pull.state !== 'closed',
    );
  }
  const [, render] = useState(0);
  const set = (next: boolean) => {
    shown.set(session.id, next);
    render((n) => n + 1);
  };
  return [shown.get(session.id) ?? true, set] as const;
}

/** Why there's no pull request to show, and what to do about it. */
function Unavailable({ review, connected }: { review: Session['review']; connected: boolean }) {
  const auth = useAuth();
  if (!review) return null;
  const name = `${review.repo}#${review.number}`;
  const url = review.url ?? `https://github.com/${review.repo}/pull/${review.number}`;
  const org = review.repo.split('/')[0];
  // Without the App (local dev, self-hosting), the plugin reads GitHub through `gh`.
  const app = auth.status === 'signedIn' && !!auth.github && auth.github !== 'off';
  if (!connected && !app) {
    return (
      <PRUnavailable name={name} title="Can't show">
        JOC reads pull requests through <Code>gh</Code> on your machine, and it isn't signed in
        there. Run <Code>gh auth login</Code>; Claude's review in the session isn't affected.
      </PRUnavailable>
    );
  }
  if (!connected) {
    return (
      <PRUnavailable
        name={name}
        title="Can't show"
        action={
          <ButtonLink href="/settings#github" size="sm" variant="primary">
            Connect GitHub
          </ButtonLink>
        }
      >
        GitHub isn't connected for <Code>{org}</Code>, so JOC can't read this pull request's
        details. Claude's review in the session isn't affected.
      </PRUnavailable>
    );
  }
  return (
    <PRUnavailable
      name={name}
      title="Can't show"
      action={
        <ButtonLink href={url} size="sm" icon="pr" external>
          Open on GitHub
        </ButtonLink>
      }
    >
      JOC hasn't read this pull request from GitHub. It shows here once it's one of yours, or you're
      asked to review it.
    </PRUnavailable>
  );
}

/** Whether JOC reads GitHub for the person at all: through the App, or their plugin's `gh`. */
function useConnected(): boolean {
  const auth = useAuth();
  const github = useGitHub();
  const app = auth.status === 'signedIn' ? auth.github : undefined;
  if (app === 'install' || app === 'reconnect') return false;
  if (app === 'covered') return true;
  return github?.state === 'reported' && github.status === 'ok';
}

const dueDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });

interface PanelProps {
  session: Session;
  items: ConversationItem[];
  review: SessionReviewState | undefined;
  /** Sends the session a prompt; undefined when it can't take one. */
  onSend?: (text: string) => void;
}

/** The pull request pinned between the session header and the conversation. */
export function ReviewPanel({ session, items, review, onSend }: PanelProps) {
  const now = useNow();
  const auth = useAuth();
  const connected = useConnected();
  const pull = review?.status === 'ready' ? review.data.pull : undefined;
  const [open, setOpen] = useShown(session, pull);
  if (!session.review) return null;
  const number = session.review.number;
  const you = auth.status === 'signedIn' ? auth.user?.login : undefined;
  const steps = toSteps(reviewSteps(session, pull, items));
  let body: React.ReactNode;
  if (!review || review.status === 'loading') body = <PRLoading number={number} />;
  else if (!pull) body = <Unavailable review={session.review} connected={connected} />;
  else if (open) {
    body = (
      <PRCard
        pull={pull}
        description={pull.body ? <Description body={pull.body} /> : undefined}
        truncated={pull.bodyTruncated}
        times={{
          opened: pull.createdAt ? ago(pull.createdAt, now) : undefined,
          updated: ago(pull.updatedAt, now),
        }}
        you={you}
        steps={steps}
        state={session.state}
        onHide={() => setOpen(false)}
      />
    );
  } else {
    const mine = yourReview(pull, you);
    body = (
      <PRBar
        pull={pull}
        outcome={session.review.outcome}
        postedAt={mine?.submittedAt ? clock(mine.submittedAt, now) : undefined}
        closedAt={
          pull.state === 'merged' || pull.state === 'closed' ? ago(pull.updatedAt, now) : undefined
        }
        steps={steps}
        state={session.state}
        onShow={() => setOpen(true)}
      />
    );
  }
  const unposted = notPosted(session, pull);
  return (
    <PRRegion number={number}>
      {body}
      {unposted && pull ? (
        <PRNotPosted
          number={number}
          merged={pull.state === 'merged'}
          onPost={
            onSend && session.state !== 'offline'
              ? () =>
                  onSend(
                    `#${number} was ${pull.state} before you posted your review. Post what you found as a regular comment on ${pull.url} instead.`,
                  )
              : undefined
          }
          why="The session is offline, so it can't post it from here."
        />
      ) : null}
    </PRRegion>
  );
}

/** Claude's verdict in the thread, once the review ended and said how. */
export function ReviewVerdict({ session, items, review, onSend }: PanelProps) {
  const auth = useAuth();
  const now = useNow();
  const outcome = session.review?.outcome;
  if (!outcome || !session.review) return null;
  const pull = review?.status === 'ready' ? review.data.pull : undefined;
  const you = auth.status === 'signedIn' ? auth.user?.login : undefined;
  const mine = yourReview(pull, you);
  const prUrl =
    pull?.url ??
    session.review.url ??
    `https://github.com/${session.review.repo}/pull/${session.review.number}`;
  return (
    <div className="joc-verdict-row">
      <PRVerdict
        outcome={outcome}
        postedAt={mine?.submittedAt ? clock(mine.submittedAt, now) : undefined}
        summary={verdictSummary(items)}
        reviewUrl={mine?.url}
        prUrl={prUrl}
      >
        {onSend && session.state !== 'offline' && pull?.state === 'open' ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              onSend(
                `Review #${session.review?.number} again: look at what changed since your last review.`,
              )
            }
          >
            Review again
          </Button>
        ) : null}
      </PRVerdict>
    </div>
  );
}

interface TabProps extends PanelProps {
  onOpenChanges: () => void;
}

/** The session's "PR #N" tab: everything about the pull request. */
export function ReviewTab({ session, items, review, onOpenChanges }: TabProps) {
  const now = useNow();
  const auth = useAuth();
  const connected = useConnected();
  if (!session.review) return null;
  const pull = review?.status === 'ready' ? review.data.pull : undefined;
  if (!pull) {
    return (
      <div className="joc-pr-scroll">
        <div className="joc-pr-page">
          {!review || review.status === 'loading' ? (
            <PRLoading number={session.review.number} />
          ) : (
            <Unavailable review={session.review} connected={connected} />
          )}
        </div>
      </div>
    );
  }
  return (
    <PRPage
      pull={pull}
      description={pull.body ? <Description body={pull.body} /> : undefined}
      truncated={pull.bodyTruncated}
      times={{
        opened: pull.createdAt ? ago(pull.createdAt, now) : undefined,
        updated: ago(pull.updatedAt, now),
      }}
      you={auth.status === 'signedIn' ? auth.user?.login : undefined}
      steps={toSteps(reviewSteps(session, pull, items))}
      state={session.state}
      due={pull.milestone?.dueOn ? dueDate(pull.milestone.dueOn) : undefined}
      onOpenChanges={onOpenChanges}
    />
  );
}
