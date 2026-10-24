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
}
