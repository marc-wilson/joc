import type { ReactNode } from 'react';
import { CIMark } from './ci.tsx';
import { cx } from './cx.ts';

// Resuming an ended session (issue #68). An ended session isn't live, so it has no state dot:
// a neutral tag says so. Starting back up changes text and colour in place, never the layout.

export interface EndedTagProps {
  /** "Ended", or "Starting…" while it resumes. */
  label?: string;
}

/** The neutral tag an ended session shows where a live one shows its state. */
export function EndedTag({ label = 'Ended' }: EndedTagProps) {
  return <span className="joc-ended">{label}</span>;
}

export type ResumeStepStatus = 'done' | 'pending' | 'todo';

export interface ResumeStep {
  label: ReactNode;
  /** The label is a command, shown in mono. */
  mono?: boolean;
  status: ResumeStepStatus;
}

/** How far a resume got: reached the machine, `claude --resume`, loading the messages. */
export function ResumeSteps({ steps }: { steps: ResumeStep[] }) {
  return (
    <div className="joc-resume__steps" role="status">
      {steps.map((step, i) => (
        <span
          // The steps are fixed and in order; their labels change in place.
          // biome-ignore lint/suspicious/noArrayIndexKey: the index is the step
          key={i}
          className={cx('joc-resume__step', step.status === 'todo' && 'is-todo')}
        >
          {step.status === 'todo' ? null : (
            <CIMark status={step.status === 'done' ? 'pass' : 'pending'} />
          )}
          {step.mono ? <code>{step.label}</code> : step.label}
        </span>
      ))}
    </div>
  );
}

/** A line across the conversation, such as "Resumed at 10:42 on harbor-mbp". Fades in. */
export function Divider({ children }: { children: ReactNode }) {
  return (
    <div className="joc-divider joc-fade-in" role="status">
      {children}
    </div>
  );
}
