// The composer's text as typed and where its caret is, read from the editable box: each `<br>`
// or new line block counts as one line break, as it reads on screen.

interface Piece {
  node: Node;
  text: string;
}

function pieces(root: Node): Piece[] {
  const out: Piece[] = [];
  const visit = (parent: Node) => {
    for (const child of parent.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) out.push({ node: child, text: child.nodeValue ?? '' });
      else if (child.nodeName === 'BR') out.push({ node: child, text: '\n' });
      else {
        if ((child.nodeName === 'DIV' || child.nodeName === 'P') && out.length) {
          out.push({ node: child, text: '\n' });
        }
        visit(child);
      }
    }
  };
  visit(root);
  return out;
}

/** The box's text and the caret's place in it; undefined unless a bare caret is in the box. */
export function caretText(root: HTMLElement): { text: string; caret: number } | undefined {
  const selection = window.getSelection();
  const node = selection?.focusNode;
  if (!selection || !node || !selection.isCollapsed || !root.contains(node)) return undefined;
  const range = document.createRange();
  range.setStart(node, selection.focusOffset);
  let text = '';
  let caret: number | undefined;
  for (const piece of pieces(root)) {
    if (caret === undefined) {
      if (piece.node === node) caret = text.length + selection.focusOffset;
      else if (range.comparePoint(piece.node, 0) >= 0) caret = text.length;
    }
    text += piece.text;
  }
  return { text, caret: caret ?? text.length };
}

/**
 * Selects from `start` in the box's text to the caret, so typing replaces just that span; false
 * when `start` doesn't fall in a text node.
 */
export function selectBack(root: HTMLElement, start: number): boolean {
  const selection = window.getSelection();
  const node = selection?.focusNode;
  if (!selection || !node) return false;
  let at = 0;
  for (const piece of pieces(root)) {
    const end = at + piece.text.length;
    if (piece.node.nodeType === Node.TEXT_NODE && start >= at && start < end) {
      const range = document.createRange();
      range.setStart(piece.node, start - at);
      range.setEnd(node, selection.focusOffset);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }
    at = end;
  }
  return false;
}
