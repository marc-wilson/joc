import { z } from 'zod';

export const SessionState = z.enum(['working', 'background', 'needs_you', 'idle', 'offline']);
export type SessionState = z.infer<typeof SessionState>;
