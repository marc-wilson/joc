import type { HistorySession } from '@joc/protocol';
import { EmptyState, HistoryRow, RepoGroupHeader, SectionHeader } from '@joc/ui';
import { Fragment } from 'react';
import { useGitHub, useHistory, useNow } from './hooks.ts';
import { prFor, resumeCommand } from './links.ts';
import { Nav } from './Nav.tsx';
import { plain } from './plain.ts';
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
  const prs = github?.state === 'reported' ? [...github.mine, ...github.reviewRequested] : [];

  return (
    <div className="joc-app app">
      <Nav page="history" />
      <main className="joc-app__main app-page">
        <SectionHeader
          size="lg"
          title="History"
          count={history?.length}
          description="Every session JOC has seen, newest first. Copy a command to pick one up where it left off."
        />
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
                <div className="app-list">
                  {list.map((s) => {
                    const pr = prFor(s, prs);
                    return (
                      <HistoryRow
                        key={s.id}
                        title={s.title ?? 'New session'}
                        branch={s.branch ?? ''}
                        ended={ago(s.updatedAt, now)}
                        duration={duration(s.startedAt, s.updatedAt)}
                        messages={s.messages}
                        summary={s.activity && plain(s.activity)}
                        pr={pr ? `#${pr.number}` : undefined}
                        command={resumeCommand(s)}
                      />
                    );
                  })}
                </div>
              </Fragment>
            ))
          : null}
      </main>
    </div>
  );
}
