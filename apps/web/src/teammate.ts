/** A message one of a session's teammates sent it. */
export interface TeammateMessage {
  from: string;
  /** Claude Code's one line on it, when it gave one. */
  summary?: string;
  text: string;
}

const RELAYED = /^\s*Another Claude session sent a message:\s*<teammate-message\s/;
const MESSAGE = /<teammate-message\s([^>]*)>([\s\S]*?)(?:<\/teammate-message>|$)/g;

/** Claude Code's own signalling between teammates, such as `idle_notification`, is JSON. */
function isSignal(body: string): boolean {
  if (!body.startsWith('{')) return false;
  try {
    return typeof JSON.parse(body).type === 'string';
  } catch {
    return false;
  }
}

/**
 * The messages in a `user` item Claude Code relayed from teammates, without the signals among
 * them or the note it adds for Claude. Undefined for anything else, such as what you typed.
 */
export function teammateMessages(text: string): TeammateMessage[] | undefined {
  if (!RELAYED.test(text)) return undefined;
  return [...text.matchAll(MESSAGE)].flatMap(([, attributes = '', body = '']) => {
    const attribute = (name: string) =>
      attributes.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] || undefined;
    const message = body.trim();
    if (isSignal(message)) return [];
    return [
      {
        from: attribute('teammate_id') ?? 'Teammate',
        summary: attribute('summary'),
        text: message,
      },
    ];
  });
}
