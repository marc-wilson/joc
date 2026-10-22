import type { ReactNode } from 'react';
import { CIMark } from './ci.tsx';
import { CopyButton } from './code.tsx';
import { mcpSummary, type StatusMcpServer } from './status.ts';

export interface SessionStatusPanelProps {
  name: string;
  id: string;
  folder?: string;
  model?: string;
  /** Claude Code's version; undefined until the session's plugin reports it. */
  version?: string;
  /** Undefined until the session's plugin reports them. */
  mcp?: StatusMcpServer[];
  /** Said where nothing is reported, e.g. why an older plugin doesn't. */
  missing?: ReactNode;
}

const toolCount = (n = 0) => (n === 1 ? '1 tool' : `${n} tools`);

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="joc-sstatus__label">{label}</dt>
      <dd className="joc-sstatus__value">{children}</dd>
    </>
  );
}

function Mono({ text, copy }: { text: string; copy?: boolean }) {
  return (
    <span className="joc-sstatus__line">
      <code className="joc-sstatus__mono" title={text}>
        {text}
      </code>
      {copy ? <CopyButton text={text} /> : null}
    </span>
  );
}

/**
 * A session's status, as `/status` shows it in the terminal less the login: its name and id,
 * folder, model, Claude Code's version and its MCP servers, connected or failing.
 */
export function SessionStatusPanel({
  name,
  id,
  folder,
  model,
  version,
  mcp,
  missing = 'Not reported yet',
}: SessionStatusPanelProps) {
  const none = <span className="joc-sstatus__none">{missing}</span>;
  return (
    <dl className="joc-sstatus">
      <Row label="Name">
        <span className="joc-sstatus__text">{name}</span>
      </Row>
      <Row label="Session id">
        <Mono text={id} copy />
      </Row>
      <Row label="Folder">{folder ? <Mono text={folder} copy /> : none}</Row>
      <Row label="Model">{model ? <Mono text={model} /> : none}</Row>
      <Row label="Claude Code">{version ? <Mono text={version} /> : none}</Row>
      <Row label="MCP servers">
        {mcp ? (
          <>
            <span className="joc-sstatus__text">{mcpSummary(mcp)}</span>
            {mcp.length ? (
              <ul className="joc-sstatus__servers">
                {mcp.map((s) => (
                  <li key={s.name} className="joc-sstatus__server">
                    <CIMark status={s.state === 'connected' ? 'pass' : 'fail'} size={12} />
                    <code className="joc-sstatus__mono" title={s.name}>
                      {s.name}
                    </code>
                    <span className="joc-sstatus__meta">
                      {s.state === 'connected' ? toolCount(s.tools) : 'Not connected'}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          none
        )}
      </Row>
    </dl>
  );
}
