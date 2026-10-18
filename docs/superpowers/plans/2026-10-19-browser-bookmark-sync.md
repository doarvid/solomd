# 浏览器书签双向同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bidirectional sync between Chromium bookmarks and SoloMD notes, configured in Settings.

**Architecture:** A new Rust module discovers/merges Chromium bookmark JSON, produces a capture plan (bookmark → note), and reconciles a managed `SoloMD/` bookmark subtree to match note links (note → bookmark), gated on the browser not running. The workspace index gains extracted links. A Pinia store schedules both directions, reusing the existing capture pipeline.

**Tech Stack:** Rust (Tauri 2, serde_json, sha2, walkdir, regex-lite), Vue 3 + Pinia + TypeScript.

**Spec:** `docs/superpowers/specs/2026-10-19-browser-bookmark-sync-design.md`

## Global Constraints

- Chromium family only: Chrome, Edge, Brave, Arc, Vivaldi, Chromium.
- Write only inside the managed `SoloMD/` bookmark subtree; never modify user bookmarks.
- Never overwrite existing notes; capture failures still write the existing stub note.
- All note links are `http`/`https` only; dedupe by `capture_store::normalize_url`.
- Browser writes are skipped while that browser's process is running.
- Desktop only; mobile returns empty/no-op.
- `SoloMD/` is a projection of notes: add missing, remove stale, clean empty folders.
- No new Rust dependencies.

## Review Focus

- A user's pre-existing folder literally named `SoloMD` must not be hijacked — fall back to `SoloMD (2)` when unmarked.
- Bookmark files with unknown/extra fields must round-trip without losing user data — parse via `serde_json::Value`, only touch the managed subtree.
- A browser that is running must never be written to; process detection failure is treated as "running".
- Notes outside the workspace, or with symlinked/`..` paths, must never produce bookmark folders escaping `SoloMD/`.
- Re-sync with no changes must not rewrite `Bookmarks` (avoids Browser Sync churn and mtime loops).

---

### Task 1: Extract note links into the workspace index

**Files:**
- Modify: `app/src-tauri/src/workspace_index.rs`
- Modify: `app/src/stores/workspaceIndex.ts`

**Interfaces:**
- Produces: `pub struct LinkRef { pub url: String, pub text: String, pub line: u32 }`
- Produces: `IndexEntry.links: Vec<LinkRef>` and TS `IndexEntry.links?: LinkRef[]`

- [ ] **Step 1: Write failing tests**

Add in the `mod tests` of `workspace_index.rs`:

```rust
#[test]
fn links_extract_inline_autolink_and_bare() {
    let body = "See [Rust](https://www.rust-lang.org/) and <https://example.com/a>.\n\
                Bare https://example.org/b?q=1 here.\n\
                ![img](https://example.com/pic.png)";
    let links = extract_links(body);
    let urls: Vec<_> = links.iter().map(|l| l.url.as_str()).collect();
    assert_eq!(urls, vec![
        "https://www.rust-lang.org/",
        "https://example.com/a",
        "https://example.org/b?q=1",
    ]);
    assert_eq!(links[0].text, "Rust");
    assert_eq!(links[1].text, "");
    assert_eq!(links[0].line, 1);
}

#[test]
fn links_dedupe_within_a_file_and_skip_non_http() {
    let body = "[a](javascript:alert(1))\n[b](https://x.com)\n[c](https://x.com)\n[d](mailto:a@b.c)";
    let links = extract_links(body);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].url, "https://x.com");
}
```

- [ ] **Step 2: Run tests, expect failure**

Run: `cd app/src-tauri && cargo test --lib links_ -- --nocapture`
Expected: compile error / no `extract_links`.

- [ ] **Step 3: Implement**

Add near `WikilinkRef`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkRef {
    pub url: String,
    pub text: String,
    pub line: u32,
}
```

Add `#[serde(default)] pub links: Vec<LinkRef>,` to `IndexEntry`, and set `links: extract_links(body)` in `scan_file`.

Implementation:

```rust
fn extract_links(body: &str) -> Vec<LinkRef> {
    static LINK_RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"\[([^\[\]\n]*)\]\((https?://[^)\s]+)\)").expect("link regex"));
    static BARE_RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"https?://[^\s<>"'\u{ff09}\u{300d}]+").expect("bare url regex"));
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (idx, line) in body.lines().enumerate() {
        let line_no = idx as u32 + 1;
        let mut covered: Vec<(usize, usize)> = Vec::new();
        for cap in LINK_RE.captures_iter(line) {
            let m = cap.get(0).unwrap();
            let Some(url) = cap.get(2) else { continue };
            if line[..m.start()].ends_with('!') {
                covered.push((m.start().saturating_sub(1), m.end()));
                continue;
            }
            covered.push((m.start(), m.end()));
            if seen.insert(url.as_str().to_string()) {
                out.push(LinkRef { url: url.as_str().to_string(), text: cap[1].to_string(), line: line_no });
            }
        }
        for m in BARE_RE.find_iter(line) {
            if covered.iter().any(|(s, e)| m.start() >= *s && m.start() < *e) {
                continue;
            }
            let raw = m.as_str().trim_end_matches(['.', ',', ';', ':', '!', '?']);
            if seen.insert(raw.to_string()) {
                out.push(LinkRef { url: raw.to_string(), text: String::new(), line: line_no });
            }
        }
    }
    out
}
```

- [ ] **Step 4: Run tests**

Run: `cd app/src-tauri && cargo test --lib links_`
Expected: PASS.

- [ ] **Step 5: Update TS type**

In `workspaceIndex.ts` add:

```ts
export interface LinkRef { url: string; text: string; line: number; }
```

and in `IndexEntry`: `links?: LinkRef[];`.

- [ ] **Step 6: Commit**

```bash
git add app/src-tauri/src/workspace_index.rs app/src/stores/workspaceIndex.ts
git commit -m "feat(index): extract http(s) links from notes"
```

---

### Task 2: Bookmark discovery, parsing, and catalog command

**Files:**
- Create: `app/src-tauri/src/bookmarks.rs`
- Modify: `app/src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `bookmarks_catalog() -> BookmarkCatalog`
- Types: `BookmarkSource`, `BookmarkFolderNode`, `BookmarkCatalog`

- [ ] **Step 1: Write failing tests**

Inside `bookmarks.rs` tests, build fixture JSON:

```rust
fn fixture() -> serde_json::Value {
    serde_json::json!({
      "checksum": "x",
      "roots": {
        "bookmark_bar": { "type": "folder", "name": "Bookmarks bar", "children": [
          { "type": "url", "name": "Rust", "url": "https://rust-lang.org/" },
          { "type": "folder", "name": "Tech", "children": [
            { "type": "url", "name": "Docs", "url": "https://doc.rust-lang.org/" }
          ]}
        ]},
        "other": { "type": "folder", "name": "Other bookmarks", "children": [
          { "type": "url", "name": "Ghost", "url": "javascript:void(0)" }
        ]}
      }
    })
}

#[test]
fn catalog_merges_roots_and_counts_urls() {
    let tree = merge_documents(vec![("Chrome · Default".into(), fixture())]);
    let bar = &tree.folders[0];
    assert_eq!(bar.name, "Bookmarks bar");
    assert_eq!(bar.url_count, 1);
    assert_eq!(bar.folders[0].name, "Tech");
    assert_eq!(bar.folders[0].url_count, 1);
}
```

- [ ] **Step 2: Run, expect failure**

Run: `cd app/src-tauri && cargo test --lib bookmarks:: -- --nocapture`

- [ ] **Step 3: Implement module**

Core pieces:

```rust
const BROWSERS: &[(&str, &[&str], &[&str])] = &[
    // (display, macOS relative roots, Windows/Linux relative roots)
];
```

Use a simpler table of candidate directory suffixes per platform, expanded against the home / LOCALAPPDATA. Discovery:

```rust
fn discover_sources() -> Vec<SourceFile> {
    // for each candidate base dir + profile dir, if <profile>/Bookmarks exists → source
    // skip System Profile / Guest Profile
}
```

Parse into internal nodes containing URLs; expose a display tree without URLs. Merge by path:

```rust
fn merge_documents(docs: Vec<(String, Value)>) -> Folder {
    // walk roots; for each url node push into a map keyed by folder path
}
```

Fingerprint: sort `(path, mtime, size)` and sha256 the joined string.

- [ ] **Step 4: Register commands in `lib.rs`**

Add `pub mod bookmarks;` and in `invoke_handler`: `bookmarks::bookmarks_catalog`.

- [ ] **Step 5: Run tests + check**

Run: `cd app/src-tauri && cargo test --lib bookmarks::`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src-tauri/src/bookmarks.rs app/src-tauri/src/lib.rs
git commit -m "feat(bookmarks): discover, merge and expose Chromium bookmark tree"
```

---

### Task 3: Read direction plan

**Files:**
- Modify: `app/src-tauri/src/bookmarks.rs`
- Modify: `app/src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `bookmarks_sync_plan(folders: Vec<Vec<String>>) -> Vec<BookmarkPlanEntry>`

- [ ] **Step 1: Failing test**

```rust
#[test]
fn plan_mirrors_selected_folder_and_dedupes_urls() {
    let plan = plan_from_docs(vec![fixture()], &[vec!["Bookmarks bar".into(), "Tech".into()]]);
    assert_eq!(plan.len(), 1);
    assert_eq!(plan[0].folder, vec!["Bookmarks bar", "Tech"]);
    assert_eq!(plan[0].normalized_url, "https://doc.rust-lang.org");
}
```

- [ ] **Step 2: Run, expect failure**

Run: `cd app/src-tauri && cargo test --lib plan_`

- [ ] **Step 3: Implement**

```rust
#[tauri::command]
pub fn bookmarks_sync_plan(folders: Vec<Vec<String>>) -> Result<Vec<BookmarkPlanEntry>, String>
```

Walk the merged tree to each selected path; recursively collect URL nodes; skip managed subtrees; only `http`/`https`; dedupe by `capture_store::normalize_url`; sanitize folder segments with `capture_store::safe_filename` (drop empty/dot segments; never emit `..`).

- [ ] **Step 4: Register `bookmarks_sync_plan`**, run tests, commit.

---

### Task 4: Note → bookmark reconcile

**Files:**
- Modify: `app/src-tauri/src/bookmarks.rs`
- Modify: `app/src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `bookmarks_apply(entries: Vec<BookmarkWriteEntry>) -> ApplyReport`

- [ ] **Step 1: Failing tests**

```rust
#[test]
fn apply_replaces_managed_subtree_and_keeps_user_nodes() {
    // tempdir with Bookmarks fixture containing user node + stale SoloMD subtree
    // apply two entries → user node still present byte-for-byte, managed subtree matches
}

#[test]
fn apply_is_noop_when_already_aligned() {
    // run once, capture mtime, run again → file bytes unchanged
}

#[test]
fn apply_skips_when_browser_running() {
    // inject a fake `is_running = true` closure; report.skipped_profiles[0].reason == "running"
}
```

- [ ] **Step 2: Run, expect failure**

- [ ] **Step 3: Implement**

- `is_browser_running(display: &str) -> bool` using `pgrep -x` / `tasklist`; on command failure return `true` (conservative).
- `find_or_create_managed_root(&mut Value) -> &mut Value`: match `meta_info.solomd_managed == "1"`; else create `SoloMD` with marker; if an unmarked folder has that name, create `SoloMD (2)`.
- Build desired subtree from entries (dedupe by `normalize_url`), with sanitized folder segments and no `..`.
- Compare canonical JSON (`{"type","name","url","children"}` only) of current vs desired; equal → no write.
- Replace `children`; assign new ids/guids/dates; remove `checksum`; write `Bookmarks.solomd.bak`; temp file + rename.
- Report `written_profiles`, `skipped_profiles`, `added`, `removed`, `unchanged`.

- [ ] **Step 4: Run `cargo test --lib bookmarks::`**, fix, commit.

---

### Task 5: Scheduling store

**Files:**
- Create: `app/src/stores/bookmarkSync.ts`
- Modify: `app/src/stores/settings.ts`
- Modify: `app/src/App.vue`

**Interfaces:**
- Consumes: `bookmarks_catalog`, `bookmarks_sync_plan`, `bookmarks_apply`, `capture_fetch_page`, `capture_captured_urls`
- Produces: `useBookmarkSyncStore()` with `start()`, `stop()`, `syncNow(force?)`, observable progress.

- [ ] **Step 1: Add settings fields**

In `Settings` + `defaults()`:

```ts
bookmarkSyncEnabled: false,
bookmarkSyncFolders: [] as string[][],
bookmarkSyncIntervalMinutes: 30,
bookmarkSyncFingerprint: '',
```

- [ ] **Step 2: Implement store**

- `start()` sets a 60s interval + calls `maybeSync()`.
- `maybeSync()` checks enabled / desktop / workspace (skip `saf:`) / not running / interval elapsed.
- Read direction: catalog → fingerprint compare → plan → per-folder `capture_captured_urls` → sequential `capture_fetch_page`.
- Write direction: build entries from `useWorkspaceIndexStore().entries`, workspace-relative folder segments, `url` from `links` + frontmatter `url:`; invoke `bookmarks_apply`.
- Persist fingerprint via `settings.persist()`.

- [ ] **Step 3: Wire App.vue**

`onMounted`: `useBookmarkSyncStore().start()`; `onBeforeUnmount`: `.stop()`.

- [ ] **Step 4: Typecheck**

Run: `cd app && npx vue-tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

---

### Task 6: Settings UI

**Files:**
- Create: `app/src/components/BookmarkSyncSettings.vue`
- Modify: `app/src/components/SettingsPanel.vue`
- Modify: `app/src/i18n/en.ts`, `app/src/i18n/zh.ts`

**Interfaces:**
- Consumes: settings fields + bookmarkSync store + `bookmarks_catalog` tree.

- [ ] **Step 1: Build component** with toggle, source summary, folder checkbox tree, interval select, sync button, progress/status, warning copy.
- [ ] **Step 2: Mount** in `SettingsPanel.vue` under `data-cat="integrations"`, wrapped in `v-if="!isPhoneOrTablet"`.
- [ ] **Step 3: Add i18n keys** under `settings.bookmarkSync*` in `en.ts` and `zh.ts` (other languages fall back to English).
- [ ] **Step 4: Typecheck + build**

Run: `cd app && npx vue-tsc --noEmit && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

---

### Task 7: Full verification

- [ ] Run `cd app/src-tauri && cargo test --lib`
- [ ] Run `cd app && npx vue-tsc --noEmit && npm run build`
- [ ] Manual smoke: scan → select folder → sync → verify notes; close browser → add note link → sync → verify `SoloMD/`; delete link → sync → verify removal; re-sync no-op.
- [ ] Commit any fixes.
