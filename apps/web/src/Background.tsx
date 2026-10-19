import { EmptyState, SectionHeader, TaskRow } from '@joc/ui';
import { type BackgroundTask, elapsed } from './background.ts';
import { useNow } from './hooks.ts';

interface Props {
  tasks: BackgroundTask[];
}

/** The session's background shells and subagents, in the order they started. */
export function BackgroundView({ tasks }: Props) {
  // Running times tick by the second while the tab is open.
  const now = useNow(1000);
  const running = tasks.filter((t) => t.status === 'running').length;
  return (
    <div className="app-main__scroll">
      {tasks.length ? (
        <>
          <SectionHeader
            title="Background tasks"
            count={tasks.length}
            description={running ? `${running} running` : 'Nothing running'}
          />
          <div className="app-tasks">
            {tasks.map((t) => (
              <TaskRow
                key={t.id}
                kind={t.kind}
                kindLabel={t.label}
                title={t.title}
                command={t.command}
                tail={t.tail}
                elapsed={
                  t.status === 'running'
                    ? elapsed(t.startedAt, now)
                    : t.endedAt
                      ? elapsed(t.startedAt, t.endedAt)
                      : undefined
                }
                state={t.status === 'running' ? 'background' : 'idle'}
                result={t.status === 'pass' || t.status === 'fail' ? t.status : undefined}
              />
            ))}
          </div>
        </>
      ) : (
        <EmptyState
          title="No background tasks"
          body="Background shell commands and subagents this session starts show here."
          icon="terminal"
        />
      )}
    </div>
  );
}
