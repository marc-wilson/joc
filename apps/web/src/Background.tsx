import type { ConversationItem } from '@joc/protocol';
import {
  CopyCommand,
  EmptyState,
  SectionHeader,
  TaskAsked,
  TaskDetails as TaskDetailsPanel,
  TaskOutput,
  TaskPending,
  TaskReport,
  TaskRow,
  TaskSection,
  TaskShowAll,
  TaskSteps,
  TextLink,
} from '@joc/ui';
import { useEffect, useRef, useState } from 'react';
import {
  arrangeTasks,
  type BackgroundTask,
  clock,
  elapsed,
  FINISHED_SHOWN,
  latestStep,
  taskSteps,
} from './background.ts';
import { MarkdownText } from './Conversation.tsx';
import { useConversation, useNow } from './hooks.ts';
import { updatePrefs, usePrefs } from './prefs.ts';
import { toggled } from './toggled.ts';

interface Props {
  sessionId: string;
  tasks: BackgroundTask[];
}

// A running time ticks on a clock, which keeps its width; a finished one reads compactly.
const runTime = (t: BackgroundTask, now: number) =>
  t.status === 'running'
    ? clock(t.startedAt, now)
    : t.endedAt
      ? elapsed(t.startedAt, t.endedAt)
      : undefined;

const copy = (text: string) => navigator.clipboard?.writeText(text).catch(() => {});

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
    <div className="app-main__scroll app-bg">
      {tasks.length ? (
        // One list, so a row that moves keeps its details open and loaded.
        <div
          className="joc-bg"
          onPointerEnter={() => setPointing(true)}
          onPointerLeave={() => setPointing(false)}
        >
          {running.length ? (
            <SectionHeader key="group:running" title="Running" count={stillRunning} />
          ) : null}
          {running.map(row)}
          {finished.length ? (
            <SectionHeader key="group:finished" title="Finished" count={finished.length} />
          ) : null}
          {shownFinished.map(row)}
          {finished.length > FINISHED_SHOWN ? (
            <TaskShowAll
              count={finished.length}
              all={showAll}
              latest={FINISHED_SHOWN}
              onClick={() => updatePrefs({ showAllFinishedTasks: !showAll })}
            />
          ) : null}
        </div>
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
      step={running ? latestStep(steps) : undefined}
      tail={running ? undefined : task.tail}
      elapsed={elapsed}
      state={running ? 'background' : 'idle'}
      result={task.status === 'pass' || task.status === 'fail' ? task.status : undefined}
      open={open}
      onToggle={() => onToggle(!open)}
      className={fadeIn ? 'joc-fade-in' : undefined}
      details={open ? <TaskDetails task={task} steps={steps} /> : null}
    />
  );
}

/** One task, opened: what it was asked, what it did and how it ended. */
function TaskDetails({ task, steps }: { task: BackgroundTask; steps: ConversationItem[] }) {
  const subagent = task.kind === 'subagent';
  const running = task.status === 'running';
  const command = task.fullCommand ?? task.command;
  const lines = subagent ? taskSteps(steps, task.startedAt, running) : [];
  return (
    <TaskDetailsPanel>
      {subagent ? (
        <TaskSection title="Asked">
          <TaskAsked>{task.prompt ?? task.title}</TaskAsked>
        </TaskSection>
      ) : command ? (
        <TaskSection title="Command">
          {/* One line copies as it shows; a longer one wraps rather than scroll out of sight. */}
          {command.includes('\n') ? (
            <TaskOutput>{command}</TaskOutput>
          ) : (
            <CopyCommand command={command} />
          )}
        </TaskSection>
      ) : null}
      {lines.length ? (
        <TaskSection title="Steps" meta={lines.length}>
          <TaskSteps steps={lines} />
        </TaskSection>
      ) : null}
      {subagent ? (
        <TaskSection
          title={task.status === 'fail' ? 'Error' : 'Report'}
          foot={
            task.report ? (
              <TextLink onClick={() => copy(task.report ?? '')}>Copy</TextLink>
            ) : undefined
          }
        >
          {task.report ? (
            <TaskReport>
              <MarkdownText>{task.report}</MarkdownText>
            </TaskReport>
          ) : (
            <TaskPending>
              {running
                ? 'The report arrives here when the agent finishes.'
                : 'Claude Code did not record a report.'}
            </TaskPending>
          )}
        </TaskSection>
      ) : (
        <TaskSection
          title="Output"
          foot={
            task.output ? (
              <TextLink onClick={() => copy(task.output ?? '')}>Copy</TextLink>
            ) : undefined
          }
        >
          {task.output ? (
            <TaskOutput>{task.output}</TaskOutput>
          ) : (
            <TaskPending>
              {running
                ? 'What it prints shows here when it finishes.'
                : 'Claude Code did not record what it printed.'}
            </TaskPending>
          )}
        </TaskSection>
      )}
    </TaskDetailsPanel>
  );
}
