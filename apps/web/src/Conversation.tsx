import type { ConversationItem, ImageRef, Session, SessionState } from '@joc/protocol';
import {
  Attachment,
  Code,
  CodeBlock,
  Divider,
  EmptyState,
  formatBytes,
  ImageViewer,
  JumpToLatest,
  Message,
  MessageStatus,
  SlashPill,
  TextLink,
  Thread,
} from '@joc/ui';
import {
  isValidElement,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { WaitingCards } from './Answering.tsx';
import { commandLine } from './commands.ts';
import type { PendingView } from './pending.ts';
import { plain } from './plain.ts';
import { updateSessionPrefs, useSessionPrefs } from './prefs.ts';
import { toggled } from './toggled.ts';
import { seenIds, unseenCount } from './unseen.ts';

/** Within this of the bottom you're at the newest message, and the thread follows new ones. */
const PINNED_PX = 80;

/** Where End goes elsewhere: typing, or a dialog over the page. */
const KEEPS_END = 'input, textarea, select, [contenteditable="true"], [role="dialog"], dialog';

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
function Images({
  images,
  pending,
  onOpen,
}: {
  images: ImageRef[];
  pending?: boolean;
  onOpen: (index: number) => void;
}) {
  const one = images.length === 1;
  return (
    <div className={pending ? 'app-msg-images joc-msg-images--pending' : 'app-msg-images'}>
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
  pending,
  footer,
  fade,
  onOpen,
}: {
  time?: string;
  text: string;
  command?: string;
  images: ImageRef[];
  /** Sent from JOC and not in the transcript yet (see `Message`). */
  pending?: PendingView['phase'];
  /** In place of the time: where a pending one stands. */
  footer?: ReactNode;
  fade?: boolean;
  onOpen: (viewing: Viewing) => void;
}) {
  const words = Boolean(text || command);
  return (
    <>
      {words ? (
        <Message from="user" time={time} pending={pending} footer={footer} fade={fade}>
          {command ? <SlashPill command={command} /> : null} {text}
        </Message>
      ) : null}
      {images.length ? (
        <div>
          <Images
            images={images}
            pending={!!pending}
            onOpen={(index) => onOpen({ images, index })}
          />
          {/* Images alone still say when they were sent. */}
          {words
            ? null
            : (footer ?? <div className="joc-msg__time joc-msg__time--user">{time}</div>)}
        </div>
      ) : null}
    </>
  );
}

/** What a pending message offers, by where it stands. */
export interface PendingActions {
  onCancel: (view: PendingView) => void;
  onEdit: (view: PendingView) => void;
  onRetry: (view: PendingView) => void;
}

/** The line under a pending message: where it stands, then what can still be done with it. */
function PendingLine({ view, actions }: { view: PendingView; actions: PendingActions }) {
  const failed = view.phase === 'failed';
  // Edit puts the words back in the box; images can't go back, so then only Cancel.
  const editable = view.changeable && !view.prompt.images.length;
  return (
    <MessageStatus failed={failed}>
      <span>{view.line}</span>
      {failed && !view.changeable ? (
        <TextLink onClick={() => actions.onRetry(view)}>Retry</TextLink>
      ) : null}
      {editable ? <TextLink onClick={() => actions.onEdit(view)}>Edit</TextLink> : null}
      {view.changeable ? <TextLink onClick={() => actions.onCancel(view)}>Cancel</TextLink> : null}
    </MessageStatus>
  );
}

/** A collapsed message's one line: its first line of text, as plain text. */
const firstLine = (text: string) => plain(text.split('\n').find((l) => l.trim()) ?? '');

/** Claude's markdown, as a message shows it. */
export function MarkdownText({ children }: { children: string }) {
  return (
    <div className="joc-md">
      <Markdown remarkPlugins={[remarkGfm]} components={markdown}>
        {children}
      </Markdown>
    </div>
  );
}

interface ThreadItemsProps {
  items: ConversationItem[];
  /** Whether the last tool call may still be running. */
  working: boolean;
  /** Claude's messages that are folded, by id. */
  folded: string[];
  onFold: (id: string) => void;
  onOpen?: (viewing: Viewing) => void;
  /** Something drawn between the items, before the item at `index`, such as a divider. */
  insert?: { index: number; node: ReactNode };
  /** Items that took a pending message's place: they show at once, without fading in. */
  settled?: ReadonlySet<string>;
}

/** Conversation items as messages, for a `Thread`: a session's, or a subagent's own steps. */
export function ThreadItems({
  items,
  working,
  folded,
  onFold,
  onOpen = () => {},
  insert,
  settled,
}: ThreadItemsProps) {
  const results = new Map(
    items.flatMap((i) => (i.kind === 'tool_result' ? [[i.toolUseId, i] as const] : [])),
  );
  const lastCall = items.findLast((i) => i.kind === 'tool_call');
  const commands = new Map(
    items.flatMap((i) => (i.kind === 'command' ? [[i.id, i] as const] : [])),
  );
  const rendered = items.map((item) => {
    switch (item.kind) {
      case 'user':
        return (
          <UserMessage
            key={item.id}
            time={time(item.at)}
            text={item.text}
            command={item.command}
            images={item.images ?? []}
            fade={!settled?.has(item.id)}
            onOpen={onOpen}
          />
        );
      case 'command':
        return (
          <Message key={item.id} from="user" time={time(item.at)} fade={!settled?.has(item.id)}>
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
          <Message
            key={item.id}
            from="claude"
            time={time(item.at)}
            collapsed={folded.includes(item.id)}
            preview={firstLine(item.text)}
            onToggle={() => onFold(item.id)}
          >
            <MarkdownText>{item.text}</MarkdownText>
          </Message>
        );
      case 'tool_call': {
        const result = results.get(item.toolUseId);
        const running = !result && item === lastCall && working;
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
  });
  if (!insert) return rendered;
  return [...rendered.slice(0, insert.index), insert.node, ...rendered.slice(insert.index)];
}

interface Props {
  sessionId: string;
  items: ConversationItem[];
  /** Messages sent from JOC that the transcript doesn't have yet, in the order sent. */
  pending: PendingView[];
  pendingActions: PendingActions;
  /** Items that took a pending message's place. */
  settled?: ReadonlySet<string>;
  state: SessionState;
  /** The session, for answering what it waits on from here. */
  session?: Session;
  /** A line across the thread, after the items up to `at` (at the end without one). */
  divider?: { text: string; at?: string };
}

/** A session's conversation, kept pinned to the newest message while you're at the bottom. */
export function Conversation({
  sessionId,
  items,
  pending,
  pendingActions,
  settled,
  state,
  session,
  divider,
}: Props) {
  const at = divider?.at;
  const insert = divider
    ? {
        index: at ? items.filter((i) => i.at <= at).length : items.length,
        node: <Divider key="divider">{divider.text}</Divider>,
      }
    : undefined;
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // While you're scrolled up: the items on screen when you left the bottom, to count new ones.
  const [seen, setSeen] = useState<ReadonlySet<string>>();
  // More than a screen of the thread is below what you're reading.
  const [far, setFar] = useState(false);
  const [viewing, setViewing] = useState<Viewing>();
  // Claude's messages you folded, remembered per session.
  const folded = useSessionPrefs(sessionId).foldedMessages;
  const unseen = unseenCount(items, seen, settled);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (pinned.current) el.scrollTop = el.scrollHeight;
    // New messages below grow what's left to read without a scroll; nothing on screen moves.
    else setFar(el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight);
  });

  // You asked for it, so the one jump: straight there, never a smooth scroll.
  const jump = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = true;
    setSeen(undefined);
    setFar(false);
    el.scrollTop = el.scrollHeight;
  }, []);

  // End jumps too, unless it's moving a cursor or a dialog is open.
  useEffect(() => {
    if (viewing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'End' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target instanceof Element && e.target.closest(KEEPS_END)) return;
      e.preventDefault();
      jump();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [viewing, jump]);

  return (
    <div className="app-main__conv">
      <div
        className="app-main__scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          const below = el.scrollHeight - el.scrollTop - el.clientHeight;
          // Follow new messages only while you're already at the bottom.
          pinned.current = below < PINNED_PX;
          setFar(below > el.clientHeight);
          if (pinned.current) setSeen(undefined);
          else setSeen((s) => s ?? seenIds(items));
        }}
      >
        {items.length || pending.length || session?.waiting ? (
          <Thread>
            <ThreadItems
              items={items}
              working={state === 'working'}
              folded={folded}
              onFold={(id) =>
                updateSessionPrefs({
                  id: sessionId,
                  foldedMessages: toggled(folded, id, !folded.includes(id)),
                })
              }
              onOpen={setViewing}
              insert={insert}
              settled={settled}
            />
            {pending.map((view) => (
              <UserMessage
                key={view.prompt.id}
                text={view.prompt.text}
                images={view.prompt.images}
                pending={view.phase}
                footer={<PendingLine view={view} actions={pendingActions} />}
                onOpen={setViewing}
              />
            ))}
            {session ? <WaitingCards session={session} items={items.length} /> : null}
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
      {/* Over the bottom of the thread while you read further up; hidden at the bottom. */}
      <JumpToLatest shown={Boolean(seen) && (far || unseen > 0)} count={unseen} onJump={jump} />
    </div>
  );
}
