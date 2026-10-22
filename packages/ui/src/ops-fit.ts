// Fitting a row's pipeline into its cell: the stages in order, on as many lines as the cell has.
// When they don't fit, the least important drop out behind "+N", and a failure never does.

export interface FitPiece {
  text: string;
  /** Has a 12px glyph before its text. */
  glyph?: boolean;
  /** 0 must stay (a failure, or the only thing there is), then 1 the furthest stage, 2 a middle
   * one, 3 the pull request itself. Higher drops first. */
  priority: number;
}

/** About what a 12px Geist character and a glyph take; a little over, so nothing clips. */
const CHAR = 6.6;
const GLYPH = 16;
const GAP = 12;
/** The "+N" tag. */
const MORE = 30;

const widthOf = (p: FitPiece) => Math.ceil(p.text.length * CHAR) + (p.glyph ? GLYPH : 0);

function fits(widths: number[], width: number, lines: number) {
  let line = 1;
  let x = 0;
  for (const w of widths) {
    const need = x === 0 ? w : x + GAP + w;
    if (need <= width) x = need;
    else {
      line += 1;
      x = w;
      if (line > lines || w > width) return false;
    }
  }
  return true;
}

/**
 * The pieces that fit `width` on `lines` lines, in their own order, and the ones dropped. A
 * width of 0 (not measured yet) keeps everything.
 */
export function fitPieces<T extends FitPiece>(
  pieces: T[],
  width: number,
  lines: number,
): { kept: T[]; dropped: T[] } {
  if (width <= 0) return { kept: pieces, dropped: [] };
  const kept = [...pieces];
  const dropped: T[] = [];
  const ok = () => fits([...kept.map(widthOf), ...(dropped.length ? [MORE] : [])], width, lines);
  while (kept.length && !ok()) {
    let worst = -1;
    kept.forEach((p, i) => {
      if (p.priority > 0 && (worst < 0 || p.priority >= (kept[worst]?.priority ?? 0))) worst = i;
    });
    if (worst < 0) break;
    const [gone] = kept.splice(worst, 1);
    if (gone) dropped.push(gone);
  }
  dropped.sort((a, b) => pieces.indexOf(a) - pieces.indexOf(b));
  return { kept, dropped };
}
