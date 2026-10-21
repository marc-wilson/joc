// A review session's pull request (issue #88, Claude Design's "PR review session" pass): pinned
// between the session header and the conversation as a card (A) or a one-line bar (B), and in
// full on its own tab (C). Labels are an 8px square in a neutral chip, never a dot; reviews and
// verdicts are stroked marks like CI; the only dot is the session's own, on the step it's on.
import type {
  PullRequest,
  PullRequestPerson,
  PullRequestReview,
  ReviewOutcome,
  SessionState,
} from '@joc/protocol';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { Avatar } from './Avatar.tsx';
import { CIBadge, CIMark } from './ci.tsx';
import { Button, ButtonLink } from './controls.tsx';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';
import { SectionHeader } from './layout.tsx';
import { StateDot } from './state.tsx';

/** Rows of reviewers the card lists before "+N more". */
export const PR_REVIEWERS_SHOWN = 5;

/** One step of Claude's review, as the session's conversation shows it so far. */
export interface PRReviewStep {
  label: ReactNode;
  status: 'done' | 'now' | 'next';
}

/** Times as the dashboard words them, e.g. "2 days ago". */
export interface PRTimes {
  opened?: string;
  updated?: string;
}

// ── Shared pieces ─────────────────────────────────────────────────────────

/** A login without GitHub's `[bot]` suffix. */
const shown = (login: string) => login.replace(/\[bot\]$/i, '');

function Author({ pull, size = 24 }: { pull: PullRequest; size?: number }) {
  const p = pull.authorProfile;
  const login = shown(p?.login ?? pull.author);
  return (
    <span className="joc-pr-meta__item">
      <Avatar name={p?.name ?? login} src={p?.avatarUrl} size={size} />
      {p?.name ? <span className="joc-pr-person__name">{p.name}</span> : null}
      <span className={cx('code-sm', 'joc-pr-person__login', !p?.name && 'is-only')}>{login}</span>
      {p?.bot ? <span className="joc-pr-tag joc-pr-tag--bot">bot</span> : null}
    </span>
  );
}

function Diff({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="joc-pr-diff">
      <span className="joc-pr-diff__add">+{additions.toLocaleString('en-US')}</span>{' '}
      <span className="joc-pr-diff__del">−{deletions.toLocaleString('en-US')}</span>
    </span>
  );
}

const plural = (n: number, one: string) =>
  `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`;

/** Where it stands: draft, ready, merged or closed. */
function StatusTag({ pull }: { pull: PullRequest }) {
  if (pull.state === 'merged') return <span className="joc-pr-tag">Merged</span>;
  if (pull.state === 'closed') return <span className="joc-pr-tag joc-pr-tag--quiet">Closed</span>;
  if (pull.draft) return <span className="joc-pr-tag joc-pr-tag--draft">Draft</span>;
  return <span className="joc-pr-tag">Ready for review</span>;
}

/** The meta line under the title: author, times, status, branches, size. */
function Meta({ pull, times }: { pull: PullRequest; times?: PRTimes }) {
  const when = [
    times?.opened && `opened ${times.opened}`,
    times?.updated && `updated ${times.updated}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="joc-pr-meta">
      <Author pull={pull} />
      {when ? <span className="joc-pr-time">{when}</span> : null}
      <StatusTag pull={pull} />
      <span className="joc-pr-meta__item">
        <span className="joc-pr-branch">{pull.branch}</span>
        {pull.base ? (
          <>
            <span className="joc-pr-arrow">→</span>
            <span className="joc-pr-branch">{pull.base}</span>
          </>
        ) : null}
      </span>
      <Diff additions={pull.additions} deletions={pull.deletions} />
      {pull.changedFiles != null ? <span>{plural(pull.changedFiles, 'file')}</span> : null}
      {pull.commits != null ? <span>{plural(pull.commits, 'commit')}</span> : null}
    </div>
  );
}

const failing = (pull: PullRequest) => pull.checks?.filter((c) => c.status === 'fail').length ?? 0;

/** The checks as a badge: "1 failing 12/14", "Passed 14/14", "Pending 9/14", or no checks. */
function ChecksBadge({ pull }: { pull: PullRequest }) {
  const failed = failing(pull);
  const label =
    pull.ci === 'fail' && failed
      ? `${failed} failing`
      : pull.ci === 'skipped' && !pull.checks?.length
        ? 'No checks'
        : undefined;
  return <CIBadge status={pull.ci} label={label} detail={pull.ciDetail} />;
}

const DECISION: Record<NonNullable<PullRequest['review']>, string> = {
  Approved: 'Approved',
  'Changes requested': 'Changes requested',
  'Review requested': 'Review required',
};

function Decision({ pull }: { pull: PullRequest }) {
  if (!pull.review) return <span className="joc-pr-quiet">No review yet</span>;
  const changes = pull.review === 'Changes requested';
  return (
    <span>
      <span className={cx('joc-pr-tag', changes && 'joc-pr-tag--changes')}>
        {pull.review === 'Approved' ? <Icon name="check" size={12} /> : null}
        {changes ? <Icon name="x" size={12} /> : null}
        {DECISION[pull.review]}
      </span>
    </span>
  );
}

/** Labels: two rows, then "+N more", which opens the rest in place. */
export function PRLabels({ labels }: { labels: NonNullable<PullRequest['labels']> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(0);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box || open) return setHidden(0);
    const limit = box.offsetTop + box.clientHeight;
    const kids = [...box.children].filter((el): el is HTMLElement => el instanceof HTMLElement);
    setHidden(kids.filter((k) => k.offsetTop >= limit).length);
  }, [open]);
  if (!labels.length) return <span className="joc-pr-quiet">None</span>;
  return (
    <div className="joc-labels-row">
      <div ref={ref} className={cx('joc-labels', open && 'is-open')}>
        {labels.map((l) => (
          <span
            key={l.name}
            className="joc-label"
            style={{ '--label-color': `#${l.color}` } as React.CSSProperties}
          >
            <span className="joc-label__swatch" />
            {l.name}
          </span>
        ))}
      </div>
      {hidden ? (
        <button className="joc-labels__more" type="button" onClick={() => setOpen(true)}>
          +{hidden} more
        </button>
      ) : null}
    </div>
  );
}

const VERDICT: Record<PullRequestReview['state'] | 'requested', [string, string, ReactNode]> = {
  approved: ['approved', 'Approved', <Icon key="i" name="check" size={12} />],
  'changes-requested': ['changes', 'Changes requested', <Icon key="i" name="x" size={12} />],
  commented: ['commented', 'Commented', <Icon key="i" name="comment" size={12} />],
  dismissed: ['commented', 'Dismissed', null],
  requested: ['requested', 'Requested', null],
};

interface ReviewerRow {
  key: string;
  team?: boolean;
  person?: PullRequestPerson;
  name: string;
  login: string;
  verdict: PullRequestReview['state'] | 'requested';
}

/** Anyone who reviewed first (their latest review), then people still asked, then teams. */
export function reviewerRows(pull: PullRequest, you?: string): ReviewerRow[] {
  const latest = new Map<string, PullRequestReview>();
  for (const r of pull.reviews ?? []) {
    const before = latest.get(r.by.login);
    // A comment after a decision leaves the decision standing, as on GitHub.
    if (before && r.state === 'commented' && before.state !== 'commented') continue;
    latest.set(r.by.login, r);
  }
  const name = (p: PullRequestPerson) =>
    you && p.login.toLowerCase() === you.toLowerCase() ? 'You' : (p.name ?? shown(p.login));
  const rows: ReviewerRow[] = [...latest.values()].map((r) => ({
    key: `r:${r.by.login}`,
    person: r.by,
    name: name(r.by),
    login: r.by.login,
    verdict: r.state,
  }));
  for (const p of pull.requestedReviewers ?? []) {
    if (latest.has(p.login)) continue;
    rows.push({
      key: `p:${p.login}`,
      person: p,
      name: name(p),
      login: p.login,
      verdict: 'requested',
    });
  }
  const org = pull.repo.split('/')[0];
  for (const t of pull.requestedTeams ?? []) {
    rows.push({
      key: `t:${t.slug}`,
      team: true,
      name: t.name ?? t.slug,
      login: `${org}/${t.slug}`,
      verdict: 'requested',
    });
  }
  return rows;
}

function Reviewer({ row }: { row: ReviewerRow }) {
  const [kind, word, mark] = VERDICT[row.verdict];
  return (
    <div className="joc-reviewer">
      {row.team ? (
        <span className="joc-team-avatar" aria-hidden="true">
          {row.name.charAt(0).toUpperCase()}
        </span>
      ) : (
        <Avatar name={row.name} src={row.person?.avatarUrl} size={20} />
      )}
      <span className="joc-reviewer__who">
        <span className="joc-reviewer__name">{row.name}</span>
        <span className="joc-reviewer__login">{shown(row.login)}</span>
        {row.person?.bot ? <span className="joc-pr-tag joc-pr-tag--bot">bot</span> : null}
      </span>
      <span className={`joc-reviewer__verdict joc-reviewer__verdict--${kind}`}>
        {mark}
        {word}
      </span>
    </div>
  );
}

/** Every reviewer, or the first PR_REVIEWERS_SHOWN then "+N more reviewers". */
export function PRReviewers({
  pull,
  you,
  all,
}: {
  pull: PullRequest;
  you?: string;
  all?: boolean;
}) {
  const rows = reviewerRows(pull, you);
  const [open, setOpen] = useState(false);
  if (!rows.length) return <span className="joc-pr-quiet">Nobody asked yet</span>;
  const cut = all || open ? rows : rows.slice(0, PR_REVIEWERS_SHOWN);
  const rest = rows.slice(cut.length);
  return (
    <>
      {cut.map((r) => (
        <Reviewer key={r.key} row={r} />
      ))}
      {rest.length ? (
        <div className="joc-reviewers-more">
          <div className="joc-avatars">
            {rest.slice(0, 3).map((r) =>
              r.team ? (
                <span key={r.key} className="joc-team-avatar" aria-hidden="true">
                  {r.name.charAt(0).toUpperCase()}
                </span>
              ) : (
                <Avatar key={r.key} name={r.name} src={r.person?.avatarUrl} size={20} />
              ),
            )}
          </div>
          <button className="joc-labels__more" type="button" onClick={() => setOpen(true)}>
            +{rest.length} more {rest.length === 1 ? 'reviewer' : 'reviewers'}
          </button>
        </div>
      ) : null}
    </>
  );
}

function Closes({ pull }: { pull: PullRequest }) {
  return (
    <>
      {(pull.closes ?? []).map((i) => {
        const here = i.repo.toLowerCase() === pull.repo.toLowerCase();
        const name = here ? `#${i.number}` : `${i.repo}#${i.number}`;
        return (
          <span key={`${i.repo}#${i.number}`} className="joc-pr-issue">
            {i.url ? (
              <a href={i.url} target="_blank" rel="noopener noreferrer">
                {name}
              </a>
            ) : (
              <span className="joc-pr-issue__num">{name}</span>
            )}
            {i.title ? <span className="joc-pr-issue__title">{i.title}</span> : null}
          </span>
        );
      })}
    </>
  );
}

/** The card's status column: checks, decision, reviewers, labels, milestone, closed issues. */
function StatusList({ pull, you }: { pull: PullRequest; you?: string }) {
  const notPassing = (pull.checks ?? []).filter(
    (c) => c.status === 'fail' || c.status === 'pending',
  );
  return (
    <dl className="joc-pr-status">
      <dt>Checks</dt>
      <dd>
        <span>
          <ChecksBadge pull={pull} />
        </span>
        {notPassing.slice(0, 3).map((c) => (
          <span key={c.name} className="joc-pr-check">
            <CIMark status={c.status} size={12} />
            <span className="joc-pr-check__name">{c.name}</span>
          </span>
        ))}
      </dd>
      <dt>Review</dt>
      <dd>
        <Decision pull={pull} />
      </dd>
      <dt>Reviewers</dt>
      <dd className="joc-pr-status__people">
        <PRReviewers pull={pull} you={you} />
      </dd>
      <dt>Labels</dt>
      <dd>
        <PRLabels labels={pull.labels ?? []} />
      </dd>
      {pull.milestone ? (
        <>
          <dt>Milestone</dt>
          <dd>{pull.milestone.title}</dd>
        </>
      ) : null}
      {pull.closes?.length ? (
        <>
          <dt>Closes</dt>
          <dd>
            <Closes pull={pull} />
          </dd>
        </>
      ) : null}
    </dl>
  );
}

/** Claude's review so far: done steps get a pass mark, the current one the session's dot. */
export function PRReviewProgress({
  steps,
  state,
  stack,
  only,
}: {
  steps: PRReviewStep[];
  state: SessionState;
  stack?: boolean;
  /** Only the steps of this status (the bar shows the current one), keeping their numbers. */
  only?: PRReviewStep['status'];
}) {
  const now = steps.findIndex((s) => s.status === 'now');
  return (
    <ol
      className={cx('joc-pr-progress', stack && 'joc-pr-progress--stack')}
      aria-label={
        now >= 0 ? `Review progress, step ${now + 1} of ${steps.length}` : 'Review progress'
      }
    >
      {steps.map((s, i) =>
        only && s.status !== only ? null : (
          <li
            // Steps keep their place: a step only ever changes in place.
            // biome-ignore lint/suspicious/noArrayIndexKey: the steps are a fixed sequence
            key={i}
            className={cx(
              'joc-pr-step',
              s.status === 'done' && 'is-done',
              s.status === 'now' && 'is-now',
            )}
          >
            {s.status === 'done' ? (
              <CIMark status="pass" size={12} />
            ) : s.status === 'now' && state === 'working' ? (
              <StateDot state="working" />
            ) : (
              <span className="joc-pr-step__n">{i + 1}</span>
            )}
            {s.label}
          </li>
        ),
      )}
    </ol>
  );
}

/** The description, capped at eight lines with "Show more"; the PR tab shows it whole. */
function Description({ children, open: always }: { children?: ReactNode; open?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // Lines past the cap; undefined until measured, so it's measured capped.
  const [more, setMore] = useState<number>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new description is measured again
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box || always || open) return;
    setMore(Math.max(0, Math.ceil((box.scrollHeight - box.clientHeight) / 22)));
  }, [always, open, children]);
  if (!children) {
    return (
      <div className="joc-pr-desc joc-pr-desc--empty">
        <p>No description provided.</p>
        <p className="meta">Claude reviews from the diff and commit messages.</p>
      </div>
    );
  }
  return (
    <div>
      <div
        ref={ref}
        className={cx(
          'joc-pr-desc',
          (always || open) && 'is-open',
          !always && !open && more === 0 && 'is-short',
        )}
      >
        {children}
      </div>
      {!always && (more || open) ? (
        <button className="joc-pr-more" type="button" onClick={() => setOpen(!open)}>
          {open ? (
            'Show less'
          ) : (
            <>
              Show more{' '}
              <span className="joc-pr-more__count">· {plural(more ?? 0, 'more line')}</span>
            </>
          )}
        </button>
      ) : null}
    </div>
  );
}

// ── A · The card ────────────────────────────────────────────────────────────

export interface PRCardProps {
  pull: PullRequest;
  /** The description, rendered as markdown by the app; undefined when there is none. */
  description?: ReactNode;
  /** The description was cut by JOC (see the PR tab, or GitHub, for the rest). */
  truncated?: boolean;
  times?: PRTimes;
  /** The person's GitHub login, so their own row reads "You". */
  you?: string;
  steps: PRReviewStep[];
  state: SessionState;
  onHide: () => void;
}

export function PRCard({
  pull,
  description,
  truncated,
  times,
  you,
  steps,
  state,
  onHide,
}: PRCardProps) {
  return (
    <div className="joc-pr-card joc-pr-fill">
      <div className="joc-pr-card__head">
        <span className="joc-pr-card__icon">
          <Icon name="pr" size={16} />
        </span>
        <div className="joc-pr-card__headline">
          <h2 className="joc-pr-title">
            <span className="joc-pr-num">#{pull.number}</span> {pull.title}
          </h2>
          <Meta pull={pull} times={times} />
        </div>
        <div className="joc-pr-card__actions">
          <Button size="sm" variant="ghost" onClick={onHide} aria-expanded="true">
            Hide details
          </Button>
          <PRGitHubLink url={pull.url} />
        </div>
      </div>
      <div className="joc-pr-card__body">
        <div>
          <Description>{description}</Description>
          {truncated ? <TruncatedNote url={pull.url} /> : null}
        </div>
        <StatusList pull={pull} you={you} />
      </div>
      <div className="joc-pr-card__foot">
        <span className="overline joc-pr-overline">Review</span>
        <PRReviewProgress steps={steps} state={state} />
      </div>
    </div>
  );
}

function TruncatedNote({ url }: { url: string }) {
  return (
    <p className="meta joc-pr-note">
      Description cut at 20,000 characters.{' '}
      <a className="joc-link" href={url} target="_blank" rel="noopener noreferrer">
        Read it all on GitHub
      </a>
    </p>
  );
}

function PRGitHubLink({ url, label = 'Open on GitHub' }: { url: string; label?: string }) {
  return (
    <ButtonLink href={url} size="sm" icon="pr" external>
      {label}
    </ButtonLink>
  );
}

// ── B · The bar ─────────────────────────────────────────────────────────────

const OUTCOME: Record<ReviewOutcome, [string, ReactNode]> = {
  Approved: ['approved', <Icon key="i" name="check" size={12} />],
  'Changes requested': ['changes', <Icon key="i" name="x" size={12} />],
  Commented: ['commented', <Icon key="i" name="comment" size={12} />],
};

export interface PRBarProps {
  pull: PullRequest;
  /** How Claude's review ended, once it said, and when it was posted. */
  outcome?: ReviewOutcome;
  postedAt?: string;
  /** When it merged or closed, worded, e.g. "2h ago". */
  closedAt?: string;
  steps: PRReviewStep[];
  state: SessionState;
  onShow: () => void;
}

/** One 44px line: what it is, how CI and the review stand. Only "Show details" opens it. */
export function PRBar({ pull, outcome, postedAt, closedAt, steps, state, onShow }: PRBarProps) {
  const failed = failing(pull);
  const now = steps.filter((s) => s.status === 'now');
  const ended = pull.state === 'merged' || pull.state === 'closed';
  return (
    <div className="joc-pr-bar joc-pr-fill">
      <span className="joc-pr-icon">
        <Icon name="pr" size={16} />
      </span>
      <span className="joc-pr-bar__title">
        <span className="joc-pr-num">#{pull.number}</span>
        <span className="joc-pr-bar__text">{pull.title}</span>
      </span>
      <div className="joc-pr-bar__aside">
        {ended ? (
          <>
            <StatusTag pull={pull} />
            <span>
              {pull.state === 'merged' ? (
                <>
                  into <span className="joc-pr-branch">{pull.base ?? 'its base'}</span>
                </>
              ) : (
                'without merging'
              )}
            </span>
            {closedAt ? <span className="joc-pr-time">{closedAt}</span> : null}
          </>
        ) : (
          <>
            <Author pull={pull} size={20} />
            <Diff additions={pull.additions} deletions={pull.deletions} />
            <span className="joc-pr-sep" />
            <span className="joc-pr-meta__item">
              <CIMark status={pull.ci} size={14} />
              {pull.ci === 'fail'
                ? failed
                  ? `${failed} failing`
                  : 'Failing'
                : pull.ci === 'pass'
                  ? 'Checks pass'
                  : pull.ci === 'pending'
                    ? 'Checks running'
                    : 'No checks'}
            </span>
          </>
        )}
        {outcome ? (
          <>
            <span className="joc-pr-sep" />
            <span
              className={`joc-pr-meta__item joc-reviewer__verdict joc-reviewer__verdict--${OUTCOME[outcome][0]}`}
            >
              {OUTCOME[outcome][1]}
              {outcome}
            </span>
            {postedAt ? <span className="joc-pr-time">posted {postedAt}</span> : null}
          </>
        ) : now.length && !ended ? (
          <>
            <span className="joc-pr-sep" />
            <PRReviewProgress steps={steps} state={state} only="now" />
          </>
        ) : null}
        <span className="joc-pr-sep" />
        <Button size="sm" variant="ghost" icon="chevronDown" onClick={onShow} aria-expanded="false">
          Show details
        </Button>
        <PRGitHubLink url={pull.url} />
      </div>
    </div>
  );
}

// ── States ──────────────────────────────────────────────────────────────────

/** While it loads: the number at once, static blocks for the rest. */
export function PRLoading({ number }: { number: number }) {
  return (
    <div className="joc-pr-card" aria-busy="true">
      <div className="joc-pr-card__head">
        <span className="joc-pr-card__icon">
          <Icon name="pr" size={16} />
        </span>
        <div className="joc-pr-card__headline">
          <div className="joc-pr-skel-row">
            <span className="joc-pr-num">#{number}</span>
            <span className="joc-pr-skel joc-pr-skel--title joc-pr-skel--w60" />
          </div>
          <div className="joc-pr-skel-row joc-pr-skel-row--wide">
            <span className="joc-pr-skel joc-pr-skel--w25" />
            <span className="joc-pr-skel joc-pr-skel--w30" />
            <span className="joc-pr-skel joc-pr-skel--w15" />
          </div>
        </div>
        <span className="meta joc-pr-quiet">Loading from GitHub</span>
      </div>
      <div className="joc-pr-card__body">
        <div className="joc-pr-skel-stack">
          {['w90', 'w85', 'w70', 'w40'].map((w) => (
            <span key={w} className={`joc-pr-skel joc-pr-skel--${w}`} />
          ))}
        </div>
        <div className="joc-pr-skel-stack">
          {['w70', 'w90', 'w55'].map((w) => (
            <span key={w} className={`joc-pr-skel joc-pr-skel--${w}`} />
          ))}
        </div>
      </div>
    </div>
  );
}

export interface PRUnavailableProps {
  /** `owner/name#N`. */
  name: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}

/** JOC can't show the pull request: the card keeps its frame and says why. */
export function PRUnavailable({ name, title, children, action }: PRUnavailableProps) {
  return (
    <div className="joc-pr-card joc-pr-fill">
      <div className="joc-pr-gone">
        <span className="joc-pr-icon joc-pr-icon--quiet joc-pr-gone__icon">
          <Icon name="pr" size={16} />
        </span>
        <div className="joc-pr-gone__text">
          <span className="joc-pr-gone__title">
            {title} <span className="code-inline">{name}</span>
          </span>
          {children ? <span>{children}</span> : null}
          {action ? <div className="joc-pr-gone__actions">{action}</div> : null}
        </div>
      </div>
    </div>
  );
}

export interface PRNotPostedProps {
  number: number;
  merged: boolean;
  /** Asks the session to post it as a comment; left out when the session can't be prompted. */
  onPost?: () => void;
  /** Why it can't be posted from here, when `onPost` is left out. */
  why?: string;
}

/** The pull request merged or closed before Claude posted its review. */
export function PRNotPosted({ number, merged, onPost, why }: PRNotPostedProps) {
  return (
    <div className="joc-verdict joc-verdict--wide joc-pr-fill">
      <div className="joc-verdict__head">
        <span className="joc-verdict__mark joc-verdict__mark--comment">
          <Icon name="comment" size={16} />
        </span>
        <h3 className="joc-verdict__title">Review not posted</h3>
      </div>
      <p className="joc-verdict__body">
        #{number} was {merged ? 'merged' : 'closed'} before Claude posted its review.{' '}
        {onPost ? 'Post it as a comment if it still matters.' : why}
      </p>
      {onPost ? (
        <div className="joc-verdict__actions">
          <Button size="sm" variant="secondary" icon="comment" onClick={onPost}>
            Post as comment
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export interface PRVerdictProps {
  outcome: ReviewOutcome;
  /** When it was posted, worded, e.g. "10:58". */
  postedAt?: string;
  /** What Claude said of it, in a sentence or two. */
  summary?: string;
  /** The review on GitHub, when GitHub said. */
  reviewUrl?: string;
  prUrl: string;
  /** More actions after the links. */
  children?: ReactNode;
}

const VERDICT_MARK: Record<ReviewOutcome, [string, ReactNode]> = {
  Approved: ['approve', <Icon key="i" name="check" size={16} />],
  'Changes requested': ['changes', <Icon key="i" name="x" size={16} />],
  Commented: ['comment', <Icon key="i" name="comment" size={16} />],
};

/** How Claude's review ended, posted into the thread. Only "Changes requested" colours it. */
export function PRVerdict({
  outcome,
  postedAt,
  summary,
  reviewUrl,
  prUrl,
  children,
}: PRVerdictProps) {
  const [kind, mark] = VERDICT_MARK[outcome];
  return (
    <article
      className={cx(
        'joc-verdict joc-pr-fill',
        outcome === 'Changes requested' && 'joc-verdict--changes',
      )}
      aria-label="Review verdict"
    >
      <div className="joc-verdict__head">
        <span className={`joc-verdict__mark joc-verdict__mark--${kind}`}>{mark}</span>
        <h3 className="joc-verdict__title">{outcome}</h3>
        {postedAt ? (
          <span className="joc-pr-time joc-verdict__time">Posted to GitHub {postedAt}</span>
        ) : null}
      </div>
      {summary ? <p className="joc-verdict__body">{summary}</p> : null}
      {reviewUrl ? (
        <a className="joc-verdict__link" href={reviewUrl} target="_blank" rel="noopener noreferrer">
          {reviewUrl.replace(/^https:\/\//, '')}
        </a>
      ) : null}
      <div className="joc-verdict__actions">
        {reviewUrl ? (
          <ButtonLink href={reviewUrl} size="sm" icon="comment" external>
            View review on GitHub
          </ButtonLink>
        ) : null}
        <ButtonLink
          href={prUrl}
          size="sm"
          icon="pr"
          variant={reviewUrl ? 'ghost' : 'secondary'}
          external
        >
          Open PR on GitHub
        </ButtonLink>
        {children}
      </div>
    </article>
  );
}

/** The region between the session header and the conversation, at the conversation's width. */
export function PRRegion({ number, children }: { number: number; children: ReactNode }) {
  return (
    <section className="joc-pr-region" aria-label={`Pull request #${number}`}>
      <div>{children}</div>
    </section>
  );
}

// ── C · The tab ─────────────────────────────────────────────────────────────

const ran = (seconds: number | undefined) => {
  if (seconds == null) return undefined;
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m}m ${seconds % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

export interface PRPageProps {
  pull: PullRequest;
  description?: ReactNode;
  truncated?: boolean;
  times?: PRTimes;
  you?: string;
  steps: PRReviewStep[];
  state: SessionState;
  /** When the milestone is due, worded. */
  due?: string;
  /** Opens the session's own Changes tab. */
  onOpenChanges?: () => void;
}

/** Everything about the pull request: description, every check, reviewer and file. */
export function PRPage({
  pull,
  description,
  truncated,
  times,
  you,
  steps,
  state,
  due,
  onOpenChanges,
}: PRPageProps) {
  const checks = pull.checks ?? [];
  const order = { fail: 0, pending: 1, pass: 2, skipped: 3 } as const;
  const sorted = [...checks].sort((a, b) => order[a.status] - order[b.status]);
  // Failing and running checks are listed; the ones that passed fold into one row until opened.
  const unfinished = sorted.filter((c) => c.status === 'fail' || c.status === 'pending');
  const passed = sorted.filter((c) => c.status === 'pass' || c.status === 'skipped');
  const [passedOpen, setPassedOpen] = useState(false);
  const files = pull.files ?? [];
  const moreFiles = (pull.changedFiles ?? files.length) - files.length;
  return (
    <div className="joc-pr-scroll">
      <div className="joc-pr-page joc-pr-fill">
        <div className="joc-pr-page__head">
          <span className="joc-pr-icon joc-pr-page__icon">
            <Icon name="pr" size={16} />
          </span>
          <div className="joc-pr-page__headline">
            <h2 className="joc-pr-page__title">
              <span className="joc-pr-num">#{pull.number}</span> {pull.title}
            </h2>
            <Meta pull={pull} times={times} />
          </div>
          <PRGitHubLink url={pull.url} />
        </div>
        <div className="joc-pr-page__cols">
          <div className="joc-pr-page__main">
            <section className="joc-pr-section">
              <SectionHeader title="Description" />
              <Description open>{description}</Description>
              {truncated ? <TruncatedNote url={pull.url} /> : null}
            </section>
            <section className="joc-pr-section">
              <SectionHeader title="Commits" count={pull.commits} />
              <div className="joc-pr-list">
                <div className="joc-pr-list__row">
                  <span className="joc-pr-list__grow joc-pr-soft">
                    {pull.commits != null ? plural(pull.commits, 'commit') : 'Commits'} on{' '}
                    <span className="joc-pr-branch">{pull.branch}</span>
                  </span>
                  {pull.headSha ? (
                    <span className="joc-pr-list__mono">{pull.headSha.slice(0, 7)}</span>
                  ) : null}
                  <a
                    className="joc-link"
                    href={`${pull.url}/commits`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View on GitHub
                  </a>
                </div>
              </div>
            </section>
            <section className="joc-pr-section">
              <SectionHeader title="Files changed" count={pull.changedFiles ?? files.length}>
                {onOpenChanges ? (
                  <Button size="sm" variant="ghost" onClick={onOpenChanges}>
                    Open in Changes
                  </Button>
                ) : null}
              </SectionHeader>
              {files.length ? (
                <div className="joc-pr-list">
                  {files.map((f) => (
                    <div key={f.path} className="joc-pr-list__row">
                      <span
                        className="joc-pr-list__mono joc-pr-list__grow joc-pr-strong"
                        title={f.path}
                      >
                        {f.path}
                      </span>
                      <Diff additions={f.additions} deletions={f.deletions} />
                    </div>
                  ))}
                  {moreFiles > 0 ? (
                    <div className="joc-pr-list__row">
                      <span className="joc-pr-list__mono joc-pr-list__grow joc-pr-quiet">
                        {plural(moreFiles, 'more file')}
                      </span>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="meta joc-pr-empty">GitHub hasn't listed its files yet.</p>
              )}
            </section>
          </div>
          <aside className="joc-pr-page__side" aria-label="Pull request status">
            <section className="joc-pr-section">
              <SectionHeader title="This review" />
              <PRReviewProgress steps={steps} state={state} stack />
            </section>
            <section className="joc-pr-section">
              <SectionHeader title="Checks" count={checks.length} />
              {sorted.length ? (
                <div className="joc-pr-list">
                  {(passedOpen ? sorted : unfinished).map((c) => (
                    <div key={c.name} className="joc-pr-list__row">
                      <CIMark status={c.status} />
                      <span className="joc-pr-list__mono joc-pr-list__grow joc-pr-strong">
                        {c.name}
                      </span>
                      <span className="meta joc-pr-quiet">
                        {c.status === 'pending' ? 'running' : (ran(c.seconds) ?? '')}
                      </span>
                    </div>
                  ))}
                  {passed.length && !passedOpen ? (
                    <button
                      type="button"
                      className="joc-pr-list__row joc-pr-list__toggle"
                      onClick={() => setPassedOpen(true)}
                      aria-expanded="false"
                    >
                      <CIMark status="pass" />
                      <span className="joc-pr-list__grow joc-pr-soft">{passed.length} passed</span>
                      <Icon name="chevronRight" size={12} />
                    </button>
                  ) : null}
                </div>
              ) : (
                <p className="meta joc-pr-empty">No checks on its last commit.</p>
              )}
            </section>
            <section className="joc-pr-section">
              <SectionHeader title="Reviewers" />
              <dl className="joc-pr-status">
                <dt>Decision</dt>
                <dd>
                  <Decision pull={pull} />
                </dd>
              </dl>
              <div>
                <PRReviewers pull={pull} you={you} all />
              </div>
            </section>
            <section className="joc-pr-section">
              <SectionHeader title="Details" />
              <dl className="joc-pr-status">
                <dt>Labels</dt>
                <dd>
                  <PRLabels labels={pull.labels ?? []} />
                </dd>
                <dt>Milestone</dt>
                <dd>
                  {pull.milestone ? (
                    `${pull.milestone.title}${due ? ` · due ${due}` : ''}`
                  ) : (
                    <span className="joc-pr-quiet">None</span>
                  )}
                </dd>
                <dt>Closes</dt>
                <dd>
                  {pull.closes?.length ? (
                    <Closes pull={pull} />
                  ) : (
                    <span className="joc-pr-quiet">None</span>
                  )}
                </dd>
                {pull.mergeable === false ? (
                  <>
                    <dt>Merging</dt>
                    <dd>Conflicts with {pull.base ?? 'its base'}</dd>
                  </>
                ) : null}
              </dl>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
