# Toutiao Collection Source & Rendered Capture — Implementation Plan

> **For agentic workers:** execute task by task; steps are RED → GREEN.

**Goal:** Add Toutiao favourites as a second collection source and a rendered
capture fallback, per `docs/superpowers/specs/2026-10-25-toutiao-collection-sources-design.md`.

**Architecture:** one hidden child webview (`browser-collector`) runs injected
scripts and sends data through the existing `solomd.invalid` chunked sentinel;
Rust filters and caches; the existing store/UI gain a per-source gate.

**Tech stack:** Tauri 2 (Rust), Vue 3 + Pinia + TS, `node --test`.

## Global Constraints

- Every desktop command must also be registered in `runner.rs`, using
  `super::` paths through `#[path]` includes.
- Mobile (`browser_mobile.rs`) keeps same-named stubs; collector is
  desktop-only and its commands are registered behind
  `#[cfg(not(target_os = "android"))]`.
- Sentinel input is untrusted: parse failures return `None`, never panic.
- No cache migration: `CollectionsState.version` stays `1`.
- All 15 locale files mirror `en.ts` keys; `vue-tsc` must stay clean.

## Review Focus

- Hidden/off-screen webview may not execute JS on some platforms → spike
  before building on it.
- Cookies may not be shared between the visible login tab and collector →
  login must move into the collector if the spike disproves sharing.
- Toutiao DOM/URL changes → filtering depends on URL shape only.
- Render fallback must never downgrade a successful static capture.
- Harvest/timeout races must not write partial results.

---

### Task 1: Sentinel kinds and collector routing

**Files:** `app/src-tauri/src/browser.rs`, `app/src-tauri/src/collector.rs` (new, desktop), `app/src-tauri/src/browser_mobile.rs`

- [ ] Add `probe`, `collect`, `render` to the `parse_sentinel` whitelist; add tests in `browser.rs` asserting each kind parses and `"evil"` does not.
- [ ] Decode the payload to `serde_json::Value`; if `collector::is_collector_label(label)`, call `collector::deliver(kind, value)` and return; otherwise deserialize `CapturePayload` as today.
- [ ] `collector.rs`: `is_collector_label`, `begin(kind)` (clears stale chunks), `deliver(kind, value)`, `wait_for(kind, timeout) -> Result<Value, String>` with one waiter per kind; a second concurrent wait returns `"collector busy"`.
- [ ] Unit tests: deliver→wait roundtrip; second waiter rejected; unknown kind delivered to nobody without panic.

### Task 2: Collector webview lifecycle

**Files:** `app/src-tauri/src/browser.rs`, `app/src-tauri/src/collector.rs`, `app/src-tauri/src/lib.rs`, `app/src-tauri/src/runner.rs`

- [ ] Refactor `browser_create` body into `pub(crate) fn ensure_webview(app, tab_id, url, x, y, w, h, extra_script: Option<&'static str>)`; `browser_create` calls it with `None`.
- [ ] Collector creation: label `browser-collector`, size 1200×2000 at `x = 0, y = 0`, then `hide()`; `.on_page_load` records `Finished` in a `static LOADED: Mutex<Option<Instant>>`-style generation counter.
- [ ] `collector::ensure(app) -> Result<(), String>` creates once and reuses; `navigate_and_wait(app, url, timeout)` navigates, waits for the next finished generation, then sleeps 500 ms.
- [ ] Register no new command yet; compile both roots (`cargo check --lib` and the bin target).

### Task 3: Collector script

**Files:** `app/src-tauri/src/collector_script.js` (new), `app/src-tauri/src/browser.rs`, `app/src-tauri/src/capture_script.js`

- [ ] Expose the chunk sender as `_send` on `window.__solomd` in `capture_script.js` (no behavior change).
- [ ] `collector_script.js` defines `window.__solomdCollector`:
  - `probe()` → sends `probe` `{loggedIn, reason}` using URL + DOM heuristics (login host/path, visible login link, avatar presence).
  - `harvest()` → scroll loop (≤40 rounds, 800 ms, stops after 2 stable rounds), collects raw `{url,title}` anchors outside `header/nav/footer`, cap 600, sends `collect` `{items, hasMore}`.
  - `render()` → after 50 ms sends `render` `{html: document.documentElement.outerHTML}`.
- [ ] Inject both scripts into the collector webview (two `.initialization_script` calls).

### Task 4: Spike — hidden webview really renders

**Files:** none (manual verification note goes in the task commit message)

- [ ] Add a temporary debug invocation path via the existing webview eval (dev-only, removed before merge) and verify on macOS: probe returns, harvest scrolls a JS page, render returns non-empty HTML.
- [ ] If hidden fails: switch collector creation to 1×1 visible and re-verify. Record the choice in the commit message. If neither works, stop and report before proceeding.

### Task 5: Toutiao filtering and cache upsert

**Files:** `app/src-tauri/src/collections.rs`

- [ ] Add `RawItem { url, title }`, `is_toutiao_url`, `filter_toutiao_items(raw) -> (Vec<RawItem>, bool)` (path whitelist `/article/ /w/ /video/ /i/`, title ≥ 4 chars, dedupe by normalized URL, cap 200, `hasMore`).
- [ ] Add `upsert_items(state, source, raw, truncated) -> RefreshOutcome`: closed source set; validates/filters; item id `"{source}:{normalized_url}"`; keeps first-seen metadata; sets `last_refresh[source]`; never deletes.
- [ ] Tests: URL filtering, title drop, dedupe, cap, unknown source rejected, idempotent second upsert adds 0.
- [ ] Command `collections_upsert_items(workspace, source, items, hasMore)` registered in both roots (desktop-gated).

### Task 6: Collector commands

**Files:** `app/src-tauri/src/collector.rs`, `app/src-tauri/src/lib.rs`, `app/src-tauri/src/runner.rs`

- [ ] `collector_status(app, source)` — ensure, navigate favourites URL, probe, map to `{state: "ready"|"login_required"|"error", url, error}`.
- [ ] `collector_harvest(app, source)` — ensure, re-probe, then eval `harvest()`, await `collect` (45 s), return `{items, hasMore, error}`.
- [ ] Source whitelist `"toutiao"`; unknown source returns `Err`.
- [ ] Register both commands in `lib.rs` and `runner.rs` behind `#[cfg(not(target_os = "android"))]`.

### Task 7: Rendered capture fallback

**Files:** `app/src-tauri/src/capture_store.rs`, `app/src-tauri/src/collector.rs`, callers

- [ ] `capture_fetch_page` gains `render_fallback: Option<bool>` and `app: AppHandle`.
- [ ] Add `should_render(markdown: &str, extracted: bool) -> bool` (no extraction, or trimmed chars < 400).
- [ ] After static extraction, when enabled + desktop + supported, `collector::render(url, 20s)` and re-run `webdoc::extract_plain_text` / `extract`; success sets `via = "rendered"`; failure keeps the existing stub and appends the render error to the note.
- [ ] Unit tests for `should_render`; verify GitHub-repo path returns before the fallback.
- [ ] Frontend callers pass the setting value.

### Task 8: Settings and store

**Files:** `app/src/stores/settings.ts`, `app/src/stores/collections.ts`, tests

- [ ] Settings: `collectionToutiaoEnabled: false`, `captureRenderFallback: true` (+ defaults, persistence is automatic).
- [ ] Store: `toutiaoLoginRequired`, per-source `refreshSource`, gating in `pendingItems` by each source toggle, merged ordering, `upsert` via command.
- [ ] Tests: Toutiao disabled hides only Toutiao; login-required stops retries and surfaces the flag; merged order preserved.

### Task 9: UI and i18n

**Files:** `app/src/components/InboxView.vue`, `app/src/components/CollectionSourcesSettings.vue`, 15 locale files, tests

- [ ] Pending rows show a source chip; login hint row with a "登录今日头条" action.
- [ ] Settings card: enable switch, login/re-harvest buttons, refresh now, last refresh, pending count, clear history; errors per source.
- [ ] Render-fallback toggle placed with capture settings.
- [ ] New keys in all locales; `vue-tsc` clean.

### Task 10: Verification

- [ ] `cargo test --lib` (record the pre-existing `languagetool` failure if still present).
- [ ] `npm test` in `app/`, `npx vue-tsc --noEmit`.
- [ ] Manual: login guidance → harvest → import a text post and a video post.
