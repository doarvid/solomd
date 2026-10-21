/**
 * Paragraph math for the Windows live editor (the plain block editor in
 * Editor.vue): Ctrl+↑/↓, Ctrl+Home/End and triple-click work across blocks
 * there, so the "where is the next paragraph" rule has to live outside the
 * textarea, which only ever sees one block.
 *
 * A paragraph is a non-blank block — a heading, a paragraph, a table, a fenced
 * code block — except that every item of a list is a paragraph of its own, as
 * in Typora and Word. Offsets are document offsets; a block is `{ start, text }`
 * with `text` excluding the separating newline (splitPlainMarkdownBlocks).
 */

export interface NavBlock {
  start: number;
  text: string;
}

const LIST_ITEM = /^[ \t]*([-+*]|\d+[.)])[ \t]+/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,}|\$\$)/;

/** Offsets (relative to the block) where paragraphs start inside one block. */
export function paragraphStartsInBlock(text: string): number[] {
  if (text.trim() === '') return [];
  const starts = [0];
  // A fenced block (code, maths) is one paragraph whatever its lines look like.
  if (FENCE.test(text)) return starts;
  let pos = 0;
  let first = true;
  for (const line of text.split('\n')) {
    if (!first && LIST_ITEM.test(line)) starts.push(pos);
    first = false;
    pos += line.length + 1;
  }
  return starts;
}

/** Every paragraph start in the document, ascending. */
export function docParagraphStarts(blocks: readonly NavBlock[]): number[] {
  const out: number[] = [];
  for (const b of blocks) {
    for (const s of paragraphStartsInBlock(b.text)) out.push(b.start + s);
  }
  return out;
}

/**
 * Ctrl+↑: the start of the paragraph the caret is in, or — when it is already
 * there — of the previous one. The document start when there is none.
 */
export function prevParagraphStart(starts: readonly number[], pos: number): number {
  let best = 0;
  for (const s of starts) {
    if (s < pos) best = s;
    else break;
  }
  return best;
}

/** Ctrl+↓: the start of the next paragraph, or `end` after the last one. */
export function nextParagraphStart(starts: readonly number[], pos: number, end: number): number {
  for (const s of starts) if (s > pos) return s;
  return Math.max(pos, end);
}

/**
 * Triple-click: the paragraph around `pos` inside one block's text — the list
 * item (with its continuation lines) in a list, one line in a fenced block
 * (as code editors do), otherwise the whole block. `to` excludes the newline.
 */
export function paragraphRangeInBlock(text: string, pos: number): { from: number; to: number } {
  const p = Math.max(0, Math.min(pos, text.length));
  if (FENCE.test(text)) {
    const from = text.lastIndexOf('\n', p - 1) + 1;
    const nl = text.indexOf('\n', p);
    return { from, to: nl < 0 ? text.length : nl };
  }
  const starts = paragraphStartsInBlock(text);
  if (starts.length <= 1) return { from: 0, to: text.length };
  let i = 0;
  while (i + 1 < starts.length && starts[i + 1] <= p) i++;
  const from = starts[i];
  const to = i + 1 < starts.length ? starts[i + 1] - 1 : text.length;
  return { from, to };
}

/** The selection anchor and head of a textarea-style range. */
export function selectionEnds(
  start: number,
  end: number,
  direction: string | null | undefined,
): { anchor: number; head: number } {
  return direction === 'backward' ? { anchor: end, head: start } : { anchor: start, head: end };
}
