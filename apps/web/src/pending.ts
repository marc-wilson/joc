import type { ConversationItem, ImageRef } from '@joc/protocol';
import { commandLine } from './commands.ts';

/** A prompt sent from the dashboard that the session hasn't started yet. */
export interface PendingPrompt {
  id: string;
  sessionId: string;
  text: string;
  /** Its images, once uploaded. */
  images: ImageRef[];
  failed?: boolean;
}

const ids = (images: ImageRef[] | undefined) => (images ?? []).map((i) => i.id).join(',');

const squash = (text: string) => text.trim().replace(/\s+/g, ' ');

/** Whether the session's own transcript has the prompt yet: the same text and images, or the
 * slash command it ran. */
export function delivered(items: ConversationItem[], prompt: PendingPrompt): boolean {
  return items.some((i) =>
    i.kind === 'command'
      ? !prompt.images.length && squash(commandLine(i)) === squash(prompt.text)
      : i.kind === 'user' && i.text.trim() === prompt.text && ids(i.images) === ids(prompt.images),
  );
}
