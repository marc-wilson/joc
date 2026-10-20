import type { HistorySession } from '@joc/protocol';
import {
  Button,
  CIMark,
  EmptyState,
  HistoryList,
  HistoryRow,
  OverflowMenu,
  RepoGroupHeader,
  SectionHeader,
} from '@joc/ui';
import { Fragment, useState } from 'react';
import { DeleteDialog } from './DeleteSessions.tsx';
import { cantDelete, deletionLine, deletionOf, machineLive, removedLine } from './deletes.ts';
import {
  askResume,
  useDeletes,
  useGitHub,
  useHistory,
  useNow,
  useResumes,
  useSessions,
} from './hooks.ts';
import { prFor } from './links.ts';
import { Nav } from './Nav.tsx';
import { historyResume } from './Resuming.tsx';
import { ago, duration } from './time.ts';

// Repos in the order their latest session appears: the list is already newest first.
function groupByRepo(list: HistorySession[]): [string, HistorySession[]][] {
  const groups = new Map<string, HistorySession[]>();
  for (const s of list) groups.set(s.repo, [...(groups.get(s.repo) ?? []), s]);
  return [...groups];
}

/** /history: every session JOC has seen, newest first, each with the command to resume it. */
export function HistoryPage() {
  const history = useHistory();
  const github = useGitHub();
  const now = useNow();
  const { sessions: live, deleted } = useSessions();
  const deletes = useDeletes();
  const resumes = useResumes();
  // A resume the server refused, by session.
  const [refused, setRefused] = useState<{ id: string; error: string }>();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

  async function ask(sessionId: string) {
    setRefused(undefined);
    const outcome = await askResume(sessionId);
    if ('error' in outcome) setRefused({ id: sessionId, error: outcome.error });
  }
  const [confirming, setConfirming] = useState<HistorySession[]>();
  const prs = github?.state === 'reported' ? [...github.mine, ...github.reviewRequested] : [];

  const isGone = (id: string) => deleted.has(id) || deletionOf(deletes, id)?.status === 'deleted';
  // Only rows still there and still deletable stay picked.
  const chosen = (history ?? []).filter(
    (s) => picked.has(s.id) && !isGone(s.id) && !cantDelete(s, now),
  );
  const pick = (id: string, on: boolean) =>
    setPicked((set) => {
      const next = new Set(set);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <div className="joc-app app">
      <Nav page="history" />
      <main className="joc-app__main app-page app-page--wide">
        <SectionHeader
          size="lg"
          title="History"
          count={history?.length}
          description="Every session JOC has seen, newest first. Resume one here, or copy its command to pick it up in a terminal."
        >
          {history?.length ? (
            <span className="app-history__bulk">
              <span className="app-history__picked">
                {chosen.length ? `${chosen.length} selected` : 'Select ended sessions to delete'}
              </span>
              <Button size="sm" disabled={!chosen.length} onClick={() => setPicked(new Set())}>
                Clear
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon="trash"
                disabled={!chosen.length}
                onClick={() => setConfirming(chosen)}
              >
                Delete
              </Button>
            </span>
          ) : null}
        </SectionHeader>
        {history && !history.length ? (
          <EmptyState
            title="No sessions yet"
            body="Sessions show up here once a linked machine runs one."
          />
        ) : null}
        {history
          ? groupByRepo(history).map(([repo, list]) => (
              <Fragment key={repo}>
                <RepoGroupHeader repo={repo} count={list.length} />
                <HistoryList>
                  {list.map((s) => {
                    const pr = prFor(s, prs);
                    const reason = cantDelete(s, now);
                    const deletion = deletionOf(deletes, s.id);
                    const line =
                      deletion && deletionLine(deletion, machineLive(live, deletion.machine, now));
                    const failed = deletion?.status === 'failed';
                    const current = live.find((l) => l.id === s.id) ?? s;
                    const resume = historyResume(current, resumes, live, now, () => void ask(s.id));
                    const refusal = refused?.id === s.id ? refused.error : undefined;
                    return (
                      <HistoryRow
                        key={s.id}
                        title={s.title ?? 'New session'}
                        branch={s.branch ?? ''}
                        ended={ago(s.updatedAt, now)}
                        duration={duration(s.startedAt, s.updatedAt)}
                        messages={s.messages}
                        pr={pr ? `#${pr.number}` : undefined}
                        sessionId={s.id}
                        path={s.cwd}
                        removed={isGone(s.id) ? removedLine(s.machine) : undefined}
                        select={{
                          checked: chosen.some((c) => c.id === s.id),
                          onChange: (on) => pick(s.id, on),
                          reason,
                        }}
                        status={
                          line ? (
                            <span className={failed ? 'is-failed' : undefined}>
                              {failed ? <CIMark status="fail" size={12} /> : null} {line}
                            </span>
                          ) : refusal ? (
                            <>
                              <CIMark status="fail" />
                              Couldn't resume it: {refusal}
                            </>
                          ) : resume.status ? (
                            <>
                              <CIMark
                                status={
                                  resume.failed
                                    ? 'fail'
                                    : resume.phase === 'live'
                                      ? 'pass'
                                      : 'pending'
                                }
                              />
                              {resume.status}
                            </>
                          ) : undefined
                        }
                        statusError={!line && (!!refusal || resume.failed)}
                        resume={resume.action}
                        actions={
                          <OverflowMenu
                            label={`Actions for ${s.title ?? 'New session'}`}
                            size="md"
                            items={[
                              {
                                id: 'delete',
                                label: 'Delete session…',
                                icon: 'trash',
                                danger: true,
                                disabledReason: reason,
                                onSelect: () => setConfirming([s]),
                              },
                            ]}
                          />
                        }
                      />
                    );
                  })}
                </HistoryList>
              </Fragment>
            ))
          : null}
      </main>
      {confirming ? (
        <DeleteDialog
          sessions={confirming}
          onAsked={() => {
            setConfirming(undefined);
            setPicked(new Set());
          }}
          onClose={() => setConfirming(undefined)}
        />
      ) : null}
    </div>
  );
}
