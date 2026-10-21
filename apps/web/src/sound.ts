import { type ChimeAudio, createChime } from './chime.ts';

// The page's one chime (chime.ts), on the browser's AudioContext. It may sound once the person
// has pressed or typed anything on the page.

export const chime = createChime({
  audio: () => {
    try {
      const audio: ChimeAudio | undefined = window.AudioContext ? new AudioContext() : undefined;
      return audio;
    } catch {
      // A browser that refuses an AudioContext (policy, too many open) just stays silent.
      return undefined;
    }
  },
});

const unlock = () => {
  chime.interacted();
  for (const type of ['pointerdown', 'keydown'] as const) {
    window.removeEventListener(type, unlock, true);
  }
};
for (const type of ['pointerdown', 'keydown'] as const) {
  window.addEventListener(type, unlock, true);
}
