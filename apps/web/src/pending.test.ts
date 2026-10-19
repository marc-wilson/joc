import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConversationItem } from '@joc/protocol';
import { delivered, type PendingPrompt } from './pending.ts';

const at = '2026-10-18T10:00:00.000Z';
const image = { id: 'a'.repeat(64), type: 'image/png' } as const;
const prompt = (text: string, images: PendingPrompt['images'] = []): PendingPrompt => ({
  id: 'p1',
  sessionId: 's1',
  text,
  images,
});

test('a prompt is delivered once its text and images are in the conversation', () => {
  const items: ConversationItem[] = [
    { id: 'u1', at, kind: 'user', text: 'Fix the login loop' },
    { id: 'u2', at, kind: 'user', text: 'Why is this red?', images: [image] },
  ];
  assert.equal(delivered(items, prompt('Fix the login loop')), true);
  assert.equal(delivered(items, prompt('Why is this red?', [image])), true);
  // An earlier message with the same text but no image is not this one.
  assert.equal(delivered(items, prompt('Fix the login loop', [image])), false);
  assert.equal(delivered(items, prompt('', [image])), false);
});
