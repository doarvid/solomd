/**
 * Typora-style editing commands (bug/B4 section 七): select word, delete
 * word, select line, and heading level up / down / back to a paragraph.
 *
 * Same contract as lib/md-format.ts: pure text in, one edit (or one range)
 * out. SoloMD runs three editors — CodeMirror, and on Windows the plain block
 * editor and the plain flat editor — and a command written against one of
 * them is silently dead in the other two (IK6JCC, #316). So *what* changes is
 * decided here, and Editor.vue only reads the selection and applies the
 * result on each path.
 */

export type EditorCommand =
  | 'selectWord'
  | 'deleteWord'
  | 'selectLine'
  | 'jumpToSelection'
  | 'headingPromote'
  | 'headingDemote'
  | 'headingParagraph';

export const EDITOR_COMMANDS: EditorCommand[] = [
  'selectWord',
  'deleteWord',
  'selectLine',
  'jumpToSelection',
  'headingPromote',
  'headingDemote',
  'headingParagraph',
];

/** Commands that change the text (the rest only move the selection). */
export const EDITING_COMMANDS = new Set<EditorCommand>([
  'deleteWord',
  'headingPromote',
  'headingDemote',
  'headingParagraph',
]);

/** Commands that only make sense in a Markdown document. */
export const MARKDOWN_ONLY_COMMANDS = new Set<EditorCommand>([
  'headingPromote',
  'headingDemote',
  'headingParagraph',
]);

export interface Range {
  from: number;
  to: number;
}

export interface TextEdit {
  /** Replace `doc[from, to)` with `insert`… */
  from: number;
  to: number;
  insert: string;
  /** …then select this range (offsets in the *new* document). */
  selFrom: number;
  selTo: number;
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;

interface Segment {
  from: number;
  to: number;
  word: boolean;
}

/**
 * Word segments of one line. `Intl.Segmenter` knows where Chinese and
 * Japanese words end (there are no spaces to go by), so ⌘D on 中文输入法
 * selects 输入法 rather than the whole clause. Engines without it fall back
 * to runs of letters/digits.
 */
function segmentLine(line: string): Segment[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => {
    segment(s: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }>;
  } }).Segmenter;
  if (Seg) {
    const out: Segment[] = [];
    for (const s of new Seg(undefined, { granularity: 'word' }).segment(line)) {
      out.push({ from: s.index, to: s.index + s.segment.length, word: !!s.isWordLike });
    }
    return out;
  }
  const out: Segment[] = [];
  let i = 0;
  while (i < line.length) {
    const word = WORD_CHAR.test(line[i]);
    let j = i + 1;
    while (j < line.length && WORD_CHAR.test(line[j]) === word) j++;
    out.push({ from: i, to: j, word });
    i = j;
  }
  return out;
}

function lineBounds(doc: string, pos: number): Range {
  const from = doc.lastIndexOf('\n', pos - 1) + 1;
  let to = doc.indexOf('\n', pos);
  if (to < 0) to = doc.length;
  return { from, to };
}

/**
 * The word under the caret (or the words a selection touches). A caret right
 * after a word — the usual place after typing it — takes that word; a caret
 * between two non-word characters has no word and returns null.
 */
export function wordRangeAt(doc: string, from: number, to: number = from): Range | null {
  const line = lineBounds(doc, from);
  const segs = segmentLine(doc.slice(line.from, line.to)).map((s) => ({
    from: s.from + line.from,
    to: s.to + line.from,
    word: s.word,
  }));
  const words = segs.filter((s) => s.word);
  if (!words.length) return null;
  if (from !== to) {
    const end = Math.min(to, line.to);
    const touched = words.filter((w) => w.to > from && w.from < end);
    if (!touched.length) return null;
    return { from: Math.min(from, touched[0].from), to: Math.max(end, touched[touched.length - 1].to) };
  }
  const inside = words.find((w) => from > w.from && from < w.to);
  if (inside) return { from: inside.from, to: inside.to };
  const after = words.find((w) => w.from === from);
  if (after) return { from: after.from, to: after.to };
  const before = words.find((w) => w.to === from);
  if (before) return { from: before.from, to: before.to };
  return null;
}

/** Select the word under the caret. Null when there is none. */
export function selectWord(doc: string, from: number, to: number = from): Range | null {
  return wordRangeAt(doc, from, to);
}

/**
 * Delete the word under the caret (or the words the selection touches). One
 * of the spaces around it goes too, so "a word here" becomes "a here", not
 * "a  here". Null when there is no word to delete.
 */
export function deleteWord(doc: string, from: number, to: number = from): TextEdit | null {
  const r = wordRangeAt(doc, from, to);
  if (!r) return null;
  let { from: s, to: e } = r;
  if (doc[e] === ' ' && (s === 0 || doc[s - 1] === ' ' || doc[s - 1] === '\n')) e += 1;
  else if (doc[s - 1] === ' ' && (e === doc.length || doc[e] === '\n' || /[\s.,;:!?)\]]/.test(doc[e]))) s -= 1;
  return { from: s, to: e, insert: '', selFrom: s, selTo: s };
}

/**
 * Select the line the caret is on (without its line break). Pressed again on
 * a selection that already spans whole lines, it takes the next line too —
 * so holding the chord grows the selection line by line, as in Typora.
 */
export function selectLine(doc: string, from: number, to: number = from): Range {
  const first = lineBounds(doc, from);
  const last = lineBounds(doc, Math.max(from, to));
  const wholeLines = from === first.from && to === last.to && to > from;
  if (wholeLines && last.to < doc.length) {
    const next = lineBounds(doc, last.to + 1);
    return { from: first.from, to: next.to };
  }
  return { from: first.from, to: last.to };
}

const HEADING = /^( {0,3})(#{1,6})([ \t]+|$)/;
const NOT_PARAGRAPH = /^\s*(?:[-*+]\s|\d+[.)]\s|>|\||```|~~~|<|\$\$|---\s*$|\*\*\*\s*$|___\s*$)/;

/** Which lines sit inside a fenced code block (so ⌘= there does nothing). */
function fencedLines(lines: string[]): boolean[] {
  const out: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(true);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.trim().slice(m[1].length).trim()) {
        fence = null;
      }
    } else if (m) {
      out.push(true);
      fence = m[1];
    } else {
      out.push(false);
    }
  }
  return out;
}

/**
 * Change the heading level of every line the selection touches.
 *
 * - `promote` (Typora ⌘=): H3 → H2 … H1 stays; a plain paragraph becomes H6.
 * - `demote`  (Typora ⌘-): H2 → H3 … H6 becomes a paragraph again.
 * - `paragraph` (Typora ⌘0): drop the heading marker.
 *
 * Promote and demote are inverses, so one key undoes the other. Lists,
 * quotes, tables, fences and blank lines are left alone — turning a list item
 * into a heading is never what the chord meant. Null when nothing changes.
 */
export function shiftHeading(
  doc: string,
  from: number,
  to: number,
  mode: 'promote' | 'demote' | 'paragraph',
): TextEdit | null {
  const start = lineBounds(doc, from).from;
  const end = lineBounds(doc, Math.max(from, to)).to;
  const allLines = doc.split('\n');
  const fenced = fencedLines(allLines);
  // Index of the first touched line.
  let firstIdx = 0;
  for (let i = 0, off = 0; i < allLines.length; i++) {
    if (off === start) { firstIdx = i; break; }
    off += allLines[i].length + 1;
  }
  const touched = doc.slice(start, end).split('\n');
  let changed = false;
  const out = touched.map((line, k) => {
    if (fenced[firstIdx + k]) return line;
    const m = HEADING.exec(line);
    let next = line;
    if (m) {
      const level = m[2].length;
      const rest = line.slice(m[0].length);
      if (mode === 'paragraph' || (mode === 'demote' && level === 6)) next = m[1] + rest;
      else if (mode === 'promote') next = level > 1 ? `${m[1]}${'#'.repeat(level - 1)} ${rest}` : line;
      else next = `${m[1]}${'#'.repeat(level + 1)} ${rest}`;
    } else if (mode === 'promote' && line.trim() && !NOT_PARAGRAPH.test(line)) {
      next = `###### ${line.replace(/^ {0,3}/, '')}`;
    }
    if (next !== line) changed = true;
    return next;
  });
  if (!changed) return null;
  return { from: start, to: end, insert: out.join('\n'), ...mapSelection(touched, out, start, from, to) };
}

/** Map selection ends through per-line marker rewrites (line count is fixed). */
function mapSelection(
  before: string[],
  after: string[],
  start: number,
  from: number,
  to: number,
): { selFrom: number; selTo: number } {
  const map = (p: number): number => {
    let oldOff = start;
    let newOff = start;
    for (let i = 0; i < before.length; i++) {
      const a = before[i];
      const b = after[i];
      if (p <= oldOff + a.length) {
        const col = p - oldOff;
        // The line start stays the line start (a selection of whole lines
        // keeps covering them).
        if (a === b || col === 0) return newOff + col;
        // Content after the marker keeps its place relative to the line end.
        const fromEnd = a.length - col;
        return newOff + Math.max(contentStart(b), b.length - fromEnd);
      }
      oldOff += a.length + 1;
      newOff += b.length + 1;
    }
    return newOff + (p - oldOff);
  };
  return { selFrom: map(from), selTo: map(to) };
}

function contentStart(line: string): number {
  const m = HEADING.exec(line);
  return m ? m[0].length : line.length - line.trimStart().length;
}
