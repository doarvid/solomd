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

fn merge_items(state: &mut CollectionsState, incoming: Vec<PendingItem>) -> u32 {
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

/// 页面脚本回传的原始候选。URL 形态与标题长度在这里才校验 ——
/// 注入脚本里写不动单测，筛选逻辑必须留在 Rust。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawItem {
    pub url: String,
    #[serde(default)]
    pub title: String,
}

pub const MAX_TOUTIAO_ITEMS: usize = 200;

fn is_toutiao_url(url: &str) -> bool {
    let Ok(parsed) = tauri::Url::parse(url) else {
        return false;
    };
    matches!(
        parsed.host_str(),
        Some("toutiao.com") | Some("www.toutiao.com") | Some("m.toutiao.com")
    ) && ["/article/", "/w/", "/video/", "/i/"]
        .iter()
        .any(|prefix| parsed.path().starts_with(prefix))
}

fn map_toutiao(raw: RawItem) -> Option<PendingItem> {
    let title = raw.title.trim().to_string();
    if title.chars().count() < 4 {
        return None;
    }
    let url = super::capture_store::normalize_url(&raw.url);
    if url.is_empty() || !is_toutiao_url(&url) {
        return None;
    }
    Some(PendingItem {
        id: format!("toutiao:{url}"),
        source: "toutiao".to_string(),
        title,
        url,
        saved_at: None,
        description: None,
        language: None,
        stars: None,
        topics: Vec::new(),
    })
}

/// 过滤 + 去重 + 截断。返回 `(items, cap_hit)`。
pub fn filter_toutiao_items(raw: Vec<RawItem>) -> (Vec<PendingItem>, bool) {
    let mut out: Vec<PendingItem> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut cap_hit = false;
    for entry in raw {
        let Some(item) = map_toutiao(entry) else {
            continue;
        };
        if !seen.insert(item.url.clone()) {
            continue;
        }
        if out.len() >= MAX_TOUTIAO_ITEMS {
            cap_hit = true;
            break;
        }
        out.push(item);
    }
    (out, cap_hit)
}

/// 把一次采集结果写进缓存。未知来源直接拒绝，避免页面 data 变成
/// 别的源的条目；条目只增不删 —— 已导入/忽略由 dismissed/imported 过滤。
pub fn upsert_items(
    state: &mut CollectionsState,
    source: &str,
    raw: Vec<RawItem>,
    truncated: bool,
) -> Result<RefreshOutcome, String> {
    if source != "toutiao" {
        return Err(format!("unknown collection source: {source}"));
    }
    let (incoming, cap_hit) = filter_toutiao_items(raw);
    let total = incoming.len() as u32;
    let added = merge_items(state, incoming);
    state
        .last_refresh
        .insert(source.to_string(), now_ms());
    Ok(RefreshOutcome {
        added,
        total,
        truncated: truncated || cap_hit,
    })
}

#[tauri::command]
pub fn collections_upsert_items(
    workspace: String,
    source: String,
    items: Vec<RawItem>,
    has_more: Option<bool>,
) -> Result<RefreshOutcome, String> {
    let workspace = PathBuf::from(workspace);
    mutate_state(&workspace, |state| {
        upsert_items(state, &source, items, has_more.unwrap_or(false))
    })?
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
        let added = merge_items(state, incoming);
        state.last_refresh.insert("github".to_string(), now_ms());
        (added, state.items.len() as u32)
    })?;

    Ok(RefreshOutcome {
        added,
        total,
        truncated,
    })
}

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

    fn raw(url: &str, title: &str) -> RawItem {
        RawItem {
            url: url.to_string(),
            title: title.to_string(),
        }
    }

    #[test]
    fn toutiao_filter_keeps_only_known_paths() {
        let (items, capped) = filter_toutiao_items(vec![
            raw("https://www.toutiao.com/article/123/", "一篇文章"),
            raw("https://www.toutiao.com/w/456/", "微头条标题"),
            raw("https://www.toutiao.com/video/789/", "视频标题"),
            raw("https://www.toutiao.com/c/user/favourite/", "收藏页"),
            raw("https://www.toutiao.com/", "首页"),
        ]);
        let urls: Vec<&str> = items.iter().map(|i| i.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "https://www.toutiao.com/article/123",
                "https://www.toutiao.com/w/456",
                "https://www.toutiao.com/video/789",
            ]
        );
        assert!(!capped);
        assert!(items.iter().all(|i| i.source == "toutiao"));
        assert!(items[0].id.starts_with("toutiao:"));
    }

    #[test]
    fn toutiao_filter_drops_short_titles_and_dedupes() {
        let (items, _) = filter_toutiao_items(vec![
            raw("https://www.toutiao.com/article/1/?utm_source=x", "足够长的标题"),
            raw("https://www.toutiao.com/article/1/", "重复的另一条"),
            raw("https://www.toutiao.com/article/2/", "短"),
        ]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "足够长的标题");
    }

    #[test]
    fn toutiao_filter_caps_at_the_limit() {
        let batch: Vec<RawItem> = (0..MAX_TOUTIAO_ITEMS + 5)
            .map(|n| raw(&format!("https://www.toutiao.com/article/{n}/"), "标题够长"))
            .collect();
        let (items, capped) = filter_toutiao_items(batch);
        assert_eq!(items.len(), MAX_TOUTIAO_ITEMS);
        assert!(capped);
    }

    #[test]
    fn upsert_rejects_an_unknown_source() {
        let mut state = default_state();
        let err = upsert_items(&mut state, "mastodon", vec![raw("https://x.test/a", "标题够长")], false)
            .unwrap_err();
        assert!(err.contains("unknown collection source"));
        assert!(state.items.is_empty());
    }

    #[test]
    fn upsert_is_idempotent_and_records_the_source_timestamp() {
        let mut state = default_state();
        let first = upsert_items(
            &mut state,
            "toutiao",
            vec![raw("https://www.toutiao.com/article/1/", "标题够长")],
            false,
        )
        .unwrap();
        assert_eq!(first.added, 1);
        assert_eq!(first.total, 1);
        let second = upsert_items(
            &mut state,
            "toutiao",
            vec![raw("https://www.toutiao.com/article/1/", "标题够长")],
            false,
        )
        .unwrap();
        assert_eq!(second.added, 0);
        assert_eq!(second.total, 1);
        assert!(state.last_refresh.contains_key("toutiao"));
        assert_eq!(state.items.len(), 1);
    }

    #[test]
    fn upsert_marks_truncation_from_either_side() {
        let mut state = default_state();
        let out = upsert_items(
            &mut state,
            "toutiao",
            vec![raw("https://www.toutiao.com/w/1/", "标题够长")],
            true,
        )
        .unwrap();
        assert!(out.truncated);
    }

    #[test]
    fn upsert_does_not_resurrect_dismissed_or_imported_ids() {
        let mut state = default_state();
        let first = upsert_items(
            &mut state,
            "toutiao",
            vec![raw("https://www.toutiao.com/article/9/", "标题够长")],
            false,
        )
        .unwrap();
        let id = state.items[0].id.clone();
        state.dismissed.push(id.clone());
        state.imported.insert(id.clone(), "/vault/a.md".to_string());
        let second = upsert_items(
            &mut state,
            "toutiao",
            vec![raw("https://www.toutiao.com/article/9/", "标题够长")],
            false,
        )
        .unwrap();
        assert_eq!(first.added, 1);
        assert_eq!(second.added, 0);
        assert_eq!(state.dismissed, vec![id.clone()]);
        assert!(state.imported.contains_key(&id));
    }    #[test]
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
        let added = merge_items(
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
}
