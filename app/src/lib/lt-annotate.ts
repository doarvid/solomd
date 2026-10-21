/**
 * Markdown → LanguageTool AnnotatedText.
 *
 * LanguageTool accepts `data={"annotation":[{text}, {markup, interpretAs}]}`:
 * `text` is checked, `markup` is skipped (but `interpretAs` is fed to the
 * checker in its place, so `` `npm` `` inside a sentence still reads as a
 * word). Markup *does* count toward the offsets LanguageTool returns, which
 * is the whole point: as long as the segments of a block add up to its source
 * text, a match offset is simply `block.from + offset`.
 *
 * Blocks come from the Lezer Markdown tree the editor already has
 * (`@codemirror/lang-markdown` with GFM). We check prose leaves only —
 * paragraphs, headings, list/task items, blockquote contents, table cells —
 * and skip code, HTML blocks, link reference definitions and YAML front
 * matter. Inside a block, Lezer's syntax marks (`**`, `[`, `](url)`, `#`, …)
 * become markup, and a regex pass covers what the parser doesn't know about:
 * wikilinks, `$math$`, footnote refs, `#tags`, and soft line breaks.
 *
 * Pure: no CodeMirror state, no Tauri — tested in `lt-annotate.test.ts`
 * against `@lezer/markdown` directly.
 */
import type { syntaxTree } from '@codemirror/language';

// `@lezer/common` isn't a direct dependency (pnpm keeps it out of reach), so
// take its types from the CodeMirror API that hands us the tree.
type Tree = ReturnType<typeof syntaxTree>;
type SyntaxNode = Tree['topNode'];

export interface LtSegment {
  text?: string;
  markup?: string;
  interpretAs?: string;
}

export interface LtBlock {
  /** Document offset of the block's first character. */
  from: number;
  to: number;
  /** Source text of the block (`doc.slice(from, to)`) — also the cache key. */
  source: string;
  /** Segments whose text/markup concatenate to exactly `source`. */
  segments: LtSegment[];
}

/** Placeholder LanguageTool sees for code / math / links it shouldn't check —
 *  a noun that exists in most languages, so sentences stay grammatical. */
export const PLACEHOLDER = 'Dummy';

const LEAF_BLOCKS = new Set([
  'Paragraph',
  'ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4', 'ATXHeading5', 'ATXHeading6',
  'SetextHeading1', 'SetextHeading2',
  'Task',
  'TableCell',
]);
const CONTAINERS = new Set([
  'Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem',
  'Table', 'TableHeader', 'TableRow',
]);

/** Syntax marks: markup, children (none) irrelevant. */
const MARK_NODES = new Set([
  'EmphasisMark', 'StrikethroughMark', 'LinkMark', 'URL', 'LinkTitle', 'LinkLabel',
  'HeaderMark', 'QuoteMark', 'ListMark', 'TaskMarker', 'HTMLTag', 'Comment',
  'ProcessingInstruction', 'TableDelimiter', 'CodeInfo',
]);
/** Whole node is markup, read as a placeholder word. */
const OPAQUE_NODES = new Map<string, string>([
  ['InlineCode', PLACEHOLDER],
  ['Autolink', PLACEHOLDER],
  ['Image', PLACEHOLDER],
]);
const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
};

interface Range {
  from: number; // block-relative
  to: number;
  interpretAs?: string;
}

/** End offset of a leading YAML front matter block (`---` … `---`), else 0. */
export function frontMatterEnd(doc: string): number {
  if (!/^---[ \t]*\r?\n/.test(doc)) return 0;
  const close = /\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/g;
  close.lastIndex = 3;
  const m = close.exec(doc);
  return m ? m.index + m[0].length : 0;
}

/** `lang:` / `language:` from the front matter, normalised to a LanguageTool
 *  code (`de_de` → `de-DE`, `en` → `en`). Null when absent. */
export function frontMatterLanguage(doc: string): string | null {
  const end = frontMatterEnd(doc);
  if (!end) return null;
  const m = /^(?:lang|language)[ \t]*:[ \t]*["']?([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*|auto)["']?[ \t]*$/m.exec(
    doc.slice(0, end),
  );
  if (!m) return null;
  const [lang, ...rest] = m[1].split(/[-_]/);
  if (lang.toLowerCase() === 'auto') return 'auto';
  return [lang.toLowerCase(), ...rest.map((p) => (p.length === 2 ? p.toUpperCase() : p))].join('-');
}

function collectSyntaxMarkup(node: SyntaxNode, base: number, out: Range[], source: string) {
  for (let ch = node.firstChild; ch; ch = ch.nextSibling) {
    const from = ch.from - base;
    const to = ch.to - base;
    const opaque = OPAQUE_NODES.get(ch.name);
    if (opaque !== undefined) {
      out.push({ from, to, interpretAs: opaque });
    } else if (MARK_NODES.has(ch.name)) {
      out.push({ from, to });
    } else if (ch.name === 'Escape') {
      out.push({ from, to: from + 1 }); // the backslash; keep the escaped char
    } else if (ch.name === 'Entity') {
      out.push({ from, to, interpretAs: ENTITIES[source.slice(from, to)] ?? '' });
    } else if (ch.name === 'HardBreak') {
      out.push({ from, to, interpretAs: ' ' });
    } else {
      collectSyntaxMarkup(ch, base, out, source);
    }
  }
}

const RE_NEWLINE = /\r?\n[ \t>]*/g;
const RE_WIKILINK = /\[\[([^\]|\n]+)(\|[^\]\n]*)?\]\]/g;
const RE_MATH_BLOCK = /\$\$[\s\S]+?\$\$/g;
const RE_MATH_INLINE = /(?<![\\$\w])\$(?=\S)[^$\n]*?\S\$(?![\d$])|(?<![\\$\w])\$\S\$(?![\d$])/g;
const RE_FOOTNOTE = /\[\^[^\]\s]+\]/g;
const RE_TAG = /(?<![\p{L}\p{N}_&/#])#(?=[\p{L}\p{N}_/-]*\p{L})[\p{L}\p{N}_/-]+/gu;

function collectRegexMarkup(source: string, out: Range[]) {
  const each = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    re.lastIndex = 0;
    for (let m = re.exec(source); m; m = re.exec(source)) fn(m);
  };
  // Order matters: later ranges overwrite earlier ones.
  each(RE_NEWLINE, (m) => out.push({ from: m.index, to: m.index + m[0].length, interpretAs: ' ' }));
  each(RE_TAG, (m) => out.push({ from: m.index, to: m.index + m[0].length, interpretAs: PLACEHOLDER }));
  each(RE_FOOTNOTE, (m) => out.push({ from: m.index, to: m.index + m[0].length, interpretAs: '' }));
  each(RE_MATH_INLINE, (m) => out.push({ from: m.index, to: m.index + m[0].length, interpretAs: PLACEHOLDER }));
  each(RE_MATH_BLOCK, (m) => out.push({ from: m.index, to: m.index + m[0].length, interpretAs: PLACEHOLDER }));
  each(RE_WIKILINK, (m) => {
    const start = m.index;
    const end = start + m[0].length;
    if (m[2] && m[2].length > 1) {
      // `[[target|alias]]` — the alias is prose the reader sees.
      const aliasFrom = start + 2 + m[1].length + 1;
      out.push({ from: start, to: aliasFrom });
      out.push({ from: end - 2, to: end });
    } else {
      out.push({ from: start, to: end, interpretAs: PLACEHOLDER });
    }
  });
}

/** Turn markup ranges over `source` into AnnotatedText segments. Later ranges
 *  win where they overlap; `interpretAs` is emitted once per range. */
export function segmentsFor(source: string, ranges: Range[]): LtSegment[] {
  const owner = new Int32Array(source.length).fill(-1);
  ranges.forEach((r, i) => {
    const from = Math.max(0, r.from);
    const to = Math.min(source.length, r.to);
    for (let p = from; p < to; p++) owner[p] = i;
  });
  const out: LtSegment[] = [];
  const emitted = new Set<number>();
  let start = 0;
  for (let p = 1; p <= source.length; p++) {
    if (p < source.length && owner[p] === owner[start]) continue;
    const id = owner[start];
    const piece = source.slice(start, p);
    if (id < 0) {
      out.push({ text: piece });
    } else {
      const seg: LtSegment = { markup: piece };
      const ia = ranges[id].interpretAs;
      if (ia !== undefined && !emitted.has(id)) {
        seg.interpretAs = ia;
        emitted.add(id);
      }
      out.push(seg);
    }
    start = p;
  }
  return out;
}

/** True when a block has something worth sending (letters outside markup). */
export function hasProse(segments: LtSegment[]): boolean {
  return segments.some((s) => s.text !== undefined && /\p{L}/u.test(s.text));
}

/**
 * Prose blocks of `tree` that intersect `[from, to]`, in document order.
 * `slice(a, b)` returns document text (CodeMirror: `state.sliceDoc`).
 * `skipBefore` drops blocks starting before it — pass `frontMatterEnd(doc)`.
 */
export function collectBlocks(
  tree: Tree,
  slice: (from: number, to: number) => string,
  from: number,
  to: number,
  skipBefore = 0,
): LtBlock[] {
  const blocks: LtBlock[] = [];
  tree.iterate({
    from,
    to,
    enter(n) {
      if (CONTAINERS.has(n.name)) return true;
      if (LEAF_BLOCKS.has(n.name) && n.from >= skipBefore && n.to > n.from) {
        const source = slice(n.from, n.to);
        const ranges: Range[] = [];
        collectSyntaxMarkup(n.node, n.from, ranges, source);
        collectRegexMarkup(source, ranges);
        const segments = segmentsFor(source, ranges);
        if (hasProse(segments)) blocks.push({ from: n.from, to: n.to, source, segments });
      }
      return false;
    },
  });
  return blocks;
}

/** Separator between blocks batched into one request. Real characters (not
 *  zero-length markup) so offsets stay plain sums of segment lengths. */
export const BLOCK_SEPARATOR: LtSegment = { markup: '\n\n', interpretAs: '\n\n' };

export interface LtBatch {
  blocks: LtBlock[];
  /** Annotation offset of each block's first character. */
  starts: number[];
  annotation: LtSegment[];
}

/** Pack blocks into requests of at most `maxChars` source characters (a
 *  single larger block still gets its own request). */
export function packBatches(blocks: LtBlock[], maxChars: number): LtBatch[] {
  const batches: LtBatch[] = [];
  let cur: LtBatch | null = null;
  let size = 0;
  for (const b of blocks) {
    if (!cur || (size > 0 && size + b.source.length > maxChars)) {
      cur = { blocks: [], starts: [], annotation: [] };
      batches.push(cur);
      size = 0;
    }
    if (cur.blocks.length) {
      cur.annotation.push(BLOCK_SEPARATOR);
      size += BLOCK_SEPARATOR.markup!.length;
    }
    cur.starts.push(size);
    cur.blocks.push(b);
    cur.annotation.push(...b.segments);
    size += b.source.length;
  }
  return batches;
}

/** Index of the block in `batch` that fully contains `[offset, offset+length)`,
 *  or -1 (a match straddling a separator is dropped). */
export function blockIndexFor(batch: LtBatch, offset: number, length: number): number {
  for (let i = 0; i < batch.blocks.length; i++) {
    const start = batch.starts[i];
    const end = start + batch.blocks[i].source.length;
    if (offset >= start && offset + length <= end) return i;
  }
  return -1;
}
