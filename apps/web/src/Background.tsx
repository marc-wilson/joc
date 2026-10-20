import {
  EmptyState,
  SectionHeader,
  TaskDetails as TaskDetailsPanel,
  type TaskFact,
  TaskRow,
  TaskSection,
  Thread,
} from '@joc/ui';
import { useState } from 'react';
import { type BackgroundTask, elapsed } from './background.ts';
import { MarkdownText, ThreadItems } from './Conversation.tsx';
import { useConversation, useNow } from './hooks.ts';
import { toggled } from './prefs.ts';

interface Props {
  sessionId: string;
  tasks: BackgroundTask[];
}

const STATUS: Record<BackgroundTask['status'], string> = {
  running: 'Running',
  pass: 'Finished',
  fail: 'Failed',
  ended: 'Ended',
};

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const runTime = (t: BackgroundTask, now: number) =>
  t.status === 'running'
    ? elapsed(t.startedAt, now)
    : t.endedAt
      ? elapsed(t.startedAt, t.endedAt)
      : undefined;

/** The session's background shells and subagents, in the order they started. */
export function BackgroundView({ sessionId, tasks }: Props) {
  // Running times tick by the second while the tab is open.
  const now = useNow(1000);
  // The tasks you opened; each stays open until you close it.
  const [open, setOpen] = useState<string[]>([]);
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
            {tasks.map((t) => {
              const isOpen = open.includes(t.id);
              return (
                <TaskRow
                  key={t.id}
                  kind={t.kind}
                  kindLabel={t.label}
                  title={t.title}
                  command={t.command}
                  tail={t.tail}
                  elapsed={runTime(t, now)}
                  state={t.status === 'running' ? 'background' : 'idle'}
                  result={t.status === 'pass' || t.status === 'fail' ? t.status : undefined}
                  open={isOpen}
                  onToggle={() => setOpen(toggled(open, t.id, !isOpen))}
                  details={
                    isOpen ? (
                      <TaskDetails sessionId={sessionId} task={t} elapsed={runTime(t, now)} />
                    ) : null
                  }
                />
              );
            })}
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

/** One task, opened: what it was asked, what it did and how it ended. */
function TaskDetails({
  sessionId,
  task,
  elapsed,
}: {
  sessionId: string;
  task: BackgroundTask;
  elapsed?: string;
}) {
  const subagent = task.kind === 'subagent';
  // Only a subagent has steps of its own.
  const steps = useConversation(subagent ? sessionId : undefined, task.id);
  const [folded, setFolded] = useState<string[]>([]);
  const facts: TaskFact[] = [
    { label: 'Type', value: task.label ?? (subagent ? 'Subagent' : 'Shell') },
    { label: 'Status', value: STATUS[task.status] },
    { label: 'Started', value: clock(task.startedAt) },
    ...(elapsed
      ? [{ label: task.status === 'running' ? 'Running for' : 'Took', value: elapsed }]
      : []),
  ];
  const command = task.fullCommand ?? task.command;
  return (
    <TaskDetailsPanel facts={facts}>
      {subagent ? (
        <TaskSection title="Asked" pre>
          {task.prompt ?? task.title}
        </TaskSection>
      ) : command ? (
        <TaskSection title="Command" mono>
          {command}
        </TaskSection>
      ) : null}
      {steps.length ? (
        <TaskSection title="Steps">
          <Thread>
            <ThreadItems
              items={steps}
              working={task.status === 'running'}
              folded={folded}
              onFold={(id) => setFolded(toggled(folded, id, !folded.includes(id)))}
            />
          </Thread>
        </TaskSection>
      ) : null}
      {task.report ? (
        <TaskSection title={task.status === 'fail' ? 'Error' : 'Report'}>
          <MarkdownText>{task.report}</MarkdownText>
        </TaskSection>
      ) : null}
      {task.output ? (
        <TaskSection title="Output" mono>
          {task.output}
        </TaskSection>
      ) : null}
      {!task.report && !task.output && task.status !== 'running' ? (
        <TaskSection title={subagent ? 'Report' : 'Output'}>
          {subagent
            ? 'Claude Code did not record a report.'
            : 'Claude Code did not record what it printed.'}
        </TaskSection>
      ) : null}
    </TaskDetailsPanel>
  );
}
