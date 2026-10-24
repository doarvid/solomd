# 收藏源 + GitHub Star 收件箱导入 — 实现计划（一期）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 GitHub Star 作为第一个“收藏源”，在收件箱里显示尚未导入的条目，并一键导入成带元信息的笔记。

**Architecture:** Rust `collections.rs` 负责收藏源缓存、GitHub Star 刷新与导入编排；前端 `collections-filter.ts` 做可测的可见条目过滤，`stores/collections.ts` 负责调度与进度，`InboxView.vue` 和设置页只消费 store。导入复用 `capture_fetch_page` 的 README 特判与现有采集流水线。

**Tech Stack:** Rust + Tauri 2 + reqwest + serde；Vue 3 + Pinia + TypeScript；测试用 `cargo test --lib` 与 `node --test --experimental-strip-types`。

**Spec:** `docs/superpowers/specs/2026-10-25-collection-sources-design.md`

## Global Constraints

- 一期仅桌面端：前端用 `isMobile()` / `hasGitBackend()` 隐藏入口；Rust 模块与命令用 `#[cfg(not(target_os = "android"))]` 门控（与 `github_sync` 相同）。
- 缓存路径固定为 `<workspace>/.solomd/collections.json`；写入必须原子（临时文件 + rename）；解析失败先备份为 `collections.json.bak-<毫秒时间戳>` 再返回空状态。
- 不新增任何 npm / Cargo 依赖。
- 所有新文案必须同时写进 `app/src/i18n/en.ts` 和 `app/src/i18n/zh.ts`，不得硬编码。
- `collections.rs` 会被 `lib.rs` 和 `runner.rs` 两个编译根引入，跨模块引用用 `super::`，不用 `crate::`。
- 每个 Tauri 命令都要同时注册到 `app/src-tauri/src/lib.rs` 与 `app/src-tauri/src/runner.rs` 的 `generate_handler!`。
- 导入目录固定取 `capture_endpoint::current_target()` 的 inbox 文件夹；取不到时回退 `<workspace>/inbox`。
- 导入失败必须删除刚生成的存根文件并保留待导入条目；成功后笔记 frontmatter 必须有且仅有一个 `inbox: true`。
- 去重以 URL 为准：在前端用 `capture_normalize_url` 的归一化结果 + workspace index 的 `captured_url` / 链接集合，复用 `bookmark-dedupe.ts::shouldCapture`。

## Review Focus

1. **损坏或半写入的 `collections.json`** 不能让收件箱打不开或清空用户数据 → Task 1 测试。
2. **GitHub API 字段缺失**（`topics` / `language` / `starred_at` 不存在）不能让整批刷新失败 → Task 2 测试。
3. **导入抓取失败** 必须删除存根且条目仍可重试，不能留下 `-2` 副本 → Task 3 测试。
4. **归一化 URL 去重**：同一页面的跟踪参数差异不能被重复导入 → Task 5 测试。
5. **frontmatter 重复写入**：同一笔记只能有一个 `inbox:` 键，元信息只写缺失项 → Task 3 测试。

---

### Task 1: 收藏源缓存与基础命令

**Files:**
- Create: `app/src-tauri/src/collections.rs`
- Modify: `app/src-tauri/src/github_sync.rs:102`
- Modify: `app/src-tauri/src/capture_store.rs:343`
- Test: `app/src-tauri/src/collections.rs`（同文件 `#[cfg(test)]`）

**Interfaces:**
- Consumes: `github_sync::read_token()`（本任务只改可见性，Task 2 使用）；`capture_store::yaml_scalar()`（Task 3 使用）。
- Produces: `CollectionsState`、`PendingItem`、`load_state(&Path)`、`save_state(&Path,&CollectionsState)`、`mutate_state`、命令 `collections_load` / `collections_dismiss` / `collections_clear_history`。

- [ ] **Step 1: 写失败测试**

在新建的 `app/src-tauri/src/collections.rs` 末尾写入：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str) -> PendingItem {
        PendingItem {
            id: id.to_string(),
            source: "github".to_string(),
            title: "owner/repo".to_string(),
            url: "https://github.com/owner/repo".to_string(),
            saved_at: Some("2026-10-01T00:00:00Z".to_string()),
            description: Some("desc".to_string()),
            language: Some("Rust".to_string()),
            stars: Some(42),
            topics: vec!["cli".to_string()],
        }
    }

    #[test]
    fn cache_round_trip_keeps_items() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = default_state();
        state.items.push(item("github:owner/repo"));
        state.dismissed.push("github:old/one".to_string());
        state.imported.insert(
            "github:done/one".to_string(),
            "/vault/inbox/done.md".to_string(),
        );
        save_state(dir.path(), &state).unwrap();

        let loaded = load_state(dir.path());
        assert_eq!(loaded.version, VERSION);
        assert_eq!(loaded.items.len(), 1);
        assert_eq!(loaded.items[0].id, "github:owner/repo");
        assert_eq!(loaded.dismissed, vec!["github:old/one"]);
        assert_eq!(
            loaded.imported.get("github:done/one").map(String::as_str),
            Some("/vault/inbox/done.md")
        );
    }

    #[test]
    fn corrupt_cache_is_backed_up_and_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "not json at all").unwrap();

        let loaded = load_state(dir.path());
        assert_eq!(loaded.items.len(), 0);
        assert_eq!(loaded.version, VERSION);

        let backups: Vec<_> = std::fs::read_dir(dir.path().join(".solomd"))
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("collections.json.bak-")
            })
            .collect();
        assert_eq!(backups.len(), 1, "corrupt file should be preserved");
    }

    #[test]
    fn dismiss_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let id = "github:owner/repo";
        mutate_state(dir.path(), |s| s.dismissed.push(id.to_string())).unwrap();
        mutate_state(dir.path(), |s| {
            if !s.dismissed.iter().any(|d| d == id) {
                s.dismissed.push(id.to_string());
            }
        })
        .unwrap();
        assert_eq!(load_state(dir.path()).dismissed, vec![id]);
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd app/src-tauri && cargo test --lib collections::tests::`

Expected: 编译失败，提示 `CollectionsState` / `default_state` / `load_state` 等未定义。

- [ ] **Step 3: 实现缓存模块**

在 `app/src-tauri/src/collections.rs` 顶部写入（放在测试模块之前）：

```rust
//! 收藏源（一期：GitHub Star）。
//!
//! 缓存是“源返回的条目 + 用户决定”，不保存“是否已采集” ——
//! 那属于工作区内容，由前端用 workspace index 实时过滤。
//!
//! 这个文件同时被 `lib.rs`（测试 + 库）和 `runner.rs`（实际二进制）引入，
//! 所以跨模块引用一律走 `super::`。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

const VERSION: u32 = 1;

static WRITE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingItem {
    /// 稳定 id："github:<owner/repo>"，二期为 "toutiao:<normalized-url>"。
    pub id: String,
    pub source: String,
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub saved_at: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub stars: Option<u32>,
    #[serde(default)]
    pub topics: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionsState {
    pub version: u32,
    pub items: Vec<PendingItem>,
    pub dismissed: Vec<String>,
    pub imported: BTreeMap<String, String>,
    pub last_refresh: BTreeMap<String, i64>,
}

pub fn default_state() -> CollectionsState {
    CollectionsState {
        version: VERSION,
        items: Vec::new(),
        dismissed: Vec::new(),
        imported: BTreeMap::new(),
        last_refresh: BTreeMap::new(),
    }
}

fn state_path(workspace: &Path) -> PathBuf {
    workspace.join(".solomd").join("collections.json")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn load_state(workspace: &Path) -> CollectionsState {
    let path = state_path(workspace);
    let Ok(raw) = fs::read_to_string(&path) else {
        return default_state();
    };
    match serde_json::from_str::<CollectionsState>(&raw) {
        Ok(mut state) => {
            if state.version == 0 {
                state.version = VERSION;
            }
            state
        }
        Err(_) => {
            let backup = path.with_file_name(format!("collections.json.bak-{}", now_ms()));
            let _ = fs::rename(&path, backup);
            default_state()
        }
    }
}

pub fn save_state(workspace: &Path, state: &CollectionsState) -> Result<(), String> {
    let path = state_path(workspace);
    let dir = path
        .parent()
        .ok_or_else(|| "collections cache path has no parent".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("创建 {} 失败: {e}", dir.display()))?;
    let tmp = dir.join("collections.json.tmp");
    let body = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    fs::write(&tmp, body).map_err(|e| format!("写入 {} 失败: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("替换 {} 失败: {e}", path.display()))
}

/// 读 → 改 → 原子写。所有会改缓存的命令都走这里，避免并发互相覆盖。
pub fn mutate_state<T>(
    workspace: &Path,
    f: impl FnOnce(&mut CollectionsState) -> T,
) -> Result<T, String> {
    let _guard = WRITE_LOCK
        .lock()
        .map_err(|_| "collections cache lock poisoned".to_string())?;
    let mut state = load_state(workspace);
    let out = f(&mut state);
    save_state(workspace, &state)?;
    Ok(out)
}

#[tauri::command]
pub fn collections_load(workspace: String) -> Result<CollectionsState, String> {
    Ok(load_state(Path::new(&workspace)))
}

#[tauri::command]
pub fn collections_dismiss(workspace: String, id: String) -> Result<CollectionsState, String> {
    mutate_state(Path::new(&workspace), |state| {
        if !state.dismissed.iter().any(|d| d == &id) {
            state.dismissed.push(id);
        }
    })?;
    Ok(load_state(Path::new(&workspace)))
}

#[tauri::command]
pub fn collections_clear_history(workspace: String) -> Result<CollectionsState, String> {
    mutate_state(Path::new(&workspace), |state| {
        state.dismissed.clear();
        state.imported.clear();
    })?;
    Ok(load_state(Path::new(&workspace)))
}
```

- [ ] **Step 4: 提升两个现有函数的可见性**

在 `app/src-tauri/src/github_sync.rs:102` 把：

```rust
fn read_token() -> Result<Option<String>, String> {
```

改成：

```rust
pub(crate) fn read_token() -> Result<Option<String>, String> {
```

在 `app/src-tauri/src/capture_store.rs:343` 把：

```rust
fn yaml_scalar(s: &str) -> String {
```

改成：

```rust
pub(crate) fn yaml_scalar(s: &str) -> String {
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd app/src-tauri && cargo test --lib collections::tests::`

Expected: `test result: ok. 3 passed`。

- [ ] **Step 6: 提交**

```bash
git add app/src-tauri/src/collections.rs app/src-tauri/src/github_sync.rs app/src-tauri/src/capture_store.rs
git commit -m "feat(collections): add collection-source cache"
```

---

### Task 2: GitHub Star 刷新与 upsert

**Files:**
- Modify: `app/src-tauri/src/collections.rs`
- Test: `app/src-tauri/src/collections.rs`（追加到 `tests` 模块）

**Interfaces:**
- Consumes: Task 1 的 `CollectionsState` / `PendingItem` / `mutate_state`；`github_sync::read_token()`。
- Produces: `PendingItem::from_star` 等价实现 `map_star`、`upsert_items`、命令 `collections_refresh_github`、`RefreshOutcome { added, total, truncated }`。

- [ ] **Step 1: 写失败测试**

在 `tests` 模块中追加：

```rust
    #[test]
    fn star_mapping_tolerates_missing_fields() {
        let entry: StarredEntry = serde_json::from_value(serde_json::json!({
            "starred_at": "2026-09-30T12:00:00Z",
            "repo": {
                "full_name": "owner/repo",
                "html_url": "https://github.com/owner/repo"
            }
        }))
        .unwrap();

        let item = map_star(entry);
        assert_eq!(item.id, "github:owner/repo");
        assert_eq!(item.source, "github");
        assert_eq!(item.saved_at.as_deref(), Some("2026-09-30T12:00:00Z"));
        assert_eq!(item.stars, None);
        assert_eq!(item.language, None);
        assert!(item.topics.is_empty());
    }

    #[test]
    fn star_mapping_keeps_all_metadata() {
        let entry: StarredEntry = serde_json::from_value(serde_json::json!({
            "starred_at": "2026-09-30T12:00:00Z",
            "repo": {
                "full_name": "tauri-apps/tauri",
                "html_url": "https://github.com/tauri-apps/tauri",
                "description": "Build smaller, faster, more secure apps",
                "language": "Rust",
                "stargazers_count": 90000,
                "topics": ["desktop", "webview"]
            }
        }))
        .unwrap();

        let item = map_star(entry);
        assert_eq!(item.title, "tauri-apps/tauri");
        assert_eq!(item.stars, Some(90000));
        assert_eq!(item.language.as_deref(), Some("Rust"));
        assert_eq!(item.topics, vec!["desktop", "webview"]);
    }

    #[test]
    fn upsert_replaces_same_id_and_counts_only_new() {
        let mut state = default_state();
        state.items.push(item("github:a/one"));

        let mut fresh = item("github:a/one");
        fresh.stars = Some(7);
        let added = upsert_items(
            &mut state,
            vec![fresh, item("github:a/two")],
        );

        assert_eq!(added, 1);
        assert_eq!(state.items.len(), 2);
        let same = state
            .items
            .iter()
            .find(|i| i.id == "github:a/one")
            .unwrap();
        assert_eq!(same.stars, Some(7));
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd app/src-tauri && cargo test --lib collections::tests::`

Expected: 编译失败，提示 `StarredEntry` / `map_star` / `upsert_items` 未定义。

- [ ] **Step 3: 实现刷新逻辑**

在 `collections.rs` 中、测试模块之前追加：

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshOutcome {
    pub added: u32,
    pub total: u32,
    pub truncated: bool,
}

#[derive(Debug, Deserialize)]
struct StarredEntry {
    #[serde(default)]
    starred_at: Option<String>,
    repo: StarredRepo,
}

#[derive(Debug, Deserialize)]
struct StarredRepo {
    full_name: String,
    html_url: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    stargazers_count: Option<u32>,
    #[serde(default)]
    topics: Vec<String>,
}

fn map_star(entry: StarredEntry) -> PendingItem {
    PendingItem {
        id: format!("github:{}", entry.repo.full_name),
        source: "github".to_string(),
        title: entry.repo.full_name,
        url: entry.repo.html_url,
        saved_at: entry.starred_at,
        description: entry.repo.description,
        language: entry.repo.language,
        stars: entry.repo.stargazers_count,
        topics: entry.repo.topics,
    }
}

fn upsert_items(state: &mut CollectionsState, incoming: Vec<PendingItem>) -> u32 {
    let mut added = 0u32;
    for item in incoming {
        if let Some(existing) = state.items.iter_mut().find(|i| i.id == item.id) {
            *existing = item;
        } else {
            state.items.push(item);
            added += 1;
        }
    }
    added
}

async fn fetch_starred_page(token: &str, page: u32) -> Result<Vec<StarredEntry>, String> {
    let url = format!(
        "https://api.github.com/user/starred?sort=created&direction=desc&per_page=100&page={page}"
    );
    let res = reqwest::Client::new()
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github.star+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "SoloMD-collections/1")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("GitHub API {status}: {body}"));
    }
    res.json::<Vec<StarredEntry>>()
        .await
        .map_err(|e| e.to_string())
}

async fn fetch_all_starred(token: &str) -> Result<(Vec<PendingItem>, bool), String> {
    let mut out = Vec::new();
    let mut truncated = false;
    for page in 1..=10u32 {
        let batch = fetch_starred_page(token, page).await?;
        let short = batch.len() < 100;
        out.extend(batch.into_iter().map(map_star));
        if short {
            break;
        }
        if page == 10 {
            truncated = true;
        }
    }
    Ok((out, truncated))
}

#[tauri::command]
pub async fn collections_refresh_github(workspace: String) -> Result<RefreshOutcome, String> {
    let token = super::github_sync::read_token()?
        .ok_or_else(|| "no GitHub token set".to_string())?;
    let (incoming, truncated) = fetch_all_starred(&token).await?;
    let workspace = PathBuf::from(workspace);

    // 网络成功之后才动缓存：刷新失败绝不能清空待导入列表。
    let (added, total) = mutate_state(&workspace, |state| {
        let added = upsert_items(state, incoming);
        state.last_refresh.insert("github".to_string(), now_ms());
        (added, state.items.len() as u32)
    })?;

    Ok(RefreshOutcome {
        added,
        total,
        truncated,
    })
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd app/src-tauri && cargo test --lib collections::tests::`

Expected: `6 passed`。

- [ ] **Step 5: 提交**

```bash
git add app/src-tauri/src/collections.rs
git commit -m "feat(collections): refresh GitHub stars into the cache"
```

---

### Task 3: 导入条目（抓取 + frontmatter + 失败清理）

**Files:**
- Modify: `app/src-tauri/src/collections.rs`
- Test: `app/src-tauri/src/collections.rs`（追加到 `tests` 模块）

**Interfaces:**
- Consumes: Task 1/2 的类型；`capture_store::capture_fetch_page`、`FetchOutcome`、`yaml_scalar`；`capture_endpoint::current_target()`。
- Produces: `ImportOutcome { path, warning, error }`、`frontmatter_with_item(&str,&PendingItem) -> String`、`finish_import(&Path,&PendingItem,FetchOutcome) -> Result<ImportOutcome,String>`、命令 `collections_import(workspace,id)`。

- [ ] **Step 1: 写失败测试**

在 `tests` 模块中追加：

```rust
    #[test]
    fn frontmatter_adds_inbox_and_metadata_once() {
        let body = "---\ntitle: tauri\n---\n\n# Tauri\n";
        let mut it = item("github:tauri-apps/tauri");
        it.topics = vec!["desktop".to_string(), "webview".to_string()];

        let once = frontmatter_with_item(body, &it);
        assert!(once.contains("inbox: true\n"));
        assert!(once.contains("stars: 42\n"));
        assert!(once.contains("language: Rust\n"));
        assert!(once.contains("topics:\n  - desktop\n  - webview\n"));
        assert!(once.contains("starred: \"2026-10-01T00:00:00Z\"\n"));

        // 幂等：第二次调用不新增任何键。
        let twice = frontmatter_with_item(&once, &it);
        assert_eq!(once, twice);
        assert_eq!(twice.matches("inbox:").count(), 1);
    }

    #[test]
    fn failed_capture_removes_stub_and_keeps_item_pending() {
        let dir = tempfile::tempdir().unwrap();
        let stub = dir.path().join("stub.md");
        std::fs::write(&stub, "---\ntitle: stub\n---\n").unwrap();

        let out = finish_import(
            dir.path(),
            &item("github:owner/repo"),
            super::super::capture_store::FetchOutcome {
                url: "https://github.com/owner/repo".to_string(),
                title: "owner__repo".to_string(),
                path: Some(stub.to_string_lossy().to_string()),
                via: "stub".to_string(),
                error: Some("404".to_string()),
            },
        )
        .unwrap();

        assert_eq!(out.error.as_deref(), Some("404"));
        assert!(!stub.exists(), "stub must be deleted so retry does not duplicate");
        assert!(load_state(dir.path()).imported.is_empty());
    }

    #[test]
    fn successful_import_writes_inbox_flag_and_records_path() {
        let dir = tempfile::tempdir().unwrap();
        let note = dir.path().join("owner__repo.md");
        std::fs::write(&note, "---\ntitle: owner__repo\n---\n\nREADME\n").unwrap();

        let out = finish_import(
            dir.path(),
            &item("github:owner/repo"),
            super::super::capture_store::FetchOutcome {
                url: "https://github.com/owner/repo".to_string(),
                title: "owner__repo".to_string(),
                path: Some(note.to_string_lossy().to_string()),
                via: "readme".to_string(),
                error: None,
            },
        )
        .unwrap();

        assert!(out.error.is_none());
        let body = std::fs::read_to_string(&note).unwrap();
        assert!(body.contains("inbox: true"));
        assert!(body.contains("stars: 42"));
        assert_eq!(
            load_state(dir.path())
                .imported
                .get("github:owner/repo")
                .map(String::as_str),
            Some(note.to_string_lossy().as_ref())
        );
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd app/src-tauri && cargo test --lib collections::tests::`

Expected: 编译失败，提示 `frontmatter_with_item` / `finish_import` 未定义。

- [ ] **Step 3: 实现导入**

在 `collections.rs` 中、测试模块之前追加：

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub path: Option<String>,
    /// 导入成功但有非致命问题（例如 frontmatter 补写失败）。
    pub warning: Option<String>,
    /// 导入失败；Some 时条目仍待导入。
    pub error: Option<String>,
}

fn import_dir(workspace: &Path) -> PathBuf {
    match super::capture_endpoint::current_target() {
        Some((_workspace, folder)) => workspace.join(folder),
        None => workspace.join("inbox"),
    }
}

/// 在 frontmatter 里补字段；已有同名键不重复写，因此可安全调用两次。
pub fn frontmatter_with_item(body: &str, item: &PendingItem) -> String {
    let mut lines: Vec<String> = body.lines().map(str::to_string).collect();
    let Some(close) = lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, line)| line.as_str() == "---")
        .map(|(i, _)| i)
    else {
        return body.to_string();
    };

    let has = |prefix: &str| {
        lines[..close]
            .iter()
            .any(|line| line.trim_start().starts_with(prefix))
    };

    let mut add: Vec<String> = Vec::new();
    if !has("inbox:") {
        add.push("inbox: true".to_string());
    }
    if let Some(stars) = item.stars {
        if !has("stars:") {
            add.push(format!("stars: {stars}"));
        }
    }
    if let Some(language) = item.language.as_deref().filter(|v| !v.trim().is_empty()) {
        if !has("language:") {
            add.push(format!("language: {}", super::capture_store::yaml_scalar(language)));
        }
    }
    if !item.topics.is_empty() && !has("topics:") {
        add.push("topics:".to_string());
        for topic in &item.topics {
            add.push(format!(
                "  - {}",
                super::capture_store::yaml_scalar(topic)
            ));
        }
    }
    if let Some(saved) = item.saved_at.as_deref().filter(|v| !v.trim().is_empty()) {
        if !has("starred:") {
            add.push(format!("starred: {}", super::capture_store::yaml_scalar(saved)));
        }
    }

    let mut out: Vec<String> = Vec::with_capacity(lines.len() + add.len());
    out.extend_from_slice(&lines[..close]);
    out.extend(add);
    out.extend_from_slice(&lines[close..]);
    lines = out;
    let mut text = lines.join("\n");
    text.push('\n');
    text
}

fn apply_frontmatter(path: &Path, item: &PendingItem) -> Result<(), String> {
    let body = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let updated = frontmatter_with_item(&body, item);
    if !updated.contains("inbox: true") {
        return Err("笔记没有可识别的 frontmatter，未写入 inbox 标记".to_string());
    }
    if updated != body {
        fs::write(path, updated).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 把一次 `capture_fetch_page` 的结果落成待导入条目状态。
///
/// 同步函数，方便单测：抓取本身在命令里做，这里只处理结果。
pub fn finish_import(
    workspace: &Path,
    item: &PendingItem,
    outcome: super::capture_store::FetchOutcome,
) -> Result<ImportOutcome, String> {
    match (outcome.error, outcome.path) {
        (Some(error), path) => {
            // 抓取失败留下的是存根。删掉它，否则用户重试会得到 -2、-3。
            if let Some(path) = path {
                let _ = fs::remove_file(path);
            }
            Ok(ImportOutcome {
                path: None,
                warning: None,
                error: Some(error),
            })
        }
        (None, Some(path)) => {
            let warning = apply_frontmatter(Path::new(&path), item).err();
            mutate_state(workspace, |state| {
                state.imported.insert(item.id.clone(), path.clone());
            })?;
            Ok(ImportOutcome {
                path: Some(path),
                warning,
                error: None,
            })
        }
        (None, None) => Ok(ImportOutcome {
            path: None,
            warning: None,
            error: Some("抓取没有写出文件".to_string()),
        }),
    }
}

#[tauri::command]
pub async fn collections_import(workspace: String, id: String) -> Result<ImportOutcome, String> {
    let workspace = PathBuf::from(workspace);
    let item = load_state(&workspace)
        .items
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| format!("unknown collection item: {id}"))?;

    let dir = import_dir(&workspace);
    let outcome = super::capture_store::capture_fetch_page(
        dir.to_string_lossy().to_string(),
        item.url.clone(),
        item.title.clone(),
        None,
    )
    .await?;

    finish_import(&workspace, &item, outcome)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd app/src-tauri && cargo test --lib collections::tests::`

Expected: `9 passed`。

- [ ] **Step 5: 提交**

```bash
git add app/src-tauri/src/collections.rs
git commit -m "feat(collections): import GitHub stars into inbox notes"
```

---

### Task 4: 双注册命令

**Files:**
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src-tauri/src/runner.rs`

**Interfaces:**
- Consumes: Task 1–3 的命令。
- Produces: 前端可调用的 `collections_load` / `collections_refresh_github` / `collections_import` / `collections_dismiss` / `collections_clear_history`。

- [ ] **Step 1: 在 lib.rs 声明模块**

在 `app/src-tauri/src/lib.rs` 的 `pub mod bookmarks;` 之后加入：

```rust
// 收藏源（一期：GitHub Star）。依赖 github_sync，随 Android 一起编译掉。
#[cfg(not(target_os = "android"))]
pub mod collections;
```

- [ ] **Step 2: 在 lib.rs 注册命令**

在 `lib.rs` 的 `bookmarks::bookmarks_apply,` 之后加入：

```rust
            #[cfg(not(target_os = "android"))]
            collections::collections_load,
            #[cfg(not(target_os = "android"))]
            collections::collections_refresh_github,
            #[cfg(not(target_os = "android"))]
            collections::collections_import,
            #[cfg(not(target_os = "android"))]
            collections::collections_dismiss,
            #[cfg(not(target_os = "android"))]
            collections::collections_clear_history,
```

- [ ] **Step 3: 在 runner.rs 声明模块**

在 `app/src-tauri/src/runner.rs` 的 `#[path = "github_sync.rs"] mod github_sync;` 之后加入：

```rust
// 收藏源（一期：GitHub Star）—— 二进制侧的 invoke handler 在本文件，
// 必须与 lib.rs 双注册。
#[cfg(not(target_os = "android"))]
#[path = "collections.rs"]
mod collections;
```

- [ ] **Step 4: 在 runner.rs 注册命令**

在 `runner.rs` 的 `bookmarks::bookmarks_apply,` 之后加入同样的五行：

```rust
            #[cfg(not(target_os = "android"))]
            collections::collections_load,
            #[cfg(not(target_os = "android"))]
            collections::collections_refresh_github,
            #[cfg(not(target_os = "android"))]
            collections::collections_import,
            #[cfg(not(target_os = "android"))]
            collections::collections_dismiss,
            #[cfg(not(target_os = "android"))]
            collections::collections_clear_history,
```

- [ ] **Step 5: 编译并运行测试**

Run: `cd app/src-tauri && cargo test --lib collections::tests:: && cargo check`

Expected: 测试 `9 passed`；`cargo check` 成功（警告可以忽略）。

- [ ] **Step 6: 提交**

```bash
git add app/src-tauri/src/lib.rs app/src-tauri/src/runner.rs
git commit -m "feat(collections): register collection commands in both roots"
```

---

### Task 5: 前端可见条目过滤（纯函数 + 测试）

**Files:**
- Create: `app/src/lib/collections-filter.ts`
- Test: `app/src/lib/collections-filter.test.ts`

**Interfaces:**
- Consumes: `bookmark-dedupe.ts` 的 `shouldCapture` / `DedupeIndex`。
- Produces: `PendingItem` / `CollectionsState` TS 类型、`visibleItems(state, dedupe, normalized)`（Task 6 使用）。

- [ ] **Step 1: 写失败测试**

创建 `app/src/lib/collections-filter.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleItems, type CollectionsState, type PendingItem } from './collections-filter.ts';
import type { DedupeIndex } from './bookmark-dedupe.ts';

function item(id: string, savedAt: string | null): PendingItem {
  return {
    id,
    source: 'github',
    title: id.replace('github:', ''),
    url: `https://github.com/${id.replace('github:', '')}`,
    savedAt,
    description: null,
    language: null,
    stars: null,
    topics: [],
  };
}

function state(items: PendingItem[], dismissed: string[] = [], imported: string[] = []): CollectionsState {
  return {
    version: 1,
    items,
    dismissed,
    imported: Object.fromEntries(imported.map((id) => [id, '/vault/inbox/x.md'])),
    lastRefresh: {},
  };
}

function emptyDedupe(): DedupeIndex {
  return { capturedUrls: new Set(), noteLinkedUrls: new Set(), capturedTitles: new Set() };
}

function normalized(pairs: [string, string][]): Map<string, string> {
  return new Map(pairs);
}

test('dismissed and imported items are hidden', () => {
  const s = state(
    [item('github:a/one', '2026-10-01T00:00:00Z'), item('github:a/two', '2026-10-02T00:00:00Z')],
    ['github:a/one'],
    ['github:a/two'],
  );
  const out = visibleItems(
    s,
    emptyDedupe(),
    normalized([
      ['github:a/one', 'https://github.com/a/one'],
      ['github:a/two', 'https://github.com/a/two'],
    ]),
  );
  assert.deepEqual(out, []);
});

test('captured URL and note-linked URL are hidden after normalization', () => {
  const s = state([
    item('github:a/captured', '2026-10-01T00:00:00Z'),
    item('github:a/linked', '2026-10-02T00:00:00Z'),
    item('github:a/new', '2026-10-03T00:00:00Z'),
  ]);
  const dedupe: DedupeIndex = {
    capturedUrls: new Set(['https://github.com/a/captured']),
    noteLinkedUrls: new Set(['https://github.com/a/linked?utm_source=x']),
    capturedTitles: new Set(),
  };
  const out = visibleItems(
    s,
    dedupe,
    normalized([
      ['github:a/captured', 'https://github.com/a/captured'],
      ['github:a/linked', 'https://github.com/a/linked?utm_source=x'],
      ['github:a/new', 'https://github.com/a/new'],
    ]),
  );
  assert.deepEqual(
    out.map((i) => i.id),
    ['github:a/new'],
  );
});

test('sorts newest savedAt first and keeps unknown dates last', () => {
  const s = state([
    item('github:a/old', '2026-09-01T00:00:00Z'),
    item('github:a/unknown', null),
    item('github:a/new', '2026-10-01T00:00:00Z'),
  ]);
  const out = visibleItems(
    s,
    emptyDedupe(),
    normalized([
      ['github:a/old', 'https://github.com/a/old'],
      ['github:a/unknown', 'https://github.com/a/unknown'],
      ['github:a/new', 'https://github.com/a/new'],
    ]),
  );
  assert.deepEqual(
    out.map((i) => i.id),
    ['github:a/new', 'github:a/old', 'github:a/unknown'],
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd app && node --test --experimental-strip-types --import ./scripts/test-register.mjs src/lib/collections-filter.test.ts`

Expected: 失败，提示找不到 `./collections-filter.ts`。

- [ ] **Step 3: 实现纯函数**

创建 `app/src/lib/collections-filter.ts`：

```ts
/**
 * 收藏源 → 收件箱“待导入”的可见条目过滤。
 *
 * 保持纯函数：不碰 Tauri、不碰 store，方便用 node:test 覆盖去重规则。
 * 去重复用书签同步的 `shouldCapture`，确保两处的“已采集”判断一致。
 */
import { shouldCapture, type DedupeIndex } from './bookmark-dedupe.ts';

export interface PendingItem {
  id: string;
  source: string;
  title: string;
  url: string;
  savedAt?: string | null;
  description?: string | null;
  language?: string | null;
  stars?: number | null;
  topics?: string[];
}

export interface CollectionsState {
  version: number;
  items: PendingItem[];
  dismissed: string[];
  imported: Record<string, string>;
  lastRefresh: Record<string, number>;
}

function savedAtMs(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

export function visibleItems(
  state: CollectionsState,
  dedupe: DedupeIndex,
  normalized: ReadonlyMap<string, string>,
): PendingItem[] {
  const dismissed = new Set(state.dismissed);
  const imported = new Set(Object.keys(state.imported));

  return state.items
    .filter((item) => {
      if (dismissed.has(item.id) || imported.has(item.id)) return false;
      const url = normalized.get(item.id) || item.url;
      return shouldCapture({ title: item.title, normalized_url: url }, dedupe);
    })
    .sort((a, b) => {
      const am = savedAtMs(a.savedAt);
      const bm = savedAtMs(b.savedAt);
      if (am !== bm) {
        if (!Number.isFinite(am)) return 1;
        if (!Number.isFinite(bm)) return -1;
        return bm - am;
      }
      return a.title.localeCompare(b.title);
    });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd app && node --test --experimental-strip-types --import ./scripts/test-register.mjs src/lib/collections-filter.test.ts`

Expected: `3 passing`。

- [ ] **Step 5: 提交**

```bash
git add app/src/lib/collections-filter.ts app/src/lib/collections-filter.test.ts
git commit -m "feat(collections): filter pending imports by dedupe rules"
```

---

### Task 6: Pinia store、设置项与启动调度

**Files:**
- Create: `app/src/stores/collections.ts`
- Modify: `app/src/stores/settings.ts:512-516,825-827`
- Modify: `app/src/App.vue:96,178,875,1362`

**Interfaces:**
- Consumes: Task 4 的命令；Task 5 的 `visibleItems` / 类型；`useWorkspaceStore`、`useWorkspaceIndexStore`、`useSettingsStore`、`useToastsStore`。
- Produces: `useCollectionsStore()`，字段 `pendingItems`、`available`、`lastError`、`refreshing`、`importingIds`，动作 `start/load/refresh/importOne/importAll/dismiss/clearHistory`（Task 7/8 使用）。

- [ ] **Step 1: 加设置项**

在 `app/src/stores/settings.ts` 的 `interface Settings` 中、`bookmarkSyncFingerprint: string;` 之后加入：

```ts
  // 收藏源（一期：GitHub Star）。默认关，避免用户没配 token 时反复报错。
  collectionGithubEnabled: boolean;
  collectionRefreshMinutes: number;
```

在 `defaults()` 的 `bookmarkSyncFingerprint: '',` 之后加入：

```ts
    collectionGithubEnabled: false,
    collectionRefreshMinutes: 30,
```

- [ ] **Step 2: 写 store**

创建 `app/src/stores/collections.ts`：

```ts
/**
 * 收藏源前端状态：加载缓存、按需刷新、批量导入。
 *
 * “哪些还没导入”不落盘 —— 由 workspace index 实时算出（见
 * lib/collections-filter.ts）。这样用户在任何地方手动建过同 URL 笔记，
 * 都不会被再次导入。
 */
import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';

import { useSettingsStore } from './settings';
import { useWorkspaceStore } from './workspace';
import { useWorkspaceIndexStore } from './workspaceIndex';
import { useToastsStore } from './toasts';
import { hasGitBackend, isMobile } from '../lib/platform';
import { noteTitleKey, type DedupeIndex } from '../lib/bookmark-dedupe';
import {
  visibleItems,
  type CollectionsState,
  type PendingItem,
} from '../lib/collections-filter';
import { useI18n } from '../i18n';

interface ImportOutcome {
  path: string | null;
  warning: string | null;
  error: string | null;
}

/** 归一化 URL 缓存：id → capture_normalize_url 的结果。进程内即可。 */
const normalizedUrls = new Map<string, string>();

export const useCollectionsStore = defineStore('collections', {
  state: () => ({
    state: null as CollectionsState | null,
    pendingItems: [] as PendingItem[],
    loading: false,
    refreshing: false,
    importingIds: [] as string[],
    lastError: null as string | null,
  }),

  getters: {
    available(): boolean {
      return !isMobile() && hasGitBackend() && !!useWorkspaceStore().currentFolder;
    },
  },

  actions: {
    buildDedupe(): DedupeIndex {
      const index = useWorkspaceIndexStore();
      const capturedUrls = new Set<string>();
      const noteLinkedUrls = new Set<string>();
      const capturedTitles = new Set<string>();
      for (const note of index.entries) {
        for (const link of note.links ?? []) {
          if (link.normalized_url) noteLinkedUrls.add(link.normalized_url);
        }
        if (!note.captured_url) continue;
        capturedUrls.add(note.captured_url);
        capturedTitles.add(noteTitleKey(note.stem));
      }
      return { capturedUrls, noteLinkedUrls, capturedTitles };
    },

    recomputePending() {
      this.pendingItems = this.state
        ? visibleItems(this.state, this.buildDedupe(), normalizedUrls)
        : [];
    },

    async load() {
      if (!this.available) {
        this.state = null;
        this.pendingItems = [];
        return;
      }
      this.loading = true;
      try {
        const state = await invoke<CollectionsState>('collections_load', {
          workspace: useWorkspaceStore().currentFolder,
        });
        this.state = state;
        for (const item of state.items) {
          if (normalizedUrls.has(item.id)) continue;
          normalizedUrls.set(
            item.id,
            await invoke<string>('capture_normalize_url', { url: item.url }).catch(() => item.url),
          );
        }
        this.recomputePending();
      } catch (e) {
        this.lastError = String(e);
      } finally {
        this.loading = false;
      }
    },

    async start() {
      if (!this.available) return;
      await this.load();
      void this.maybeRefresh();
    },

    async maybeRefresh(force = false) {
      if (!this.available) return;
      const settings = useSettingsStore();
      if (!settings.collectionGithubEnabled || this.refreshing) return;
      const last = this.state?.lastRefresh?.github ?? 0;
      const interval = Math.max(1, settings.collectionRefreshMinutes) * 60_000;
      if (!force && Date.now() - last < interval) return;
      await this.refresh();
    },

    async refresh() {
      if (!this.available || this.refreshing) return;
      this.refreshing = true;
      this.lastError = null;
      try {
        await invoke('collections_refresh_github', {
          workspace: useWorkspaceStore().currentFolder,
        });
        await this.load();
      } catch (e) {
        this.lastError = String(e);
      } finally {
        this.refreshing = false;
      }
    },

    async importOne(item: PendingItem, reload = true): Promise<{ ok: boolean }> {
      if (this.importingIds.includes(item.id)) return { ok: false };
      const { t } = useI18n();
      const toasts = useToastsStore();
      this.importingIds = [...this.importingIds, item.id];
      try {
        const out = await invoke<ImportOutcome>('collections_import', {
          workspace: useWorkspaceStore().currentFolder,
          id: item.id,
        });
        if (out.error) {
          this.lastError = out.error;
          toasts.error(t('inbox.pendingImport.importFailed', { title: item.title, error: out.error }));
          return { ok: false };
        }
        if (out.warning) {
          toasts.info(t('inbox.pendingImport.importWarning', { title: item.title, error: out.warning }));
        } else {
          toasts.success(t('inbox.pendingImport.importedOne', { title: item.title }));
        }
        // 单条导入后立刻刷新：后端已把 id 写进 imported，条目会从列表消失。
        if (reload) await this.load();
        return { ok: true };
      } catch (e) {
        const error = String(e);
        this.lastError = error;
        toasts.error(t('inbox.pendingImport.importFailed', { title: item.title, error }));
        return { ok: false };
      } finally {
        this.importingIds = this.importingIds.filter((id) => id !== item.id);
      }
    },

    async importAll() {
      const items = [...this.pendingItems];
      if (items.length === 0) return;
      let ok = 0;
      let failed = 0;
      for (const item of items) {
        const result = await this.importOne(item, false);
        if (result.ok) ok += 1;
        else failed += 1;
      }
      await this.load();
      const { t } = useI18n();
      const toasts = useToastsStore();
      if (failed === 0) {
        toasts.success(t('inbox.pendingImport.importedAll', { n: String(ok) }));
      } else {
        toasts.error(
          t('inbox.pendingImport.importFinished', { ok: String(ok), failed: String(failed) }),
        );
      }
    },

    async dismiss(id: string) {
      if (!this.available) return;
      try {
        this.state = await invoke<CollectionsState>('collections_dismiss', {
          workspace: useWorkspaceStore().currentFolder,
          id,
        });
        this.recomputePending();
      } catch (e) {
        this.lastError = String(e);
      }
    },

    async clearHistory() {
      if (!this.available) return;
      try {
        this.state = await invoke<CollectionsState>('collections_clear_history', {
          workspace: useWorkspaceStore().currentFolder,
        });
        this.recomputePending();
      } catch (e) {
        this.lastError = String(e);
      }
    },
  },
});
```

- [ ] **Step 3: 在 App.vue 接启动与工作区切换**

在 `app/src/App.vue` 的 `import { useBookmarkSyncStore } from './stores/bookmarkSync';` 之后加入：

```ts
import { useCollectionsStore } from './stores/collections';
```

在 `const bookmarkSync = useBookmarkSyncStore();` 之后加入：

```ts
const collections = useCollectionsStore();
```

在 `if (folder) bookmarkSync.kick();`（约 875 行）之后加入：

```ts
    if (folder) void collections.start();
```

在 `bookmarkSync.start();`（约 1362 行）之后加入：

```ts
  void collections.start();
```

- [ ] **Step 4: 类型检查**

Run: `cd app && npx vue-tsc --noEmit`

Expected: 无错误。

- [ ] **Step 5: 提交**

```bash
git add app/src/stores/collections.ts app/src/stores/settings.ts app/src/App.vue
git commit -m "feat(collections): add store and startup refresh"
```

---

### Task 7: 收件箱「待导入收藏」区

**Files:**
- Modify: `app/src/components/InboxView.vue`
- Modify: `app/src/i18n/en.ts`（`inbox` 块）
- Modify: `app/src/i18n/zh.ts`（`inbox` 块）

**Interfaces:**
- Consumes: Task 6 的 `useCollectionsStore()`。
- Produces: 收件箱可见的待导入列表与单条/批量/忽略操作。

- [ ] **Step 1: 加 i18n 文案**

在 `app/src/i18n/en.ts` 的 `inbox` 块中、`showAll: 'Show all',` 之后加入：

```ts
    pendingImport: {
      heading: 'Pending imports',
      count: '{n} waiting',
      refresh: 'Refresh',
      refreshFailed: 'Refresh failed: {error}',
      importAll: 'Import all',
      import: 'Import',
      importing: 'Importing…',
      ignore: 'Ignore',
      importedOne: 'Imported “{title}”',
      importedAll: 'Imported {n} items',
      importFinished: '{ok} imported · {failed} failed',
      importFailed: 'Could not import “{title}”: {error}',
      importWarning: 'Imported “{title}” with a warning: {error}',
      sourceGithub: 'GitHub Star',
    },
```

在 `app/src/i18n/zh.ts` 的 `inbox` 块中、`showAll: "显示全部",` 之后加入：

```ts
    pendingImport: {
      heading: '待导入收藏',
      count: '待导入 {n} 条',
      refresh: '刷新',
      refreshFailed: '刷新失败：{error}',
      importAll: '全部导入',
      import: '导入',
      importing: '导入中…',
      ignore: '忽略',
      importedOne: '已导入《{title}》',
      importedAll: '已导入 {n} 条',
      importFinished: '成功 {ok} 条 · 失败 {failed} 条',
      importFailed: '《{title}》导入失败：{error}',
      importWarning: '《{title}》已导入，但有提示：{error}',
      sourceGithub: 'GitHub Star',
    },
```

- [ ] **Step 2: 接 store 与操作**

在 `InboxView.vue` 的 `import { INBOX_CLOSE_EVENT } from '../composables/useInboxView';` 之后加入：

```ts
import { useCollectionsStore } from '../stores/collections';
```

在 `const idx = useWorkspaceIndexStore();` 之后加入：

```ts
const collections = useCollectionsStore();
```

在 `const canOrganize = computed(...)` 之后加入：

```ts
const pendingItems = computed(() => collections.pendingItems);
function isImporting(id: string): boolean {
  return collections.importingIds.includes(id);
}
async function importItem(id: string) {
  const item = pendingItems.value.find((i) => i.id === id);
  if (item) await collections.importOne(item);
}
async function dismissItem(id: string) {
  await collections.dismiss(id);
}
```

在 `onMounted(() => { inbox.setInboxViewOpen(true);` 之后加入：

```ts
  void collections.load();
  void collections.maybeRefresh();
```

- [ ] **Step 3: 加模板区块**

在 `InboxView.vue` 的 `</header>` 之后、第一个 `<div v-if="totalInbox === 0"` 之前加入：

```html
    <section v-if="pendingItems.length" class="inbox-view__pending">
      <div class="inbox-view__pending-head">
        <h2 class="inbox-view__pending-title">{{ t('inbox.pendingImport.heading') }}</h2>
        <span class="inbox-view__pending-count">
          {{ t('inbox.pendingImport.count', { n: String(pendingItems.length) }) }}
        </span>
        <span class="pg-spacer" />
        <button
          class="rp-btn"
          type="button"
          :disabled="collections.refreshing"
          @click="collections.refresh()"
        >
          {{ t('inbox.pendingImport.refresh') }}
        </button>
        <button
          class="rp-btn rp-btn--primary"
          type="button"
          :disabled="collections.importingIds.length > 0"
          @click="collections.importAll()"
        >
          {{ t('inbox.pendingImport.importAll') }}
        </button>
      </div>

      <p v-if="collections.lastError" class="inbox-view__pending-error">
        {{ t('inbox.pendingImport.refreshFailed', { error: collections.lastError }) }}
      </p>

      <div class="inbox-view__pending-list" role="list">
        <div
          v-for="item in pendingItems"
          :key="item.id"
          class="inbox-view__pending-row"
          role="listitem"
        >
          <span class="inbox-view__pending-main">
            <span class="inbox-view__pending-name">{{ item.title }}</span>
            <span v-if="item.description" class="inbox-view__pending-desc">
              {{ item.description }}
            </span>
            <span class="inbox-view__pending-sub">
              <span class="rp-chip">{{ t('inbox.pendingImport.sourceGithub') }}</span>
              <span v-if="item.language" class="rp-chip">{{ item.language }}</span>
              <span v-if="item.stars != null" class="rp-chip">★ {{ item.stars }}</span>
            </span>
          </span>
          <span class="inbox-view__pending-actions">
            <button
              class="rp-btn rp-btn--primary"
              type="button"
              :disabled="isImporting(item.id)"
              @click="importItem(item.id)"
            >
              {{ isImporting(item.id) ? t('inbox.pendingImport.importing') : t('inbox.pendingImport.import') }}
            </button>
            <button
              class="rp-btn"
              type="button"
              :disabled="isImporting(item.id)"
              @click="dismissItem(item.id)"
            >
              {{ t('inbox.pendingImport.ignore') }}
            </button>
          </span>
        </div>
      </div>
    </section>
```

- [ ] **Step 4: 加样式**

在 `InboxView.vue` 的 `<style scoped>` 内追加：

```css
.inbox-view__pending {
  margin: 12px 16px 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  background: var(--bg-elev);
  max-height: 44vh;
  overflow: auto;
}
.inbox-view__pending-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.inbox-view__pending-title {
  margin: 0;
  font-size: 14px;
}
.inbox-view__pending-count {
  font-size: 12px;
  color: var(--text-faint);
}
.inbox-view__pending-error {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--danger);
}
.inbox-view__pending-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.inbox-view__pending-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px;
  border-radius: 8px;
  background: var(--bg);
}
.inbox-view__pending-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}
.inbox-view__pending-name {
  font-weight: 600;
}
.inbox-view__pending-desc {
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.inbox-view__pending-sub {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.inbox-view__pending-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
```

- [ ] **Step 5: 类型检查 + 现有收件箱测试**

Run: `cd app && npx vue-tsc --noEmit && node --test --experimental-strip-types --import ./scripts/test-register.mjs src/composables/useInbox.test.ts`

Expected: 无类型错误；既有测试通过。

- [ ] **Step 6: 提交**

```bash
git add app/src/components/InboxView.vue app/src/i18n/en.ts app/src/i18n/zh.ts
git commit -m "feat(collections): show pending imports in the inbox"
```

---

### Task 8: 设置 → 集成里的收藏源卡片

**Files:**
- Create: `app/src/components/CollectionSourcesSettings.vue`
- Modify: `app/src/components/SettingsPanel.vue:43-50,296-310,2116`
- Modify: `app/src/i18n/en.ts`（`settings` 块）
- Modify: `app/src/i18n/zh.ts`（`settings` 块）

**Interfaces:**
- Consumes: Task 6 的 store 与设置项；`github_has_token`。
- Produces: 收藏源开关、立即刷新、清空记录、跳转 GitHub 设置。

- [ ] **Step 1: 加 i18n 文案**

在 `app/src/i18n/en.ts` 的 `settings` 块中、`bookmarkSync: { ... },` 之后加入：

```ts
    collectionSources: {
      heading: 'Collection sources',
      hint: 'Pull saved items from external accounts. Anything not yet imported shows up in the Inbox.',
      githubHeading: 'GitHub Stars',
      githubHint: 'Stars from the GitHub account connected under Sync. Imported notes include the repo description, language, topics and README.',
      connected: 'Connected',
      notConnected: 'GitHub is not connected',
      connectHint: 'Connect a Personal Access Token under Settings → Sync → GitHub first.',
      goToGithub: 'Open GitHub sync settings',
      recheck: 'Recheck connection',
      enable: 'Show GitHub Stars in the Inbox',
      interval: 'Refresh every',
      minutes: '{count} min',
      refreshNow: 'Refresh now',
      refreshing: 'Refreshing…',
      lastRefresh: 'Last refresh:',
      never: 'Never',
      pending: '{n} pending',
      clearHistory: 'Clear ignored / imported history',
      clearConfirm: 'Clear the ignored and imported records? Imported items may show up again.',
      clearDone: 'Collection history cleared',
      noWorkspace: 'Open a workspace folder first.',
      disabledHere: 'Collection sources are available on desktop only.',
      toutiaoHeading: 'Toutiao',
      toutiaoSoon: 'Coming in the next phase — sign in once in the built-in browser and your saved articles will appear in the Inbox.',
      lastError: 'Last error: {error}',
    },
```

在 `app/src/i18n/zh.ts` 的 `settings` 块中、对应的 `bookmarkSync: { ... },` 之后加入：

```ts
    collectionSources: {
      heading: '收藏源',
      hint: '从外部账号拉取收藏。尚未导入的内容会出现在收件箱里。',
      githubHeading: 'GitHub Star',
      githubHint: '使用「同步」里已连接的 GitHub 账号读取 Star。导入的笔记会带上仓库描述、语言、topics 和 README。',
      connected: '已连接',
      notConnected: 'GitHub 尚未连接',
      connectHint: '请先在 设置 → 同步 → GitHub 里连接 Personal Access Token。',
      goToGithub: '前往 GitHub 同步设置',
      recheck: '重新检测连接',
      enable: '在收件箱显示 GitHub Star',
      interval: '刷新间隔',
      minutes: '{count} 分钟',
      refreshNow: '立即刷新',
      refreshing: '刷新中…',
      lastRefresh: '上次刷新：',
      never: '尚未刷新',
      pending: '待导入 {n} 条',
      clearHistory: '清空已忽略 / 已导入记录',
      clearConfirm: '清空已忽略和已导入的记录？已导入的内容可能会重新出现。',
      clearDone: '收藏记录已清空',
      noWorkspace: '先打开一个工作区文件夹。',
      disabledHere: '收藏源仅在桌面端可用。',
      toutiaoHeading: '今日头条',
      toutiaoSoon: '下一期支持：在内嵌浏览器里登录一次，收藏的文章就会出现在收件箱。',
      lastError: '上次错误：{error}',
    },
```

- [ ] **Step 2: 创建设置组件**

创建 `app/src/components/CollectionSourcesSettings.vue`：

```vue
<script setup lang="ts">
/**
 * Settings → Integrations → Collection sources.
 *
 * Phase 1 only wires GitHub Star. Toutiao is a labelled placeholder so the
 * surface and copy are settled before the browser work lands.
 */
import { computed, onMounted, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../stores/settings';
import { useCollectionsStore } from '../stores/collections';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';

const { t } = useI18n();
const settings = useSettingsStore();
const collections = useCollectionsStore();
const toasts = useToastsStore();
const githubConnected = ref(false);

const pendingCount = computed(() => collections.pendingItems.length);
const lastRefresh = computed(() => collections.state?.lastRefresh?.github ?? 0);
const lastRefreshLabel = computed(() => {
  if (!lastRefresh.value) return t('settings.collectionSources.never');
  return new Date(lastRefresh.value).toLocaleString();
});

async function checkConnection() {
  githubConnected.value = await invoke<boolean>('github_has_token').catch(() => false);
}

function persistToggle() {
  settings.persist();
}

function setMinutes(event: Event) {
  const n = Number((event.target as HTMLInputElement).value);
  settings.collectionRefreshMinutes = Number.isFinite(n)
    ? Math.max(1, Math.min(1440, Math.round(n)))
    : 30;
  settings.persist();
}

async function refreshNow() {
  await collections.refresh();
}

function openGithubSettings() {
  window.dispatchEvent(
    new CustomEvent('solomd:settings-section', { detail: { section: 'sync' } }),
  );
}

async function clearHistory() {
  if (!window.confirm(t('settings.collectionSources.clearConfirm'))) return;
  await collections.clearHistory();
  toasts.success(t('settings.collectionSources.clearDone'));
}

onMounted(() => {
  void checkConnection();
  void collections.load();
});
</script>

<template>
  <section class="collection-sources">
    <h3 class="collection-sources__heading">{{ t('settings.collectionSources.heading') }}</h3>
    <p class="collection-sources__hint">{{ t('settings.collectionSources.hint') }}</p>
    <p v-if="!collections.available" class="collection-sources__hint">
      {{ t('settings.collectionSources.noWorkspace') }}
    </p>

    <div class="collection-sources__card">
      <div class="collection-sources__card-head">
        <strong>{{ t('settings.collectionSources.githubHeading') }}</strong>
        <span class="collection-sources__status" :class="{ 'is-on': githubConnected }">
          {{
            githubConnected
              ? t('settings.collectionSources.connected')
              : t('settings.collectionSources.notConnected')
          }}
        </span>
      </div>
      <p class="collection-sources__hint">{{ t('settings.collectionSources.githubHint') }}</p>

      <template v-if="githubConnected">
        <label class="collection-sources__row">
          <input
            v-model="settings.collectionGithubEnabled"
            type="checkbox"
            @change="persistToggle"
          />
          <span>{{ t('settings.collectionSources.enable') }}</span>
        </label>
        <label class="collection-sources__row">
          <span>{{ t('settings.collectionSources.interval') }}</span>
          <input
            class="collection-sources__number"
            type="number"
            min="1"
            max="1440"
            :value="settings.collectionRefreshMinutes"
            @change="setMinutes"
          />
          <span>{{
            t('settings.collectionSources.minutes', {
              count: String(settings.collectionRefreshMinutes),
            })
          }}</span>
        </label>
        <div class="collection-sources__row">
          <button class="rp-btn" type="button" :disabled="collections.refreshing" @click="refreshNow">
            {{
              collections.refreshing
                ? t('settings.collectionSources.refreshing')
                : t('settings.collectionSources.refreshNow')
            }}
          </button>
          <span class="collection-sources__hint">
            {{ t('settings.collectionSources.lastRefresh') }} {{ lastRefreshLabel }}
          </span>
          <span class="collection-sources__hint">
            {{ t('settings.collectionSources.pending', { n: String(pendingCount) }) }}
          </span>
        </div>
        <p v-if="collections.lastError" class="collection-sources__error">
          {{ t('settings.collectionSources.lastError', { error: collections.lastError }) }}
        </p>
        <button class="rp-btn" type="button" @click="clearHistory">
          {{ t('settings.collectionSources.clearHistory') }}
        </button>
      </template>

      <template v-else>
        <p class="collection-sources__hint">{{ t('settings.collectionSources.connectHint') }}</p>
        <div class="collection-sources__row">
          <button class="rp-btn" type="button" @click="openGithubSettings">
            {{ t('settings.collectionSources.goToGithub') }}
          </button>
          <button class="rp-btn" type="button" @click="checkConnection">
            {{ t('settings.collectionSources.recheck') }}
          </button>
        </div>
      </template>
    </div>

    <div class="collection-sources__card">
      <div class="collection-sources__card-head">
        <strong>{{ t('settings.collectionSources.toutiaoHeading') }}</strong>
      </div>
      <p class="collection-sources__hint">{{ t('settings.collectionSources.toutiaoSoon') }}</p>
    </div>
  </section>
</template>

<style scoped>
.collection-sources {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.collection-sources__heading {
  margin: 0;
  font-size: 15px;
}
.collection-sources__hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}
.collection-sources__card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-elev);
}
.collection-sources__card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.collection-sources__status {
  font-size: 12px;
  color: var(--text-faint);
}
.collection-sources__status.is-on {
  color: var(--success);
}
.collection-sources__row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.collection-sources__number {
  width: 72px;
}
.collection-sources__error {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
}
</style>
```

- [ ] **Step 3: 在设置面板挂载组件**

在 `SettingsPanel.vue` 的 `import IntegrationsSettings from './IntegrationsSettings.vue';` 之后加入：

```ts
import CollectionSourcesSettings from './CollectionSourcesSettings.vue';
```

在模板的 `<div data-cat="integrations"><IntegrationsSettings /></div>` 之后加入：

```html
        <div v-if="gitBackend" data-cat="integrations"><CollectionSourcesSettings /></div>
```

- [ ] **Step 4: 加分类切换事件监听**

在 `SettingsPanel.vue` 的 `const settings = useSettingsStore();`（紧接在 `VALID_CATEGORIES` 的 watch 之后）之前加入：

```ts
/**
 * 设置面板已经打开时，`solomd:open-settings` 的 initial-section 不会再触发
 * （open 一直是 true）。收藏源卡片需要从“集成”跳到“同步”，所以单独监听
 * 一个只切换分类的事件。
 */
function onSettingsSection(e: Event) {
  const section = (e as CustomEvent).detail?.section;
  if (typeof section === 'string' && VALID_CATEGORIES.has(section as SettingsCategory)) {
    activeCategory.value = section as SettingsCategory;
  }
}
window.addEventListener('solomd:settings-section', onSettingsSection as EventListener);
```

在已有的 `onUnmounted(stopRecording);` 之后加入：

```ts
onUnmounted(() => window.removeEventListener('solomd:settings-section', onSettingsSection as EventListener));
```

- [ ] **Step 5: 类型检查**

Run: `cd app && npx vue-tsc --noEmit`

Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add app/src/components/CollectionSourcesSettings.vue app/src/components/SettingsPanel.vue app/src/i18n/en.ts app/src/i18n/zh.ts
git commit -m "feat(collections): add collection-source settings card"
```

---

### Task 9: 全量验证与手动验收

**Files:**
- 不改代码；修复验证中发现的问题。

**Interfaces:**
- Consumes: 前 8 个任务的成果。
- Produces: 可交付的一期功能。

- [ ] **Step 1: Rust 测试**

Run: `cd app/src-tauri && cargo test --lib collections::tests::`

Expected: `9 passed`。

- [ ] **Step 2: 前端测试与类型检查**

Run: `cd app && node --test --experimental-strip-types --import ./scripts/test-register.mjs src/lib/collections-filter.test.ts && npx vue-tsc --noEmit`

Expected: 3 个过滤测试通过，类型检查无错误。

- [ ] **Step 3: 手动验收（按 spec §6）**

1. 设置 → 集成启用 GitHub Star，点“立即刷新” → 收件箱出现未导入条目。
2. 导入一条 → `inbox/` 下生成笔记，含 `inbox: true`、`stars`、`language`、`topics`；收件箱笔记计数 +1；该条目从待导入区消失。
3. 断网后点刷新 → 列表不清空，显示错误。
4. 忽略一条后重启应用 → 仍不出现。
5. 删掉刚导入的笔记 → 该条目仍不出现；点“清空已忽略 / 已导入记录” → 重新出现。
6. 未配置 GitHub token 时 → 卡片显示“未连接”，点击跳转到“同步”分类。

- [ ] **Step 4: 提交验证修复（如有）**

```bash
git add -A
git commit -m "fix(collections): address verification findings"
```

若没有修复，跳过本步。
