/**
 * "You just typed that by hand — there is a key for it."
 *
 * A tour teaches shortcuts before anyone needs them and is forgotten by the
 * time they do. This notices the moment someone finishes typing a piece of
 * Markdown formatting themselves, which is the one moment the shortcut for it
 * is interesting. Each kind is mentioned once, ever.
 *
 * Pure: the line up to the caret and the character just typed go in, the
 * formatting command that would have done it comes out. Only a *completed*
 * construct counts (`**word**`, not `**`), so nothing fires half-way through.
 */
import type { FormatKind } from './md-format';

export function detectTypedFormat(lineBeforeCaret: string, typed: string): FormatKind | null {
  const s = lineBeforeCaret;
  switch (typed) {
    case '*':
      if (/(^|[^*])\*\*[^*\s](?:[^*]*[^*\s])?\*\*$/.test(s)) return 'bold';
      if (/(^|[^*])\*[^*\s](?:[^*]*[^*\s])?\*$/.test(s)) return 'italic';
      return null;
    case '~':
      return /(^|[^~])~~[^~\s](?:[^~]*[^~\s])?~~$/.test(s) ? 'strike' : null;
    case '=':
      return /(^|[^=])==[^=\s](?:[^=]*[^=\s])?==$/.test(s) ? 'highlight' : null;
    case '`':
      if (/^\s*```$/.test(s)) return 'codeblock';
      return /(^|[^`])`[^`\s](?:[^`]*[^`\s])?`$/.test(s) ? 'code' : null;
    case '(':
      return /\[[^\]\n]+\]\($/.test(s) ? 'link' : null;
    case ' ': {
      const h = /^\s{0,3}(#{1,6}) $/.exec(s);
      if (h) return `h${h[1].length}` as FormatKind;
      if (/^\s*[-*+] \[[ xX]?\] $/.test(s)) return 'task';
      if (/^\s*> $/.test(s)) return 'quote';
      if (/^\s*[-*+] $/.test(s)) return 'ul';
      if (/^\s*\d+[.)] $/.test(s)) return 'ol';
      return null;
    }
    default:
      return null;
  }
}

/** Headings are one lesson, not six. */
export function hintKey(kind: FormatKind): string {
  return /^h[1-6]$/.test(kind) ? 'heading' : kind;
}
