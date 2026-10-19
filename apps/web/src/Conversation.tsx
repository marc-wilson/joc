import type { ConversationItem, ImageRef, SessionState } from '@joc/protocol';
import {
  Attachment,
  Code,
  CodeBlock,
  EmptyState,
  formatBytes,
  Message,
  SlashPill,
  Thread,
} from '@joc/ui';
import { isValidElement, type ReactNode, useLayoutEffect, useRef } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { commandLine } from './commands.ts';
import type { PendingPrompt } from './pending.ts';

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
  // Wide tables scroll inside the message instead of stretching the column.
  table: ({ children }) => (
    <div className="app-md-table">
      <table>{children}</table>
    </div>
  ),
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h3>{children}</h3>,
};

/** A message's images, each opening full size in a new tab. Served by the API, never inlined. */
function Images({ images }: { images: ImageRef[] }) {
  return (
    <div className="joc-row">
      {images.map((image, i) => {
        const src = `/api/images/${image.id}`;
        return (
          <Attachment
            key={image.id}
            name={`Image ${i + 1}`}
            src={src}
            href={src}
            size={image.bytes ? formatBytes(image.bytes) : undefined}
            width={240}
            height={160}
          />
        );
      })}
    </div>
  );
}

/** A prompt's text and images; just the text when there are none, as before images. */
function UserMessage({
  text,
  command,
  images,
}: {
  text: string;
  command?: string;
  images: ImageRef[];
}) {
  const words = (
    <>
      {command ? <SlashPill command={command} /> : null} {text}
    </>
  );
  if (!images.length) return words;
  return (
    <>
      {text || command ? <p>{words}</p> : null}
      <Images images={images} />
    </>
  );
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
  const commands = new Map(
    items.flatMap((i) => (i.kind === 'command' ? [[i.id, i] as const] : [])),
  );

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
                    <UserMessage
                      text={item.text}
                      command={item.command}
                      images={item.images ?? []}
                    />
                  </Message>
                );
              case 'command':
                return (
                  <Message key={item.id} from="user" time={time(item.at)}>
                    <Code>{commandLine(item)}</Code>
                  </Message>
                );
              case 'command_output': {
                const command = item.commandId ? commands.get(item.commandId) : undefined;
                return (
                  <Message
                    key={item.id}
                    from="tool"
                    name="Output"
                    target={command ? commandLine(command) : undefined}
                    status={item.isError ? 'error' : 'done'}
                    expanded
                  >
                    {item.text}
                  </Message>
                );
              }
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
              <UserMessage text={p.text} images={p.images} />
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
