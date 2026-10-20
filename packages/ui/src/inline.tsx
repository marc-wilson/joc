import type { ReactNode } from 'react';
import { Icon } from './Icon.tsx';

export function Code({ children }: { children?: ReactNode }) {
  return <code className="joc-code-inline">{children}</code>;
}

export function Branch({ children }: { children?: ReactNode }) {
  return (
    <span className="joc-branch">
      <Icon name="branch" size={12} />
      <span>{children}</span>
    </span>
  );
}

export function Emph({ children }: { children?: ReactNode }) {
  return <span className="joc-emph">{children}</span>;
}

/** A small outlined label beside a name, e.g. "Draft" or "Out of date". */
export function Tag({ children, title }: { children?: ReactNode; title?: string }) {
  return (
    <span className="joc-tag" title={title}>
      {children}
    </span>
  );
}

/** Marks a session that works in a linked worktree, beside its branch; hover names it. */
export function WorktreeTag({ name }: { name: string }) {
  return <Tag title={`Worktree ${name}`}>Worktree</Tag>;
}

export interface TextLinkProps {
  /** Goes there; without it, it's a button that runs `onClick`. */
  href?: string;
  onClick?: () => void;
  children?: ReactNode;
}

/** A quiet accent link in running text or a footer: "History", "Change", "Copy". */
export function TextLink({ href, onClick, children }: TextLinkProps) {
  if (href) {
    return (
      <a className="joc-link" href={href} onClick={onClick}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" className="joc-link" onClick={onClick}>
      {children}
    </button>
  );
}
