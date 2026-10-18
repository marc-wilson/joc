import type { ConversationItem, SessionState } from '@joc/protocol';
import { CodeBlock, EmptyState, Message, SlashPill, Thread } from '@joc/ui';
import { isValidElement, type ReactNode, useLayoutEffect, useRef } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Fenced code renders as the design system's CodeBlock; headings stay at reading size.
const markdown: Components = {
  pre({ children }) {
    const code = isValidElement<{ className?: string; children?: ReactNode }>(children)
      ? children.props
      : undefined;
    return (
      <CodeBlock
        code={String(code?.children ?? '')}
        lang={code?.className?.replace('language-', '')}
        lineNumbers={false}
      />
    );
  },
  // Links in a session's messages always open outside the dashboard.
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h3>{children}</h3>,
};

/** A prompt sent from the dashboard that the session hasn't started yet. */
export interface PendingPrompt {
  id: string;
  sessionId: string;
  text: string;
  failed?: boolean;
}

interface Props {
  items: ConversationItem[];
  pending: PendingPrompt[];
  state: SessionState;
}

/** A session's conversation, kept pinned to the newest message while you're at the bottom. */
export function Conversation({ items, pending, state }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  const results = new Map(
    items.flatMap((i) => (i.kind === 'tool_result' ? [[i.toolUseId, i] as const] : [])),
  );
  const lastCall = items.findLast((i) => i.kind === 'tool_call');

  return (
    <div
      className="app-main__scroll"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        // Follow new messages only while you're already at the bottom.
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {items.length || pending.length ? (
        <Thread>
          {items.map((item) => {
            switch (item.kind) {
              case 'user':
                return (
                  <Message key={item.id} from="user" time={time(item.at)}>
                    {item.command ? <SlashPill command={item.command} /> : null} {item.text}
                  </Message>
                );
              case 'claude':
                return (
                  <Message key={item.id} from="claude" time={time(item.at)}>
                    <div className="joc-md">
                      <Markdown remarkPlugins={[remarkGfm]} components={markdown}>
                        {item.text}
                      </Markdown>
                    </div>
                  </Message>
                );
              case 'tool_call': {
                const result = results.get(item.toolUseId);
                const running = !result && item === lastCall && state === 'working';
                return (
                  <Message
                    key={item.id}
                    from="tool"
                    name={item.name}
                    target={item.summary}
                    status={running ? 'running' : result?.isError ? 'error' : 'done'}
                  >
                    {result?.text || 'No output'}
                  </Message>
                );
              }
              default:
                // Tool results render inside their call above.
                return null;
            }
          })}
          {pending.map((p) => (
            <Message
              key={p.id}
              from="user"
              time={p.failed ? 'Not sent' : 'Waiting for the session'}
            >
              {p.text}
            </Message>
          ))}
        </Thread>
      ) : (
        <EmptyState
          title="No messages yet"
          body="Messages show here as the session works. Earlier history from before the plugin was installed may be partial."
        />
      )}
    </div>
  );
}
