/**
 * Spelling suggestions for the editor's own right-click menu (#376).
 *
 * On Windows the editor shows its own context menu (#210), which replaced the
 * WebView2 menu — and with it the spelling suggestions that menu offered for
 * an underlined word. Neither the native spell checker's verdict nor its
 * suggestions are reachable from JavaScript, so the menu asks the bundled
 * Hunspell dictionary instead (`spellcheck_check` / `spellcheck_suggest`, the
 * same backend as the CodeMirror underline in `cm-spellcheck.ts`).
 *
 * Shared by every editor path: CodeMirror and both Windows textarea editors
 * find the word under the pointer themselves and hand its line text here.
 */
import { invoke } from '@tauri-apps/api/core';

/** Same word shape as the Rust side (`WORD_RE` in spellcheck.rs). */
const WORD_RE = /[A-Za-z][A-Za-z'-]*/g;

export interface WordSpan {
  word: string;
  from: number;
  to: number;
}

/**
 * The Latin word touching `offset` in `text` (offsets in UTF-16 units), with
 * leading/trailing apostrophes and hyphens trimmed. A word that starts or ends
 * exactly at `offset` counts, preferring the one the offset is inside.
 */
export function wordAt(text: string, offset: number): WordSpan | null {
  let edge: WordSpan | null = null;
  WORD_RE.lastIndex = 0;
  for (let m = WORD_RE.exec(text); m; m = WORD_RE.exec(text)) {
    let from = m.index;
    let to = from + m[0].length;
    while (to > from && /['-]/.test(text[to - 1])) to--;
    if (from > offset) break;
    if (offset > to) continue;
    const span = { word: text.slice(from, to), from, to };
    if (offset < to) return span;
    edge = span;
  }
  return edge;
}

let loadedFor: string | null = null;
let loading: Promise<boolean> | null = null;
let loadingFor: string | null = null;

/** Load the Hunspell dictionary for `lang` once; later calls are free. */
export function ensureSpellDict(lang: string): Promise<boolean> {
  const l = lang || 'en_US';
  if (loadedFor === l) return Promise.resolve(true);
  if (loading && loadingFor === l) return loading;
  loadingFor = l;
  loading = invoke('spellcheck_init', { lang: l })
    .then(() => {
      loadedFor = l;
      return true;
    })
    .catch((e) => {
      console.warn('spellcheck_init failed', e);
      return false;
    })
    .finally(() => {
      if (loadingFor === l) {
        loading = null;
        loadingFor = null;
      }
    });
  return loading;
}

export interface SpellLookup {
  word: string;
  from: number;
  to: number;
  suggestions: string[];
}

/**
 * Check the word at `offset` in `text`. Returns null when there is no word
 * there, the dictionary can't be loaded, or the word is spelled correctly —
 * in all of those cases the menu stays exactly as it was.
 */
export async function lookupMisspelling(
  text: string,
  offset: number,
  lang: string,
): Promise<SpellLookup | null> {
  const span = wordAt(text, offset);
  if (!span || span.word.length < 2) return null;
  if (!(await ensureSpellDict(lang))) return null;
  try {
    const misses = await invoke<unknown[]>('spellcheck_check', { text: span.word });
    if (!Array.isArray(misses) || misses.length === 0) return null;
    const suggestions = await invoke<string[]>('spellcheck_suggest', { word: span.word });
    return { ...span, suggestions: (suggestions ?? []).slice(0, 5) };
  } catch {
    return null;
  }
}

/** Fired after a word is added to the personal dictionary, so the CodeMirror
 *  underline drops its cached verdicts and re-checks. */
export const SPELL_DICT_CHANGED_EVENT = 'solomd:spell-dict-changed';

/** Fired when whether Hunspell should underline at all may have changed —
 *  LanguageTool took over spelling, or its server went away. */
export const SPELL_RECHECK_EVENT = 'solomd:spellcheck-recheck';

export async function addToSpellDict(word: string): Promise<void> {
  await invoke('spellcheck_add_to_dict', { word });
  window.dispatchEvent(new CustomEvent(SPELL_DICT_CHANGED_EVENT, { detail: { word } }));
}
