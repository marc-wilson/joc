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
