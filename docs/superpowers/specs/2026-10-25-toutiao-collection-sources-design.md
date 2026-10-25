# Toutiao Collection Source & Rendered Capture — Design

**Status:** approved (design), pending spec review
**Date:** 2026-10-25
**Phase:** 2 of the collection-sources work. Phase 1 (GitHub Stars) is merged
into `main`; see `2026-10-25-collection-sources-design.md`.

## 1. Goal

Bring 今日头条 (Toutiao) favourites into the same "pending import" inbox that
Phase 1 built for GitHub Stars, and make page capture succeed on sites that
only render their content with JavaScript.

Success means:

- After a one-time guided login, opening SoloMD shows newly favourited Toutiao
  items in the inbox's pending-import list, with no further clicking.
- Importing an item writes a note; text posts get full text, while video and
  micro-post items fall back to a bookmark note instead of failing.
- Capturing any link that static HTTP fetching cannot read gets one rendered
  attempt before giving up, on by default.

Non-goals: other sources, background scheduling while the app is closed,
syncing the imported state to the server, and mobile support (the embedded
browser is desktop-only; the existing `collections.available` gate already
disables the feature on mobile).

## 2. Constraints from the existing codebase

- `app/src-tauri/src/browser.rs` already owns child webviews labelled
  `browser-<tabId>`, injects `capture_script.js`, and receives data through a
  navigation sentinel `https://solomd.invalid/capture/<kind>/<n>/<total>#<b64>`
  intercepted in `on_navigation`. Kinds are currently whitelisted to `capture`
  and `selection`; chunk assembly enforces `MAX_CHUNKS = 4096` and
  `MAX_TOTAL_BYTES = 64 MiB`.
- Child webviews cannot call Tauri commands. Any new data path must use the
  same sentinel mechanism.
- `collections.rs` owns the per-workspace cache
  (`<workspace>/.solomd/collections.json`) and the import pipeline. Its state
  is source-agnostic: items already carry `source`, and `imported` /
  `dismissed` are keyed by item id.
- `collections-filter.ts` derives the pending list by cross-checking the
  workspace index, so nothing new needs to be persisted for dedupe.
- `capture_store.rs::capture_fetch_page` is the single place a reference note
  is produced; a render fallback belongs there and nowhere else.

## 3. Architecture

### 3.1 A hidden "collector" webview

One dedicated child webview, label `browser-collector`, created on demand and
reused for the app's lifetime:

- created with a real page size (1200×2000) at an off-screen position and then
  hidden, so layout and script execution are not skipped;
- owns the Toutiao login session and performs harvesting;
- also performs rendered-capture fallback for arbitrary URLs.

It is **not** part of the tab store and never appears in the tab bar. The store
continues to treat "collector" as an ordinary child webview for creation,
navigation, hiding, and destruction, through a small Rust-side helper rather
than frontend tab state.

Invariant: **the webview that authenticates is the webview that harvests.** If
the spike shows that cookies are not shared with the visible browser tab, the
login step shows the collector itself over the content area instead of opening
a tab; harvesting code does not change.

### 3.2 Sentinel extension

`parse_sentinel` gains three kinds: `probe`, `collect`, `render`. Payloads are
JSON, base64-chunked exactly like `CapturePayload`:

| kind      | payload                                   | consumer |
|-----------|-------------------------------------------|----------|
| `probe`   | `{ "loggedIn": bool, "reason": string }`  | collector status |
| `collect` | `{ "items": [{ "url", "title" }], "hasMore": bool }` | harvest |
| `render`  | `{ "html": string }`                      | capture fallback |

`accept_chunk` routes chunks whose label is `browser-collector` to a
collector-side delivery map instead of emitting `browser://*` events. The
delivery map holds at most one waiter per kind; a second concurrent request
returns a `Busy` error rather than interleaving chunks. Chunk assembly and the
size caps are shared code, not duplicated.

### 3.3 Toutiao flow

1. `collector_status(source)` — ensure the webview exists, navigate to
   `https://www.toutiao.com/c/user/favourite/`, wait for
   `document.readyState === 'complete'` (poll every 250 ms, 30 s timeout), then
   eval `__solomd.probe()`.
2. If not logged in, return `login_required`; the frontend shows guidance and
   opens the login page in a visible browser tab. After the user finishes,
   the "我已登录，重新采集" action re-runs step 1.
3. `collector_harvest(source)` — eval `__solomd.harvest({patterns, cap})`.
   The script only drives the page and reports raw candidates:
   - scrolls to the bottom repeatedly, waiting ~800 ms between rounds;
   - collects `{url, title}` from anchors outside `header`/`nav`/`footer`;
   - stops after 3 consecutive rounds with no new URLs.
   The backend then applies `filter_toutiao_items`: keep only `/article/`,
   `/w/`, `/video/`, `/i/` paths, drop titles shorter than four characters,
   dedupe by normalized URL, cap at 200, and set `hasMore` when the cap was
   hit. Filtering stays testable Rust instead of living in injected JS.
4. Frontend calls `collections_upsert_items(workspace, "toutiao", items)`.
   Items get `id = "toutiao:" + url`, `source = "toutiao"`, and either the
   Toutiao saved time when the page exposes it or `null`. Nothing is deleted;
   filtering remains derived.
5. Import reuses `collections_import` unchanged. Full-text capture goes through
   `capture_fetch_page`, which now benefits from the render fallback; anything
   still unreadable becomes the existing bookmark stub.

Automatic refresh: `collections.maybeRefresh` treats Toutiao like GitHub but
without a token check. If status is `login_required`, the store sets
`toutiaoLoginRequired` and stops retrying until the user acts; it does not pop
a login page on its own at startup.

### 3.4 Rendered capture fallback

`capture_fetch_page` gains a `render_fallback: bool` argument (the frontend
passes the user setting; absent means `false`). After the existing static fetch
and extraction:

- trigger when extraction returned `None`, or the extracted markdown is under
  400 characters after trimming;
- skip for the GitHub-repo path (it returns earlier) and when the collector is
  unavailable (`browser_platform_supported` is false);
- render request: navigate the collector to the URL, wait for
  `readyState === 'complete'`, wait an extra 500 ms for late hydration, eval
  `__solomd.render()`, which sends `document.documentElement.outerHTML`;
- feed that HTML through the existing `webdoc` extraction pipeline;
- 20-second timeout, one render at a time, and if the rendered attempt also
  fails, keep the current stub but with a note distinguishing
  "static fetch could not read the page" from "rendered page still had no
  extractable text";
- `FetchOutcome.via` may now be `"rendered"`.

The 400-character threshold is deliberately conservative and lives in one
constant; it is tunable after real-page testing.

## 4. Frontend

- `collections` store: add `toutiaoLoginRequired`, per-source refresh gating,
  and a `refreshSource(source)` used by both the settings card and startup.
  `pendingItems` merges both sources; items are already sorted by `savedAt`.
- `InboxView.vue`: pending rows show a source chip (GitHub / 今日头条). When
  `toutiaoLoginRequired` is true, a single hint row above the list offers
  "登录今日头条"; the list itself keeps working for GitHub items.
- `CollectionSourcesSettings.vue`: replace the placeholder card with the real
  one — enable toggle (default off), "登录并采集" / "我已登录，重新采集",
  "立即采集", last refresh, pending count, clear history. Enabling is offered
  only after a successful probe; the toggle is how the user opts in.
- Settings store: `collectionToutiaoEnabled` (default `false`) and
  `captureRenderFallback` (default `true`). The render toggle lives with the
  other capture settings, not in the collection card.
- All 15 locale files get the new keys, with English text outside `en`/`zh`.

## 5. Error handling

- Collector creation or navigation failure → surfaced as a source-level error
  (`lastError` keyed by source); the GitHub path is unaffected.
- Harvest timeout → no partial write; the previous cache stands, and the item
  list is unchanged.
- `upsert_items` validates `source` against a closed set and rejects unknown
  ids; a malformed render payload is dropped, never written.
- Render fallback never turns a successful static capture into a failure; it
  is strictly an upgrade attempt.

## 6. Testing

Unit-testable without a display:

- `filter_toutiao_items`: URL pattern set, short-title drop, dedupe by
  normalized URL, 200-item cap and `hasMore`;
- `parse_sentinel` accepts the three new kinds and still rejects unknown ones;
- delivery map: one waiter per kind, second request returns `Busy`, chunk
  reassembly unchanged;
- `upsert_items`: source validation, idempotent update by id, `lastRefresh`
  update, no deletion;
- render trigger predicate: `None` extraction, short markdown, GitHub path
  skipped, unavailable collector skipped;
- frontend store: Toutiao gating by `collectionToutiaoEnabled`, login-required
  short-circuit, merged pending order.

Manual/spike acceptance (recorded in the plan, not automated):

1. Hidden child webview executes JS and lays out a real page (macOS).
2. Toutiao login in a visible tab is visible to the collector.
3. A JavaScript-rendered article yields extractable text only after the
   rendered attempt.

## 7. Risks

- **Hidden-webview throttling.** WKWebView may throttle or skip rendering for
  hidden/off-screen views. Spike first; fallback is a 1×1 visible view covered
  by the main webview, or briefly showing the collector while harvesting.
- **Cookie isolation.** Two child webviews may not share a data store on every
  platform. Invariant above; if it fails, login happens in the collector.
- **Toutiao DOM changes.** Harvest deliberately depends on URL shape, not CSS
  classes; if Toutiao changes URL patterns, only the pattern list changes.
- **Login walls and anti-bot.** Harvest failures are surfaced, never silently
  treated as "no new items".

## 8. Relationship to Phase 1

Everything Phase 1 shipped stays: cache format (version 1, additive fields
only), import pipeline, pending-list derivation, and the GitHub card. Toutiao
adds a second producer of items and a second consumer of the collector; no
cache migration is required. Existing `collections.json` files keep working
because unknown `source` values were never special-cased.
