/**
 * LanguageTool glue between the settings store, the Rust commands
 * (`src-tauri/src/languagetool.rs`) and the CodeMirror plugin
 * (`cm-languagetool.ts`).
 *
 * Also owns the shared, cross-editor state: server health (`ltHealth`, which
 * decides whether Hunspell steps back), session-only "ignore" choices, and
 * the user-action flows the hover tooltip and the Windows context menu share.
 */
import { invoke } from '@tauri-apps/api/core';
import { ref } from 'vue';
import { useSettingsStore, LT_SETTINGS_CHANGED_EVENT, type LtMode } from '../stores/settings';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';
import { addToSpellDict, ensureSpellDict, SPELL_RECHECK_EVENT } from './spell-suggest';
import type { LtSegment } from './lt-annotate';

export interface LtMatch {
  offset: number;
  length: number;
  message: string;
  shortMessage: string;
  replacements: string[];
  ruleId: string;
  ruleDescription: string;
  categoryId: string;
  issueType: string;
}

export interface LtCheckResponse {
  matches: LtMatch[];
  language: string;
}

export interface LtWireConfig {
  mode: Exclude<LtMode, 'off'>;
  baseUrl?: string;
  username?: string;
}

export interface LtLanguage {
  name: string;
  code: string;
  longCode: string;
}

export interface LtStatus {
  ok: boolean;
  languages: LtLanguage[];
  error: string | null;
}

/** Everything a check depends on. `signature` keys the per-block cache. */
export interface LtRuntimeConfig {
  wire: LtWireConfig;
  language: string;
  motherTongue: string;
  preferredVariants: string;
  level: 'default' | 'picky';
  disabledRules: string[];
  wholeDoc: boolean;
  /** Max characters per request: the free API caps request size hard. */
  batchChars: number;
  signature: string;
}

export type LtErrorCode =
  | 'unreachable'
  | 'auth'
  | 'no-credentials'
  | 'rate-limited'
  | 'too-large'
  | 'http';

/** Re-exported so callers only need this module. */
export { LT_SETTINGS_CHANGED_EVENT };

/** Fired when session-only state (ignores, accepted words) changes and
 *  decorations need a redraw without new requests. */
export const LT_REDRAW_EVENT = 'solomd:languagetool-redraw';

export function ltEnabled(): boolean {
  return useSettingsStore().ltMode !== 'off';
}

export function wireConfig(): LtWireConfig | null {
  const s = useSettingsStore();
  if (s.ltMode === 'off') return null;
  return {
    mode: s.ltMode,
    baseUrl: s.ltMode === 'local' ? s.ltLocalUrl : undefined,
    username: s.ltMode === 'premium' ? s.ltUsername : undefined,
  };
}

/** Runtime config for a document; `docLanguage` (front matter `lang:`) wins
 *  over the global language. */
export function runtimeConfig(docLanguage: string | null): LtRuntimeConfig | null {
  const s = useSettingsStore();
  const wire = wireConfig();
  if (!wire) return null;
  const language = docLanguage || s.ltLanguage || 'auto';
  const cfg = {
    wire,
    language,
    motherTongue: s.ltMotherTongue.trim(),
    preferredVariants: s.ltPreferredVariants.trim(),
    level: s.ltLevel,
    disabledRules: [...s.ltDisabledRules],
    wholeDoc: s.ltCheckWholeDoc,
    batchChars: wire.mode === 'public' ? 6000 : 20000,
  };
  return { ...cfg, signature: JSON.stringify(cfg) };
}

export async function ltCheck(annotation: LtSegment[], cfg: LtRuntimeConfig): Promise<LtCheckResponse> {
  return invoke<LtCheckResponse>('languagetool_check', {
    req: {
      config: cfg.wire,
      annotation,
      language: cfg.language,
      motherTongue: cfg.motherTongue || null,
      preferredVariants: cfg.preferredVariants || null,
      level: cfg.level,
      disabledRules: cfg.disabledRules,
    },
  });
}

export function ltDetect(config: LtWireConfig): Promise<LtStatus> {
  return invoke<LtStatus>('languagetool_detect', { config });
}

export function ltErrorCode(err: unknown): LtErrorCode {
  const m = /^lt:([a-z-]+)/.exec(String(err));
  const code = m?.[1] as LtErrorCode | undefined;
  return code && ['unreachable', 'auth', 'no-credentials', 'rate-limited', 'too-large', 'http'].includes(code)
    ? code
    : 'http';
}

export function ltErrorMessage(err: unknown): string {
  const { t } = useI18n();
  const code = ltErrorCode(err);
  const key = {
    unreachable: 'languagetool.errUnreachable',
    auth: 'languagetool.errAuth',
    'no-credentials': 'languagetool.errNoCredentials',
    'rate-limited': 'languagetool.errRateLimited',
    'too-large': 'languagetool.errTooLarge',
    http: 'languagetool.errHttp',
  }[code];
  return t(key, { detail: String(err).replace(/^lt:[a-z-]+:?\s*/, '') });
}

// ---------------------------------------------------------------------------
// Health — shared by every open editor
// ---------------------------------------------------------------------------

export type LtHealth = 'unknown' | 'ok' | 'error';
export const ltHealth = ref<LtHealth>('unknown');
const toastedErrors = new Set<LtErrorCode>();

export function reportLtOk() {
  if (ltHealth.value === 'ok') return;
  const was = ltHealth.value;
  ltHealth.value = 'ok';
  toastedErrors.clear();
  if (was === 'error') window.dispatchEvent(new CustomEvent(SPELL_RECHECK_EVENT));
}

export function reportLtError(err: unknown) {
  const code = ltErrorCode(err);
  const was = ltHealth.value;
  ltHealth.value = 'error';
  if (was !== 'error') window.dispatchEvent(new CustomEvent(SPELL_RECHECK_EVENT));
  // One toast per kind of failure until the server answers again; rate
  // limits are expected on the free API and handled by backing off.
  if (code !== 'rate-limited' && !toastedErrors.has(code)) {
    toastedErrors.add(code);
    try {
      useToastsStore().error(ltErrorMessage(err), 7000);
    } catch {}
  }
  console.warn('[languagetool]', err);
}

/** Forget health after a settings change (new server, new key …). */
export function resetLtHealth() {
  ltHealth.value = 'unknown';
  toastedErrors.clear();
  // LanguageTool may have just been switched on or off: Hunspell follows.
  window.dispatchEvent(new CustomEvent(SPELL_RECHECK_EVENT));
}

/**
 * Whether LanguageTool is taking care of spelling, so the Hunspell underline
 * should stay off. While the first answer is pending we assume yes (no flash
 * of double underlines); once the server fails, Hunspell takes over again.
 */
export function languagetoolCoversSpelling(): boolean {
  return ltEnabled() && ltHealth.value !== 'error';
}

// ---------------------------------------------------------------------------
// User actions
// ---------------------------------------------------------------------------

const ignored = new Set<string>();

/** Words in the Premium account dictionary (`/v2/words`). In Premium mode
 *  this — not `ltUserWords` — is the dictionary, so a word deleted on
 *  languagetool.org is flagged again after the next refresh. */
const premiumWords = new Set<string>();
let premiumWordsFor: string | null = null;

const WORD_RE = /[\p{L}\p{M}\p{N}](?:[\p{L}\p{M}\p{N}'’-]*[\p{L}\p{M}\p{N}])?/gu;

/**
 * The words a match covers. Premium's matches are not single words: they
 * carry trailing space or punctuation (`Fehlr `, `Fehlr.`) and adjacent typos
 * get merged into one match (`Wortt Grammatikk`). Dictionary checks and
 * "Add to dictionary" work on these words, never on the raw match text.
 */
export function matchWords(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

function ignoreKey(ruleId: string, text: string): string {
  return `${ruleId}\u0000${text.trim()}`;
}

function inDictionary(word: string): boolean {
  const s = useSettingsStore();
  return s.ltMode === 'premium' ? premiumWords.has(word) : s.ltUserWords.includes(word);
}

export function isLtIgnored(match: LtMatch, text: string): boolean {
  if (ignored.has(ignoreKey(match.ruleId, text))) return true;
  if (match.issueType === 'misspelling') {
    // Hidden once every word it flags is accepted.
    const words = matchWords(text);
    if (words.length && words.every(inDictionary)) return true;
  }
  return false;
}

/** (Re)load the Premium dictionary; no-op outside Premium. Redraws editors
 *  when it changed. Called on startup and after every settings change. */
export async function refreshPremiumWords(force = false) {
  const wire = wireConfig();
  if (wire?.mode !== 'premium') {
    premiumWords.clear();
    premiumWordsFor = null;
    return;
  }
  const owner = wire.username ?? '';
  if (!force && premiumWordsFor === owner) return;
  premiumWordsFor = owner;
  try {
    const words = await invoke<string[]>('languagetool_words_list', { config: wire });
    premiumWords.clear();
    for (const w of words) premiumWords.add(w);
    window.dispatchEvent(new CustomEvent(LT_REDRAW_EVENT));
  } catch (e) {
    premiumWordsFor = null; // retry next time
    console.warn('[languagetool] premium dictionary load failed', e);
  }
}

/** "Ignore" — this rule on this exact text, for the rest of the session. */
export function ltIgnore(match: LtMatch, text: string) {
  ignored.add(ignoreKey(match.ruleId, text));
  window.dispatchEvent(new CustomEvent(LT_REDRAW_EVENT));
}

/** "Disable rule" — persisted, sent as `disabledRules` from now on. */
export function ltDisableRule(ruleId: string) {
  useSettingsStore().ltDisableRule(ruleId);
}

/**
 * "Add to dictionary" for a LanguageTool spelling match: remembered for
 * LanguageTool, added to the Hunspell personal dictionary too when that
 * checker is on (so switching back doesn't resurrect the underline), and to
 * the account dictionary on Premium so it syncs to LanguageTool's other apps.
 */
export async function ltAddWord(rawWord: string) {
  const word = matchWords(rawWord)[0];
  if (!word) return;
  const s = useSettingsStore();
  const wire = wireConfig();
  if (wire?.mode === 'premium') {
    // Hide it right away; keep it only if the account accepted it.
    premiumWords.add(word);
    window.dispatchEvent(new CustomEvent(LT_REDRAW_EVENT));
    try {
      await invoke('languagetool_words_add', { config: wire, word });
    } catch (e) {
      premiumWords.delete(word);
      window.dispatchEvent(new CustomEvent(LT_REDRAW_EVENT));
      reportLtError(e);
      return;
    }
  } else {
    s.ltAddUserWord(word);
    window.dispatchEvent(new CustomEvent(LT_REDRAW_EVENT));
  }
  if (s.spellcheckEnabled) {
    try {
      if (await ensureSpellDict(s.spellcheckLang)) await addToSpellDict(word);
    } catch (e) {
      console.warn('[languagetool] hunspell add failed', e);
    }
  }
}

// One listener for the whole app (not one per editor): new account, new key
// or a mode switch reloads the Premium dictionary.
window.addEventListener(LT_SETTINGS_CHANGED_EVENT, () => void refreshPremiumWords(true));

/** Short label for an `issueType` (tooltip header fallback). */
export function issueLabel(issueType: string): string {
  const { t } = useI18n();
  const key = `languagetool.issue_${issueType}`;
  const s = t(key);
  return s === key ? t('languagetool.issue_uncategorized') : s;
}
