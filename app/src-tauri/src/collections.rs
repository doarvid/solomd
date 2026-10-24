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
