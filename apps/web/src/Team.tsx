import {
  arrangeTeam,
  type ConversationItem,
  isLive,
  type PullRequest,
  type Teammate,
} from '@joc/protocol';
import {
  Attachment,
  Button,
  CIBadge,
  EmptyState,
  TeamGroup,
  TeamMessage,
  TeamMessages,
  TeammateBrief,
  TeammateDetail,
  TeammateLink,
  TeammateLinks,
  TeammatePath,
  TeammatePending,
  TeammateReport,
  TeammateRow,
  TeammateShots,
  TeammateSteps,
  TeamSection,
  TeamView,
} from '@joc/ui';
import { useEffect, useRef, useState } from 'react';
import { MarkdownText } from './Conversation.tsx';
import { useConversation, useNow } from './hooks.ts';
import {
  longElapsed,
  mateName,
  reportImages,
  reportParts,
  shortElapsed,
  teammateBrief,
  teammateLine,
  teammateMessages,
  teammatePr,
  teammateReport,
  teammateSteps,
  timeOfDay,
} from './team.ts';

interface Props {
  sessionId: string;
  repo: string;
  team: Teammate[];
  /** The session's own conversation: the teammates' briefs, messages and reports. */
  items: ConversationItem[];
  prs: PullRequest[];
  /** The teammate to show, when one was picked elsewhere (the session list). */
  selected?: string;
  onSelect: (id: string) => void;
  /** Puts words for the session in its composer, e.g. a message for a teammate. */
  onDraft: (text: string) => void;
}

const copy = (text: string) => navigator.clipboard?.writeText(text).catch(() => {});

/** Where each teammate shows: its group and place. */
type Place = { id: string; group: 'active' | 'finished' };

/**
 * The Team tab: the session's teammates, active then finished (the newest start first in each),
 * and the selected one beside them. While the pointer or focus is in the list it holds its
 * order; once left alone, rows take their new places and fade in there.
 */
export function TeamTab({ sessionId, repo, team, items, prs, selected, onSelect, onDraft }: Props) {
  const now = useNow(1000);
  const [held, setHeld] = useState(false);
  const { active, finished } = arrangeTeam(team);
  const target: Place[] = [
    ...active.map((t) => ({ id: t.id, group: 'active' as const })),
    ...finished.map((t) => ({ id: t.id, group: 'finished' as const })),
  ];
  const byId = new Map(team.map((t) => [t.id, t]));
  const shownRef = useRef<Place[] | undefined>(undefined);
  const last = shownRef.current;
  const shown = held && last ? last.filter((p) => byId.has(p.id)) : target;
  // A row that changed group, or just joined, takes a new key so it fades in where it lands.
  // Within a group the order (by start) never changes.
  const moves = useRef(new Map<string, number>());
  if (last && !held) {
    const was = new Map(last.map((p) => [p.id, p.group]));
    for (const p of shown) {
      if (was.get(p.id) !== p.group) moves.current.set(p.id, (moves.current.get(p.id) ?? 0) + 1);
    }
  }
  useEffect(() => {
    shownRef.current = shown;
  });

  const current = (selected && byId.get(selected)) || byId.get(shown[0]?.id ?? '');
  if (!team.length) {
    return (
      <div className="app-main__scroll">
        <EmptyState
          title="No teammates yet"
          body="When Claude hands work to a teammate, it shows here with its branch, steps and report."
          icon="team"
          compact
        />
      </div>
    );
  }

  const group = (name: 'active' | 'finished') => shown.filter((p) => p.group === name);
  const row = (p: Place) => {
    const t = byId.get(p.id);
    if (!t) return null;
    const count = moves.current.get(p.id) ?? 0;
    return (
      <MateRow
        key={`${p.id}:${count}`}
        sessionId={sessionId}
        mate={t}
        pr={teammatePr(t, prs, repo)}
        now={now}
        selected={t.id === current?.id}
        moved={count > 0}
        onSelect={() => onSelect(t.id)}
      />
    );
  };
  const activeShown = group('active');
  const finishedShown = group('finished');

  return (
    <TeamView
      onHoldChange={setHeld}
      list={
        <>
          {activeShown.length ? <TeamGroup title="Active" count={activeShown.length} /> : null}
          {activeShown.map(row)}
          {finishedShown.length ? (
            <TeamGroup title="Finished" count={finishedShown.length} />
          ) : null}
          {finishedShown.map(row)}
        </>
      }
      detail={
        current ? (
          <MateDetail
            key={current.id}
            sessionId={sessionId}
            mate={current}
            items={items}
            pr={teammatePr(current, prs, repo)}
            repo={repo}
            now={now}
            onDraft={onDraft}
          />
        ) : null
      }
    />
  );
}

/** One row of the list; a working teammate's line says its latest step. */
function MateRow({
  sessionId,
  mate,
  pr,
  now,
  selected,
  moved,
  onSelect,
}: {
  sessionId: string;
  mate: Teammate;
  pr?: PullRequest;
  now: number;
  selected: boolean;
  moved: boolean;
  onSelect: () => void;
}) {
  const steps = useConversation(mate.status === 'working' ? sessionId : undefined, mate.id);
  const elapsed = mate.startedAt
    ? shortElapsed(mate.startedAt, mate.endedAt ?? (isLive(mate) ? now : mate.startedAt))
    : undefined;
  return (
    <TeammateRow
      status={mate.status}
      title={mate.title}
      issue={mate.issue}
      step={teammateLine(mate, steps)}
      pr={pr && mate.status === 'done' ? { number: pr.number, ci: ciOf(pr) } : undefined}
      elapsed={mate.endedAt || isLive(mate) ? elapsed : undefined}
      selected={selected}
      moved={moved}
      onSelect={onSelect}
    />
  );
}

const ciOf = (pr: PullRequest) =>
  pr.ci === 'pass' || pr.ci === 'fail' || pr.ci === 'pending' ? pr.ci : undefined;

/** The selected teammate: a finished one leads with its report, a live one with its brief. */
function MateDetail({
  sessionId,
  mate,
  items,
  pr,
  repo,
  now,
  onDraft,
}: {
  sessionId: string;
  mate: Teammate;
  items: ConversationItem[];
  pr?: PullRequest;
  repo: string;
  now: number;
  onDraft: (text: string) => void;
}) {
  const live = isLive(mate);
  const stepItems = useConversation(sessionId, mate.id);
  const steps = teammateSteps(stepItems, mate.startedAt, mate.status === 'working');
  const messages = teammateMessages(items, mate);
  const report = teammateReport(items, mate);
  const brief = teammateBrief(items, mate) ?? mate.title;
  const shots = reportImages(report?.text);
  const name = mateName(mate);
  const address = `${mate.title}${mate.agentId ? ` (agent ${mate.agentId})` : ''}`;

  const elapsed = mate.startedAt
    ? longElapsed(mate.startedAt, mate.endedAt ?? (live ? now : mate.startedAt))
    : undefined;
  const actions = (
    <>
      <Button
        variant="secondary"
        size="sm"
        icon="comment"
        onClick={() => onDraft(`Send a message to the teammate ${address}: `)}
      >
        Message
      </Button>
      {live ? (
        <Button
          variant="ghost"
          size="sm"
          icon="stop"
          onClick={() => onDraft(`Stop the teammate ${address}.`)}
        >
          Stop
        </Button>
      ) : pr ? (
        <Button
          variant="primary"
          size="sm"
          onClick={() => window.open(pr.url, '_blank', 'noopener,noreferrer')}
        >
          Open PR #{pr.number}
        </Button>
      ) : null}
    </>
  );
  const meta = live ? (
    <>
      {mate.branch ? <TeammatePath icon="branch">{mate.branch}</TeammatePath> : null}
      {mate.worktree ? <TeammatePath icon="folder">{mate.worktree}</TeammatePath> : null}
      {mate.startedAt ? <span>Started {timeOfDay(mate.startedAt)}</span> : null}
      <span>{pr ? `PR #${pr.number}` : 'No PR yet'}</span>
    </>
  ) : (
    <>
      {mate.endedAt ? (
        <span>
          {mate.status === 'done' ? 'Finished' : mate.status === 'failed' ? 'Failed' : 'Stopped'}{' '}
          {timeOfDay(mate.endedAt)}
        </span>
      ) : mate.tail ? (
        <span>{mate.tail}</span>
      ) : null}
      {steps.total ? <span>{plural(steps.total, 'step')}</span> : null}
      {messages.length ? <span>{plural(messages.length, 'message')}</span> : null}
    </>
  );

  const briefSection = (
    <TeamSection key="brief" title="Brief">
      <TeammateBrief text={brief} />
    </TeamSection>
  );
  const stepsSection = steps.total ? (
    <TeamSection key="steps" title="Steps" count={steps.total}>
      <TeammateSteps steps={steps.steps} earlier={steps.earlier} />
    </TeamSection>
  ) : null;
  const messagesSection = messages.length ? (
    <TeamSection key="messages" title="Messages" count={messages.length}>
      <TeamMessages>
        {messages.map((m) => (
          <TeamMessage
            key={m.id}
            from={m.from}
            who={m.from === 'lead' ? 'Lead' : name}
            to={m.from === 'lead' ? `to ${name}` : 'to lead'}
            time={timeOfDay(m.at)}
          >
            <MarkdownText>{m.text}</MarkdownText>
          </TeamMessage>
        ))}
      </TeamMessages>
    </TeamSection>
  ) : null;

  if (live) {
    return (
      <TeammateDetail
        status={mate.status}
        title={mate.title}
        issue={mate.issue}
        elapsed={elapsed}
        actions={actions}
        meta={meta}
      >
        {briefSection}
        {stepsSection}
        {messagesSection}
        <TeamSection title="Report">
          <TeammatePending>The report appears here when this teammate finishes.</TeammatePending>
        </TeamSection>
      </TeammateDetail>
    );
  }

  const parts = report ? reportParts(report.text) : undefined;
  const status = mate.status === 'failed' ? 'failed' : mate.status === 'done' ? 'done' : 'stopped';
  const branchUrl =
    mate.branch && /^[\w.-]+\/[\w.-]+$/.test(repo)
      ? `https://github.com/${repo}/tree/${mate.branch}`
      : undefined;
  return (
    <TeammateDetail
      status={mate.status}
      title={mate.title}
      issue={mate.issue}
      elapsed={elapsed}
      actions={actions}
      meta={meta}
    >
      <TeamSection title="Report" aside={report ? timeOfDay(report.at) : undefined}>
        {parts ? (
          <TeammateReport status={status} headline={parts.headline}>
            {parts.rest ? <MarkdownText>{parts.rest}</MarkdownText> : null}
          </TeammateReport>
        ) : (
          <TeammatePending>
            {mate.tail ? `${mate.tail}. ` : ''}Claude Code did not record a report.
          </TeammatePending>
        )}
      </TeamSection>
      {pr || mate.branch || mate.worktree ? (
        <TeamSection title="Links">
          <TeammateLinks>
            {pr ? (
              <TeammateLink
                icon="pr"
                label={`#${pr.number}`}
                sub={pr.title}
                href={pr.url}
                end={ciOf(pr) ? <CIBadge status={pr.ci} label="CI" /> : null}
              />
            ) : null}
            {mate.branch ? (
              <TeammateLink
                icon="branch"
                label={mate.branch}
                sub={pr ? `+${pr.additions} −${pr.deletions}` : undefined}
                href={branchUrl}
                onClick={branchUrl ? undefined : () => copy(mate.branch ?? '')}
                title={branchUrl ? 'Open the branch on GitHub' : 'Copy the branch'}
              />
            ) : null}
            {mate.worktree ? (
              <TeammateLink
                icon="folder"
                label={mate.worktree}
                onClick={() => copy(mate.worktree ?? '')}
                title="Copy the worktree's path"
              />
            ) : null}
          </TeammateLinks>
        </TeamSection>
      ) : null}
      {shots.length ? (
        <TeamSection title="Screenshots" count={shots.length}>
          <TeammateShots>
            {shots.map((id, i) => (
              <Attachment
                key={id}
                name={`Screenshot ${i + 1}`}
                src={`/api/images/${id}`}
                height={120}
              />
            ))}
          </TeammateShots>
        </TeamSection>
      ) : null}
      {briefSection}
      {stepsSection}
      {messagesSection}
    </TeammateDetail>
  );
}

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;
