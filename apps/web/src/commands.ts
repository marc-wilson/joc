import type { ConversationItem } from '@joc/protocol';

type Command = Extract<ConversationItem, { kind: 'command' }>;

/** A command as it was typed: `/name args`. */
export function commandLine({ name, args }: Pick<Command, 'name' | 'args'>): string {
  return args ? `/${name} ${args}` : `/${name}`;
}
