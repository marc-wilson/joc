import type { ConversationItem, ImageRef, SessionState } from '@joc/protocol';
import {
  Attachment,
  Code,
  CodeBlock,
  EmptyState,
  formatBytes,
  ImageViewer,
  Message,
  SlashPill,
  Thread,
} from '@joc/ui';
import { isValidElement, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
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

const imageSrc = (image: ImageRef) => `/api/images/${image.id}`;
const imageName = (i: number) => `Image ${i + 1}`;
const imageSize = (image: ImageRef) => (image.bytes ? formatBytes(image.bytes) : undefined);

/** The images a message is showing full size, and which of them. */
interface Viewing {
  images: ImageRef[];
  index: number;
}

/** A message's images after it on the right: one large, several as a row of smaller ones. Each
 * opens full size in the viewer. Served by the API, never inlined. */
function Images({ images, onOpen }: { images: ImageRef[]; onOpen: (index: number) => void }) {
  const one = images.length === 1;
  return (
    <div className="app-msg-images">
      {images.map((image, i) => (
        <Attachment
          key={image.id}
          name={imageName(i)}
          src={imageSrc(image)}
          size={imageSize(image)}
          width={one ? 480 : 216}
          height={one ? 270 : 132}
          onOpen={() => onOpen(i)}
        />
      ))}
    </div>
  );
}

/** A prompt: its text in a bubble, then its images. */
function UserMessage({
  time,
  text,
  command,
  images,
  onOpen,
}: {
  time: string;
  text: string;
  command?: string;
  images: ImageRef[];
  onOpen: (viewing: Viewing) => void;
}) {
  const words = Boolean(text || command);
  return (
    <>
      {words ? (
        <Message from="user" time={time}>
          {command ? <SlashPill command={command} /> : null} {text}
        </Message>
      ) : null}
      {images.length ? (
        <div>
          <Images images={images} onOpen={(index) => onOpen({ images, index })} />
          {/* Images alone still say when they were sent. */}
          {words ? null : <div className="joc-msg__time joc-msg__time--user">{time}</div>}
        </div>
      ) : null}
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
  const [viewing, setViewing] = useState<Viewing>();

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
                  <UserMessage
                    key={item.id}
                    time={time(item.at)}
                    text={item.text}
                    command={item.command}
                    images={item.images ?? []}
                    onOpen={setViewing}
                  />
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
            <UserMessage
              key={p.id}
              time={p.failed ? 'Not sent' : 'Waiting for the session'}
              text={p.text}
              images={p.images}
              onOpen={setViewing}
            />
          ))}
        </Thread>
      ) : (
        <EmptyState
          title="No messages yet"
          body="Messages show here as the session works. Earlier history from before the plugin was installed may be partial."
        />
      )}
      {viewing ? (
        <ImageViewer
          images={viewing.images.map((image, i) => ({
            src: imageSrc(image),
            name: imageName(i),
            size: imageSize(image),
          }))}
          index={viewing.index}
          onIndex={(index) => setViewing({ ...viewing, index })}
          onClose={() => setViewing(undefined)}
        />
      ) : null}
    </div>
  );
}
