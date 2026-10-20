import type { ConversationItem } from '@joc/protocol';
import {
  Button,
  EmptyState,
  SectionHeader,
  TaskDetails as TaskDetailsPanel,
  type TaskFact,
  TaskGroupHeader,
  TaskRow,
  TaskSection,
  Thread,
} from '@joc/ui';
import { useEffect, useRef, useState } from 'react';
import {
  arrangeTasks,
  type BackgroundTask,
  elapsed,
  FINISHED_SHOWN,
  latestStep,
} from './background.ts';
import { MarkdownText, ThreadItems } from './Conversation.tsx';
import { useConversation, useNow } from './hooks.ts';
import { updatePrefs, usePrefs } from './prefs.ts';
import { toggled } from './toggled.ts';

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

/**
 * The session's background shells and subagents: those still running first, in the order they
 * started, then the finished ones, newest first.
 */
export function BackgroundView({ sessionId, tasks }: Props) {
  // Running times tick by the second while the tab is open.
  const now = useNow(1000);
  // The tasks you opened; each stays open until you close it, wherever it moves.
  const [open, setOpen] = useState<string[]>([]);
  const { showAllFinishedTasks: showAll } = usePrefs();
  // While the pointer is over the list, a task that ends stays where it is, shown finished; it
  // moves down to the finished ones when the pointer leaves.
  const [pointing, setPointing] = useState(false);
  const shownRunning = useRef<string[]>([]);
  // The rows that moved down, which fade in where they land.
  const moved = useRef(new Set<string>());
  const { running, finished } = arrangeTasks(tasks, pointing ? shownRunning.current : []);
  for (const t of finished) if (shownRunning.current.includes(t.id)) moved.current.add(t.id);
  useEffect(() => {
    shownRunning.current = running.map((t) => t.id);
  });
  const stillRunning = running.filter((t) => t.status === 'running').length;
  // An opened row stays shown even past the latest few.
  const shownFinished = finished.filter(
    (t, i) => showAll || i < FINISHED_SHOWN || open.includes(t.id),
  );

  const row = (t: BackgroundTask) => (
    <TaskItem
      key={t.id}
      sessionId={sessionId}
      task={t}
      elapsed={runTime(t, now)}
      open={open.includes(t.id)}
      onToggle={(on) => setOpen(toggled(open, t.id, on))}
      fadeIn={moved.current.has(t.id)}
    />
  );

  return (
    <div className="app-main__scroll">
      {tasks.length ? (
        <>
          <SectionHeader
            title="Background tasks"
            count={tasks.length}
            description={stillRunning ? `${stillRunning} running` : 'Nothing running'}
          />
          {/* One list, so a row that moves keeps its details open and loaded. */}
          <div
            className="app-tasks"
            onPointerEnter={() => setPointing(true)}
            onPointerLeave={() => setPointing(false)}
          >
            {running.length ? (
              <TaskGroupHeader key="group:running" title="Running" count={stillRunning} />
            ) : null}
            {running.map(row)}
            {finished.length ? (
              <TaskGroupHeader key="group:finished" title="Finished" count={finished.length}>
                {finished.length > FINISHED_SHOWN ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => updatePrefs({ showAllFinishedTasks: !showAll })}
                  >
                    {showAll ? `Show latest ${FINISHED_SHOWN}` : `Show all ${finished.length}`}
                  </Button>
                ) : null}
              </TaskGroupHeader>
            ) : null}
            {shownFinished.map(row)}
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

/** One task's row, and its details while open. A running subagent says what it's doing. */
function TaskItem({
  sessionId,
  task,
  elapsed,
  open,
  onToggle,
  fadeIn,
}: {
  sessionId: string;
  task: BackgroundTask;
  elapsed?: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  fadeIn: boolean;
}) {
  const running = task.status === 'running';
  // Only a subagent has steps of its own; they're read while it runs or is open.
  const steps = useConversation(
    task.kind === 'subagent' && (running || open) ? sessionId : undefined,
    task.id,
  );
  return (
    <TaskRow
      kind={task.kind}
      kindLabel={task.label}
      title={task.title}
      command={task.command}
      tail={running ? latestStep(steps) : task.tail}
      elapsed={elapsed}
      state={running ? 'background' : 'idle'}
      result={task.status === 'pass' || task.status === 'fail' ? task.status : undefined}
      open={open}
      onToggle={() => onToggle(!open)}
      className={fadeIn ? 'joc-fade-in' : undefined}
      details={open ? <TaskDetails task={task} steps={steps} elapsed={elapsed} /> : null}
    />
  );
}

/** One task, opened: what it was asked, what it did and how it ended. */
function TaskDetails({
  task,
  steps,
  elapsed,
}: {
  task: BackgroundTask;
  steps: ConversationItem[];
  elapsed?: string;
}) {
  const subagent = task.kind === 'subagent';
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
