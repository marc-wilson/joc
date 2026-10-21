// The arrival chime: two soft sine notes rising a fourth, about 300ms in all, made with the Web Audio API so there's
// no audio file to load. Browsers only let a page make sound after the person has interacted
// with it, so the chime stays silent until then; and it sounds at most once every THROTTLE_MS,
// however many notifications arrive together.

/** The few parts of an AudioContext the chime uses, so tests can pass a fake one. */
export interface ChimeAudio {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: unknown;
  resume(): Promise<void>;
  createOscillator(): {
    type: string;
    frequency: { setValueAtTime(value: number, at: number): unknown };
    connect(node: unknown): unknown;
    start(at: number): void;
    stop(at: number): void;
  };
  createGain(): {
    gain: {
      setValueAtTime(value: number, at: number): unknown;
      linearRampToValueAtTime(value: number, at: number): unknown;
      exponentialRampToValueAtTime(value: number, at: number): unknown;
    };
    connect(node: unknown): unknown;
  };
}

export const THROTTLE_MS = 2_000;

/** Two notes, a fourth apart, rising: E5 then A5. Each `[hz, starts]` in seconds. */
const NOTES: [number, number][] = [
  [659.25, 0],
  [880, 0.09],
];
/** Each note's attack, then its exponential decay. */
const ATTACK = 0.006;
const DECAY = 0.2;
/** Soft: about −18 dBFS at its peak. No click, no tail. */
const PEAK = 0.12;

export interface ChimeOptions {
  /** Makes the audio context, once, on the first chime after an interaction. */
  audio: () => ChimeAudio | undefined;
  now?: () => number;
}

export function createChime({ audio, now = Date.now }: ChimeOptions) {
  let interacted = false;
  let last = Number.NEGATIVE_INFINITY;
  let ctx: ChimeAudio | undefined;

  function play(): boolean {
    if (!interacted) return false;
    const at = now();
    if (at - last < THROTTLE_MS) return false;
    ctx ??= audio();
    if (!ctx) return false;
    last = at;
    // A resume the browser refuses only means this chime is silent; the next one tries again.
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    const t0 = ctx.currentTime + 0.01;
    for (const [hz, starts] of NOTES) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(hz, t0 + starts);
      gain.gain.setValueAtTime(0.0001, t0 + starts);
      gain.gain.exponentialRampToValueAtTime(PEAK, t0 + starts + ATTACK);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + starts + ATTACK + DECAY);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0 + starts);
      osc.stop(t0 + starts + ATTACK + DECAY + 0.02);
    }
    return true;
  }

  return {
    /** The person pressed, clicked or typed: from now on the page may make sound. */
    interacted() {
      interacted = true;
    },
    /** Chimes, unless it's too soon after the last or the person hasn't interacted yet. */
    play,
    /** For "Send a test": an interaction itself, so it plays at once, throttle or not. */
    test(): boolean {
      interacted = true;
      last = Number.NEGATIVE_INFINITY;
      return play();
    },
  };
}

export type Chime = ReturnType<typeof createChime>;
