import type { ConversationItem, ImageRef } from '@joc/protocol';

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

/** Whether the session's own transcript has the prompt yet: the same text and images. */
export function delivered(items: ConversationItem[], prompt: PendingPrompt): boolean {
  return items.some(
    (i) =>
      i.kind === 'user' && i.text.trim() === prompt.text && ids(i.images) === ids(prompt.images),
  );
}
