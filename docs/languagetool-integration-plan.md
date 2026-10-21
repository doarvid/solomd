# LanguageTool integration plan (Premium + local server)

Status: phases 1–3 implemented on branch `feature/languagetool` · Target: SoloMD 4.14.x (Tauri 2, Rust + Vue 3 / CodeMirror 6)

## Implementation status

| Piece | Where | State |
|---|---|---|
| Rust client: check / detect / API key / Premium words, public-API rate limit, `lt:<code>` errors | `app/src-tauri/src/languagetool.rs` (registered in **both** `lib.rs` and `runner.rs`) | done, 11 unit tests |
| Markdown → AnnotatedText, batching, front matter `lang:` | `app/src/lib/lt-annotate.ts` | done, 8 tests (`node --experimental-strip-types --test src/lib/lt-annotate.test.ts`) |
| Health, ignore / disable rule / add word flows | `app/src/lib/languagetool.ts` | done |
| CM6 plugin: viewport + optional whole-doc checking, per-block cache, hover tooltip, theme | `app/src/lib/cm-languagetool.ts` | done |
| Hunspell steps back while LanguageTool is healthy, takes over when it isn't | `Editor.vue`, `cm-spellcheck.ts` (`SPELL_RECHECK_EVENT`) | done |
| Windows context menu: message, fixes, add word, ignore, disable rule | `Editor.vue`, `EditorContextMenu.vue` | done |
| Settings section | `app/src/components/LanguageToolSettings.vue`, `stores/settings.ts` (`lt*` fields) | done |
| i18n (47 keys × 15 locales) | `app/src/i18n/*.ts` | done |
| Premium dictionary: `/v2/words` loaded at start and after settings changes, used as *the* dictionary in Premium mode (deletions on languagetool.org take effect after a restart) | `languagetool.rs` (`languagetool_words_list`), `languagetool.ts` | done, tested with a real account |
| Issues panel | – | open (phase 4) |

Premium quirks handled: AI rules (`QB_NEW_DE_…_ORTHOGRAPHY_SPELLING`) report typos as `issueType: grammar`, so they are reclassified as spelling. Matches carry trailing space or punctuation (`Fehlr `, `Fehlr.`), and adjacent typos are merged into one match (`Wortt Grammatikk`). Dictionary checks therefore use the words inside a match, a match hides once all its words are accepted, and a multi-word match offers one "Add …" per word.

Verified in the running debug app against a local LanguageTool 6.6 server: German was taken from front matter; code, inline code, link URLs and `**` stayed unchecked; the fix, Disable rule and server-down fallback all worked; the Premium no-credentials path and the public API both behaved as expected. Not covered: the legacy Windows textarea engine (`windowsEditorEngine: native`), which has no CodeMirror and so no Hunspell either.

Running the dev build next to an installed SoloMD needs a different identifier (the single-instance lock is per identifier), e.g. `pnpm tauri dev --config '{"identifier":"app.solomd.dev"}'`. This also keeps dev settings separate.

## 1. Goal

Add grammar, style and multi-language spell checking through LanguageTool (LT), in three modes the user picks in Settings:

| Mode | Endpoint | Auth | Typical use |
|---|---|---|---|
| **Local server** | `http://localhost:8081/v2` (configurable) | none | Privacy-first, offline, no rate limits |
| **LanguageTool Premium** | `https://api.languagetoolplus.com/v2` | `username` + `apiKey` | Premium rules ("picky" level, more style checks) |
| **Public free API** (optional) | `https://api.languagetool.org/v2` | none | Quick try-out; strict rate/size limits |
| **Off** (default) | – | – | Current Hunspell behaviour is unchanged |

LT is **opt-in and off by default**, in line with SoloMD's "no SoloMD-hosted servers / local-first" promise. Sending text to a remote LT endpoint must be an explicit user choice, with a clear notice in Settings.

## 2. What exists today (integration points)

| Concern | Existing code | Reuse for LT |
|---|---|---|
| Hunspell spellcheck (Rust) | `app/src-tauri/src/spellcheck.rs` (`spellcheck_check`, byte offsets, per-line) | Stays as the offline/fast layer; LT is added beside it |
| CM6 underline plugin | `app/src/lib/cm-spellcheck.ts` (viewport-only, per-line cache, 300 ms debounce) | Template for `cm-languagetool.ts` |
| Underline styling | `app/src/lib/cm-spellcheck-theme.ts` (`.cm-misspelled`) | Add `.cm-lt-grammar`, `.cm-lt-style`, `.cm-lt-spelling` |
| Right-click suggestions | `EditorContextMenu.vue` (`EditorMenuSpell`), `Editor.vue` ~L3110–3200, `lib/spell-suggest.ts` | Extend the menu with LT message + replacements + "ignore rule" |
| Issue list panel | `CjkProofread.vue` + `cjk_proofread.rs` (severity, jump-to, apply fix) | Pattern for an "LT issues" side panel |
| Secret storage | `ai_keystore.rs` (`set_key/read_key/has_key/clear_key`, keyring + encrypted fallback) | Store the Premium API key under provider id `languagetool` |
| HTTP client (rustls, proxy) | `reqwest` in `ai_proxy.rs::http_client`, `ollama.rs` | Same client setup; inherits `ProxySettings.vue` behaviour |
| Local-service detection UX | `ollama.rs::detect()` (1 s probe, status pill) | `languagetool_detect()` probing `/v2/languages` |
| Settings | `stores/settings.ts` (`spellcheckEnabled`, `spellcheckLang`), `SettingsPanel.vue` ~L1371 | New `lt*` fields and a "Grammar (LanguageTool)" section |
| Command registration | `app/src-tauri/src/lib.rs` ~L238 (`invoke_handler`) | Register `languagetool::*` commands |
| i18n | `app/src/i18n/*.ts` (16 locales) | New `languagetool.*` keys (en + de first; others fall back) |

## 3. Architecture

```
CodeMirror (cm-languagetool.ts)
   │  paragraph-level chunks + Markdown→AnnotatedText
   ▼  invoke('languagetool_check', { chunk, lang, … })
Rust: src-tauri/src/languagetool.rs
   │  • picks endpoint from settings (local / premium / public)
   │  • reads API key from ai_keystore (never exposed to JS)
   │  • rate limiter + LRU cache (hash(chunk+lang+mode) → matches)
   ▼  POST {base}/v2/check  (form: data=<annotated JSON>, language, username, apiKey, level …)
LanguageTool server (local JVM / Premium cloud)
```

**Why go through Rust instead of calling LT with `fetch` from the WebView?**
1. The Premium key stays in the OS keychain and never enters JS memory.
2. There's no CORS problem with the local server, which by default doesn't send `Access-Control-Allow-Origin`.
3. Rate limiting and caching live in one place, shared across tabs and panes.
4. It's the same pattern as `ai_proxy.rs` and `ollama.rs`.

### 3.1 Markdown handling: use LT's `data` (AnnotatedText) parameter

Plain text would make LT complain about `**`, `[link](url)`, code spans, front matter, etc. LT accepts
`data={"annotation":[{"text":"Hello "},{"markup":"**"},{"text":"world"},{"markup":"**"}]}`.
Markup segments are ignored for checking, but they still count toward offsets, so returned `offset`/`length` map **1:1 onto the original source**, and no offset translation is needed.

Build the annotation from the Lezer Markdown syntax tree CodeMirror already has (`@codemirror/lang-markdown`):
- `text`: paragraph text, list item text, heading text, blockquote text, table cell text.
- `markup`: emphasis markers, link URLs/brackets, heading `#`, list bullets, HTML tags, wikilinks `[[…]]` (keep alias text as `text`).
- `markup` with `interpretAs`: inline code becomes `"interpretAs":"code"`, so the sentence stays grammatical and the code isn't checked. Math `$…$` is handled the same way. A hard line break becomes `"\n"`.
- Skip entirely: fenced code blocks, YAML front matter, Mermaid/KaTeX blocks, tldraw blocks.

Offsets: LT (Java) reports offsets in **UTF-16 code units**, the same unit as CodeMirror. Rust only passes strings through, so no `byteToCharOffset` is needed (unlike Hunspell). Verify this with an emoji/CJK test case.

### 3.2 Chunking & scheduling (respecting limits)

- Unit of work = a **paragraph/block** (from the syntax tree), not a line, because grammar rules need sentence context.
- Check **visible blocks first**, then the rest of the document in the background with low priority (local mode only, or when Premium quota allows).
- Debounce: 800–1200 ms after typing stops (LT is slower than Hunspell). Never send the block under the cursor while the user is still typing in it.
- Cache key: `sha256(mode, lang, level, disabledRules, blockText)`. Reuse the existing `sha2` dependency.
- Rate limiter in Rust, configurable per mode:
  - Public API: about 20 requests/min, ≤ 20 KB/request (conservative defaults).
  - Premium: higher limits. Read them from the user's plan, keep them configurable, and back off on HTTP 429.
  - Local: no limits by default. Cap concurrency at 2.
- Batch small adjacent blocks into one request (with a separator `markup` `"\n\n"`) to save requests, up to about 10 KB.

## 4. Rust backend: `src-tauri/src/languagetool.rs` (new)

```rust
#[tauri::command] async fn languagetool_check(req: LtCheckRequest) -> Result<Vec<LtMatch>, String>
#[tauri::command] async fn languagetool_detect(base_url: Option<String>) -> Result<LtStatus, String>   // GET /v2/languages
#[tauri::command] async fn languagetool_languages() -> Result<Vec<LtLanguage>, String>
#[tauri::command] fn      languagetool_set_credentials(username: String, api_key: String) -> Result<(), String> // → ai_keystore::set_key("languagetool", …)
#[tauri::command] fn      languagetool_has_credentials() -> Result<bool, String>
#[tauri::command] fn      languagetool_clear_credentials() -> Result<(), String>
// Premium personal dictionary sync (optional phase)
#[tauri::command] async fn languagetool_words_add(word: String) -> Result<(), String>   // POST /v2/words/add
#[tauri::command] async fn languagetool_words_list() -> Result<Vec<String>, String>     // GET  /v2/words
```

`LtCheckRequest { annotated: Vec<Segment>, language: String /* "auto" | "de-DE" … */, mother_tongue: Option<String>, preferred_variants: Option<String>, level: Option<String> /* "default" | "picky" */, enabled_rules, disabled_rules, disabled_categories }`

`LtMatch { offset, length, message, short_message, replacements: Vec<String> (first 5), rule_id, rule_description, category_id, issue_type /* misspelling | grammar | style | typographical … */, sentence }`

Implementation notes:
- Build `reqwest::Client` like `ai_proxy::http_client`, with a 15 s timeout and a 2 s connect timeout for local mode. Honour the existing proxy settings.
- Store the username in settings (it isn't secret). Store the API key in `ai_keystore` under `"languagetool"`.
- Map errors to user-readable strings: `ECONNREFUSED` → "Local LanguageTool server not running", `401/403` → "Invalid Premium credentials", `413` → "Text too large", `429` → back off.
- Unit tests: JSON (de)serialisation against recorded LT responses, and annotation building. Integration tests use the `SOLOMD_LT_BASE_URL` env override, with a fixture HTTP server like the one the `ollama.rs` tests use.
- Mobile: the local mode makes no sense on iOS/Android unless a LAN URL is used. Allow a custom URL, and hide the "start local server" helper there.

## 5. Frontend

### 5.1 `app/src/lib/cm-languagetool.ts` (new)
- `ViewPlugin` with `languagetoolExtension({ enabled, mode, lang, level })`, modelled on `cm-spellcheck.ts`.
- `markdownToAnnotation(state, from, to)` walks `syntaxTree(state)` to produce segments.
- Decorations: `Decoration.mark({ class: 'cm-lt-' + issueType, attributes: { 'data-lt-id': … } })`, kept in a `StateField` so positions map through edits (`tr.changes.mapPos`). Drop a match when an edit touches its range.
- Hover tooltip (`@codemirror/view` `hoverTooltip`): shows the message, up to 5 replacement buttons, "Ignore", "Disable rule", and for misspellings "Add to dictionary".
- When LT is enabled for a language, suppress Hunspell underlines for `misspelling` matches LT already reports, to avoid double underlines. Keep Hunspell as the fallback when LT is unreachable.

### 5.2 Context menu
Extend `EditorMenuSpell` (or add `EditorMenuGrammar`) in `EditorContextMenu.vue`, so that a right-click on an LT range shows the message plus replacements. "Add to dictionary" writes to the Hunspell user dict, and in Premium mode it also calls `languagetool_words_add`.

### 5.3 Issues panel (phase 3)
`LanguageToolPanel.vue`, cloned from the `CjkProofread.vue` pattern. It lists all matches in the document grouped by category, with jump-to and apply-fix (or apply all of one rule). It's available from the command palette (`useCommands.ts`) and the menu (`app-menu.ts` / `menu_spec.rs`).

### 5.4 Settings (`stores/settings.ts` + `SettingsPanel.vue`)
```ts
ltMode: 'off' | 'local' | 'premium' | 'public';   // default 'off'
ltLocalUrl: string;                                // default 'http://localhost:8081'
ltUsername: string;                                // premium e-mail
ltLanguage: string;                                // 'auto' | 'de-DE' | 'en-US' …
ltMotherTongue: string;                            // optional, enables false-friend rules
ltPreferredVariants: string;                       // e.g. 'en-GB,de-DE' when language=auto
ltLevel: 'default' | 'picky';                      // picky = Premium/local only
ltDisabledRules: string[];                         // user-ignored rule ids
ltCheckWholeDoc: boolean;                          // background full-doc checking
```
The UI section "Grammar & style (LanguageTool)" contains:
- the mode radio buttons
- the URL field with a **Test connection** pill (reuses the Ollama status-pill component style)
- username and API-key fields (the key is write-only, showing "•••• saved / Clear")
- the language dropdown, filled from `languagetool_languages`
- the level selector
- a "Reset ignored rules" button
- a privacy notice for remote modes

Per-document override: allow `lang: de-DE` in front matter. The workspace index already parses YAML.

## 6. Local LanguageTool server (developer & user setup)

LanguageTool needs Java 17+. This machine already has Temurin JDK 21. Options:
1. **Stand-alone zip**: download `LanguageTool-stable.zip` from languagetool.org/download and run
   `java -cp languagetool-server.jar org.languagetool.server.HTTPServer --config server.properties --port 8081 --allow-origin`.
   Optional n-gram data (`ngrams-en`/`ngrams-de`, several GB each) enables the "confused words" rules. Set it with `languageModel=<dir>` in `server.properties`.
2. **Docker**: `docker run -d -p 8081:8010 erikvl87/languagetool`, a community image that also supports n-grams and fastText.
3. **Later (optional)**: a "Manage local server" helper in SoloMD that starts or stops a user-provided `languagetool-server.jar` as a child process (desktop only). Bundling LT (~250 MB + JRE) inside SoloMD is **not** recommended.

## 7. Phased delivery

| Phase | Scope | Est. |
|---|---|---|
| 0 | Build env + baseline (`pnpm tauri dev` runs on Windows); local LT server running | done / ½ d |
| 1 | `languagetool.rs`: check/detect/languages, credentials via `ai_keystore`, rate limiter, cache, unit tests | 2 d |
| 2 | `cm-languagetool.ts`: annotation builder, decorations, hover tooltip, settings section, i18n (en/de) | 3 d |
| 3 | Context-menu integration, Hunspell de-duplication, ignore/disable rule, per-doc language | 1–2 d |
| 4 | Issues panel, whole-document background check, Premium dictionary sync | 2 d |
| 5 | Tests (vitest-style `*.test.ts` like `app-menu.test.ts`, Rust tests), docs (README "Grammar checking"), PR upstream | 1 d |

## 8. Testing checklist
- Markdown edge cases: emphasis inside words, links, inline code inside a sentence, tables, wikilinks, footnotes, front matter, fenced code (must not be checked).
- Offsets with emoji / CJK / combining characters before an issue.
- Typing quickly in a long document: no request storm, and no stale underlines after an edit.
- Mode switching at runtime clears the cache and decorations.
- Local server down: a single non-blocking toast, then fall back to Hunspell.
- Premium wrong key: 401 handled and shown in Settings.
- Rate limit (429) behaviour on the public API.
- Proxy settings respected.

## 9. Open questions
- Should LT replace Hunspell completely when active, or run side by side (as proposed)?
- Upstream acceptance: SoloMD's README stresses "no servers". Remote modes must stay opt-in with a clear privacy notice. Check this with the maintainer (zhitongblog/solomd) before a PR.
- Should Premium dictionary sync be two-way (merge LT words into `user-dict-*.txt`)?
