/**
 * Double-click on Chinese / Japanese / Korean text selects a word, not the
 * whole run between two punctuation marks.
 *
 * CodeMirror's built-in double-click groups characters by its char
 * categorizer, which files every CJK ideograph under "word" — so with no
 * spaces to break on, double-clicking 这是 in 这是一句中文。selects
 * 这是一句中文. The ⌘D / "Select Word" command already segments with
 * `Intl.Segmenter` (lib/editor-commands.ts `wordRangeAt`); this style makes
 * the mouse agree with it. Only double-clicks that land on CJK take this path;
 * everything else (Latin words, punctuation, modified clicks) falls through to
 * CodeMirror's default handling, unchanged.
 */

import { EditorView } from '@codemirror/view';
import { EditorSelection, type EditorState } from '@codemirror/state';
import { wordRangeAt } from './editor-commands';

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

interface Range {
  from: number;
  to: number;
}

/** The CJK word covering the character at `charPos`, in doc offsets. */
export function cjkWordAt(state: EditorState, charPos: number): Range | null {
  if (charPos < 0 || charPos >= state.doc.length) return null;
  const line = state.doc.lineAt(charPos);
  if (charPos >= line.to) return null;
  const off = charPos - line.from;
  const r = wordRangeAt(line.text, off, off + 1);
  if (!r) return null;
  const text = line.text.slice(r.from, r.to);
  if (!CJK.test(text)) return null;
  return { from: r.from + line.from, to: r.to + line.from };
}

/**
 * `posAtCoords` snaps to the nearest character boundary, so a press on the
 * right half of a glyph returns the position after it. Recover the glyph the
 * pointer is actually over.
 */
function charAtCoords(view: EditorView, x: number, y: number): number | null {
  const pos = view.posAtCoords({ x, y });
  if (pos == null) return null;
  const line = view.state.doc.lineAt(pos);
  if (pos > line.from) {
    const after = view.coordsAtPos(pos, 1);
    if (pos >= line.to || (after && x < after.left)) return pos - 1;
  }
  return pos;
}

export function cjkDoubleClickSelection() {
  return EditorView.mouseSelectionStyle.of((view, event) => {
    if (event.button !== 0 || event.detail !== 2) return null;
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return null;
    const c = charAtCoords(view, event.clientX, event.clientY);
    if (c == null) return null;
    let anchor = cjkWordAt(view.state, c);
    if (!anchor) return null;
    return {
      get(cur: MouseEvent) {
        const hc = charAtCoords(view, cur.clientX, cur.clientY);
        if (hc == null || (hc >= anchor!.from && hc < anchor!.to)) {
          return EditorSelection.single(anchor!.from, anchor!.to);
        }
        // Dragging after the double-click extends by whole words where the
        // pointer is over one, by characters elsewhere.
        const w = cjkWordAt(view.state, hc);
        if (hc < anchor!.from) return EditorSelection.single(anchor!.to, w ? w.from : hc);
        return EditorSelection.single(anchor!.from, w ? w.to : hc + 1);
      },
      update(update) {
        if (update.docChanged) {
          anchor = {
            from: update.changes.mapPos(anchor!.from, 1),
            to: update.changes.mapPos(anchor!.to, -1),
          };
        }
        return false;
      },
    };
  });
}
