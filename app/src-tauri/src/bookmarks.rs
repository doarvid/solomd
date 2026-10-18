//! Chromium bookmark sync — read direction (bookmark → note plan) and write
//! direction (notes → managed `SoloMD/` subtree).
//!
//! Chromium stores bookmarks as JSON (`<profile>/Bookmarks`) with an MD5
//! `checksum`. The format is not a public API. We treat the file as opaque
//! except for the managed subtree:
//!
//! - Read: parse into a merged tree across every discovered browser/profile.
//! - Write: reconcile only the folder marked `meta_info.solomd_managed`;
//!   user nodes are preserved byte-for-byte, and `checksum` is dropped so
//!   Chromium recomputes it on the next launch.
//! - Never write while the browser is running: it would overwrite us from
//!   memory (and we could drop the user's in-memory changes).
//!
//! See `docs/superpowers/specs/2026-10-19-browser-bookmark-sync-design.md`.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::capture_store::{normalize_url, safe_filename};

const ROOT_KEYS: [&str; 3] = ["bookmark_bar", "other", "synced"];
const MANAGED_MARKER: &str = "solomd_managed";
const MANAGED_FOLDER: &str = "SoloMD";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct BookmarkSource {
    pub browser: String,
    pub profile: String,
    pub path: String,
    pub mtime: u64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BookmarkFolderNode {
    pub name: String,
    pub path: Vec<String>,
    /// Total URLs in this folder and all descendants.
    pub url_count: usize,
    pub folders: Vec<BookmarkFolderNode>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BookmarkCatalog {
    pub sources: Vec<BookmarkSource>,
    pub tree: Vec<BookmarkFolderNode>,
    /// Sorted `(path, mtime, size)` hash. Changes whenever any bookmarks file
    /// changes, so the frontend can skip a read pass.
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BookmarkPlanEntry {
    /// Workspace-relative mirror directory (sanitized segments).
    pub folder: Vec<String>,
    pub title: String,
    pub url: String,
    pub normalized_url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BookmarkWriteEntry {
    /// Note directory, relative to the workspace root.
    pub folder: Vec<String>,
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkippedProfile {
    pub browser: String,
    pub profile: String,
    /// `running` | `unreadable`
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApplyReport {
    pub written_profiles: Vec<String>,
    pub skipped_profiles: Vec<SkippedProfile>,
    pub added: usize,
    pub removed: usize,
    pub unchanged: bool,
}

// ---------------------------------------------------------------------------
// Internal tree
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct UrlNode {
    name: String,
    url: String,
}

#[derive(Debug, Default, Clone)]
struct Folder {
    name: String,
    path: Vec<String>,
    urls: Vec<UrlNode>,
    folders: Vec<Folder>,
}

#[derive(Debug, Default)]
struct DesiredFolder {
    name: String,
    folders: Vec<DesiredFolder>,
    urls: Vec<(String, String)>, // (title, url)
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn bookmarks_catalog() -> Result<BookmarkCatalog, String> {
    let sources = discover_sources();
    let mut docs = Vec::with_capacity(sources.len());
    for source in &sources {
        match fs::read_to_string(&source.path) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(value) => docs.push(value),
                Err(_) => continue,
            },
            Err(_) => continue,
        }
    }

    let roots = merge_documents(docs);
    let tree = roots.iter().map(to_display_node).collect();

    Ok(BookmarkCatalog {
        fingerprint: fingerprint(&sources),
        sources: sources
            .iter()
            .map(|s| BookmarkSource {
                browser: s.browser.clone(),
                profile: s.profile.clone(),
                path: s.path.to_string_lossy().to_string(),
                mtime: s.mtime,
                size: s.size,
            })
            .collect(),
        tree,
    })
}

#[tauri::command]
pub fn bookmarks_sync_plan(
    folders: Vec<Vec<String>>,
) -> Result<Vec<BookmarkPlanEntry>, String> {
    let docs = read_all_documents();
    Ok(plan_from_docs(&docs, &folders))
}

fn read_all_documents() -> Vec<Value> {
    discover_sources()
        .iter()
        .filter_map(|s| fs::read_to_string(&s.path).ok())
        .filter_map(|text| serde_json::from_str::<Value>(&text).ok())
        .collect()
}

fn to_display_node(folder: &Folder) -> BookmarkFolderNode {
    BookmarkFolderNode {
        name: folder.name.clone(),
        path: folder.path.clone(),
        url_count: count_urls(folder),
        folders: folder.folders.iter().map(to_display_node).collect(),
    }
}

fn count_urls(folder: &Folder) -> usize {
    folder.urls.len() + folder.folders.iter().map(count_urls).sum::<usize>()
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct SourceFile {
    browser: String,
    profile: String,
    path: PathBuf,
    mtime: u64,
    size: u64,
}

fn discover_sources() -> Vec<SourceFile> {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        discover_desktop()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Vec::new()
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn discover_desktop() -> Vec<SourceFile> {
    let mut out = Vec::new();
    for (browser, base) in browser_base_dirs() {
        let Ok(entries) = fs::read_dir(&base) else { continue };
        for entry in entries.flatten() {
            let profile_dir = entry.path();
            if !profile_dir.is_dir() {
                continue;
            }
            let profile = entry.file_name().to_string_lossy().to_string();
            // Chromium creates these but they are not user profiles.
            if profile.starts_with("System Profile") || profile.starts_with("Guest Profile") {
                continue;
            }
            let file = profile_dir.join("Bookmarks");
            let Ok(meta) = fs::metadata(&file) else { continue };
            if !meta.is_file() {
                continue;
            }
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            out.push(SourceFile {
                browser: browser.to_string(),
                profile,
                path: file,
                mtime,
                size: meta.len(),
            });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

#[cfg(target_os = "macos")]
fn browser_base_dirs() -> Vec<(&'static str, PathBuf)> {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let app_support = home.join("Library/Application Support");
    vec![
        ("Chrome", app_support.join("Google/Chrome")),
        ("Edge", app_support.join("Microsoft Edge")),
        ("Brave", app_support.join("BraveSoftware/Brave-Browser")),
        ("Arc", app_support.join("Arc/User Data")),
        ("Vivaldi", app_support.join("Vivaldi")),
        ("Chromium", app_support.join("Chromium")),
    ]
}

#[cfg(target_os = "windows")]
fn browser_base_dirs() -> Vec<(&'static str, PathBuf)> {
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_default();
    vec![
        ("Chrome", local.join("Google/Chrome/User Data")),
        ("Edge", local.join("Microsoft/Edge/User Data")),
        ("Brave", local.join("BraveSoftware/Brave-Browser/User Data")),
        ("Arc", local.join("Arc/User Data")),
        ("Vivaldi", local.join("Vivaldi/User Data")),
        ("Chromium", local.join("Chromium/User Data")),
    ]
}

#[cfg(target_os = "linux")]
fn browser_base_dirs() -> Vec<(&'static str, PathBuf)> {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let config = home.join(".config");
    vec![
        ("Chrome", config.join("google-chrome")),
        ("Edge", config.join("microsoft-edge")),
        ("Brave", config.join("BraveSoftware/Brave-Browser")),
        ("Vivaldi", config.join("vivaldi")),
        ("Chromium", config.join("chromium")),
    ]
}

fn fingerprint(sources: &[SourceFile]) -> String {
    let mut rows: Vec<String> = sources
        .iter()
        .map(|s| {
            format!(
                "{}|{}|{}",
                s.path.to_string_lossy(),
                s.mtime,
                s.size
            )
        })
        .collect();
    rows.sort();
    let mut hasher = Sha256::new();
    for row in rows {
        hasher.update(row.as_bytes());
        hasher.update(b"\n");
    }
    format!("{:x}", hasher.finalize())
}

// ---------------------------------------------------------------------------
// Parsing + merging
// ---------------------------------------------------------------------------

fn merge_documents(docs: Vec<Value>) -> Vec<Folder> {
    let mut roots: Vec<Folder> = Vec::new();
    for doc in docs {
        let Some(roots_obj) = doc.get("roots").and_then(|r| r.as_object()) else {
            continue;
        };
        for key in ROOT_KEYS {
            let Some(node) = roots_obj.get(key) else { continue };
            let fallback = match key {
                "bookmark_bar" => "Bookmarks bar",
                "other" => "Other bookmarks",
                _ => "Mobile bookmarks",
            };
            let name = node
                .get("name")
                .and_then(|n| n.as_str())
                .filter(|n| !n.is_empty())
                .unwrap_or(fallback)
                .to_string();
            let mut folder = Folder {
                name: name.clone(),
                path: vec![name],
                ..Folder::default()
            };
            collect_folder(node, &mut folder);
            merge_folder(&mut roots, folder);
        }
    }
    for root in &mut roots {
        dedupe_urls(root);
    }
    roots
}

/// Same URL bookmarked in several profiles (or twice in one) counts once.
fn dedupe_urls(folder: &mut Folder) {
    let mut seen = HashSet::new();
    folder
        .urls
        .retain(|url| seen.insert(normalize_url(&url.url)));
    for child in &mut folder.folders {
        dedupe_urls(child);
    }
}

fn merge_folder(roots: &mut Vec<Folder>, incoming: Folder) {
    if let Some(existing) = roots.iter_mut().find(|f| f.name == incoming.name) {
        merge_into(existing, &incoming);
    } else {
        roots.push(incoming);
    }
}

fn merge_into(dest: &mut Folder, src: &Folder) {
    dest.urls.extend(src.urls.iter().cloned());
    for child in &src.folders {
        if let Some(existing) = dest.folders.iter_mut().find(|f| f.name == child.name) {
            merge_into(existing, child);
        } else {
            dest.folders.push(child.clone());
        }
    }
}

fn collect_folder(node: &Value, folder: &mut Folder) {
    let Some(children) = node.get("children").and_then(|c| c.as_array()) else {
        return;
    };
    for child in children {
        let kind = child.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match kind {
            "url" => {
                let url = child.get("url").and_then(|u| u.as_str()).unwrap_or("");
                if !is_http(url) {
                    continue;
                }
                let name = child
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("")
                    .to_string();
                folder.urls.push(UrlNode {
                    name,
                    url: url.to_string(),
                });
            }
            "folder" => {
                // Our own mirror must never be read back as a source.
                if is_managed(child) {
                    continue;
                }
                let name = child
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("")
                    .to_string();
                if name.is_empty() {
                    continue;
                }
                let mut path = folder.path.clone();
                path.push(name.clone());
                let mut sub = Folder {
                    name,
                    path,
                    ..Folder::default()
                };
                collect_folder(child, &mut sub);
                folder.folders.push(sub);
            }
            _ => {}
        }
    }
}

fn is_managed(node: &Value) -> bool {
    node.get("meta_info")
        .and_then(|m| m.get(MANAGED_MARKER))
        .and_then(|v| v.as_str())
        == Some("1")
}

fn is_http(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

// ---------------------------------------------------------------------------
// Read plan
// ---------------------------------------------------------------------------

fn plan_from_docs(docs: &[Value], selected: &[Vec<String>]) -> Vec<BookmarkPlanEntry> {
    let roots = merge_documents(docs.to_vec());
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for path in selected {
        if let Some(node) = find_folder(&roots, path) {
            collect_plan(node, &mut out, &mut seen);
        }
    }
    out
}

fn find_folder<'a>(roots: &'a [Folder], path: &[String]) -> Option<&'a Folder> {
    let (first, rest) = path.split_first()?;
    let root = roots.iter().find(|f| &f.name == first)?;
    let mut node = root;
    for segment in rest {
        node = node.folders.iter().find(|f| &f.name == segment)?;
    }
    Some(node)
}

fn collect_plan(node: &Folder, out: &mut Vec<BookmarkPlanEntry>, seen: &mut HashSet<String>) {
    for url in &node.urls {
        let normalized = normalize_url(&url.url);
        if normalized.is_empty() || !seen.insert(normalized.clone()) {
            continue;
        }
        let folder = node
            .path
            .iter()
            .filter_map(|s| sanitize_segment(s))
            .collect();
        out.push(BookmarkPlanEntry {
            folder,
            title: if url.name.trim().is_empty() {
                host_of(&url.url)
            } else {
                url.name.clone()
            },
            url: url.url.clone(),
            normalized_url: normalized,
        });
    }
    for child in &node.folders {
        collect_plan(child, out, seen);
    }
}

/// Returns `None` for segments that sanitize to nothing and for traversal
/// attempts. `safe_filename` already trims leading/trailing dots, so `..`
/// becomes empty.
fn sanitize_segment(segment: &str) -> Option<String> {
    let cleaned = safe_filename(segment);
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        None
    } else {
        Some(cleaned)
    }
}

fn host_of(url: &str) -> String {
    tauri::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| url.to_string())
}

// ---------------------------------------------------------------------------
// Write direction
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn bookmarks_apply(entries: Vec<BookmarkWriteEntry>) -> Result<ApplyReport, String> {
    let desired_root = build_desired(&entries);
    let sources = discover_sources();
    let mut report = ApplyReport {
        written_profiles: Vec::new(),
        skipped_profiles: Vec::new(),
        added: 0,
        removed: 0,
        unchanged: false,
    };

    for source in &sources {
        let label = format!("{} · {}", source.browser, source.profile);
        if browser_is_running(&source.browser) {
            report.skipped_profiles.push(SkippedProfile {
                browser: source.browser.clone(),
                profile: source.profile.clone(),
                reason: "running".into(),
            });
            continue;
        }
        match apply_to_file(&source.path, &desired_root) {
            Ok(Some((added, removed))) => {
                report.written_profiles.push(label);
                report.added += added;
                report.removed += removed;
            }
            Ok(None) => {}
            Err(_) => report.skipped_profiles.push(SkippedProfile {
                browser: source.browser.clone(),
                profile: source.profile.clone(),
                reason: "unreadable".into(),
            }),
        }
    }

    report.unchanged = report.written_profiles.is_empty() && report.skipped_profiles.is_empty();
    Ok(report)
}

fn build_desired(entries: &[BookmarkWriteEntry]) -> DesiredFolder {
    let mut root = DesiredFolder {
        name: MANAGED_FOLDER.to_string(),
        ..DesiredFolder::default()
    };
    let mut seen: HashSet<String> = HashSet::new();
    for entry in entries {
        if !is_http(&entry.url) {
            continue;
        }
        let normalized = normalize_url(&entry.url);
        if normalized.is_empty() || !seen.insert(normalized) {
            continue;
        }
        let segments: Vec<String> = entry
            .folder
            .iter()
            .filter_map(|s| sanitize_segment(s))
            .collect();
        let title = if entry.title.trim().is_empty() {
            host_of(&entry.url)
        } else {
            entry.title.clone()
        };
        insert_desired(&mut root, &segments, &title, &entry.url);
    }
    sort_desired(&mut root);
    root
}

fn insert_desired(node: &mut DesiredFolder, folder: &[String], title: &str, url: &str) {
    if let Some((head, rest)) = folder.split_first() {
        if let Some(child) = node.folders.iter_mut().find(|f| &f.name == head) {
            insert_desired(child, rest, title, url);
            return;
        }
        let mut child = DesiredFolder {
            name: head.clone(),
            ..DesiredFolder::default()
        };
        insert_desired(&mut child, rest, title, url);
        node.folders.push(child);
        return;
    }
    node.urls.push((title.to_string(), url.to_string()));
}

/// Sorted output makes the on-disk representation stable across runs, so an
/// unchanged workspace never rewrites the bookmarks file.
fn sort_desired(node: &mut DesiredFolder) {
    node.folders.sort_by(|a, b| a.name.cmp(&b.name));
    node.urls.sort_by(|a, b| a.1.cmp(&b.1));
    for child in &mut node.folders {
        sort_desired(child);
    }
}

/// Apply desired state to one bookmarks file.
///
/// `Ok(None)` means already aligned (no write). `Err` means unreadable/
/// unwritable — the caller reports it and moves on.
fn apply_to_file(path: &Path, desired: &DesiredFolder) -> Result<Option<(usize, usize)>, String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut doc: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let max = max_id(&doc);
    let mut next_id = max + 1;

    let bar = doc
        .get_mut("roots")
        .and_then(|r| r.get_mut("bookmark_bar"))
        .ok_or_else(|| "missing bookmark_bar root".to_string())?;

    let children = bar
        .get_mut("children")
        .and_then(|c| c.as_array_mut())
        .ok_or_else(|| "bookmark_bar has no children array".to_string())?;

    let managed_index = children.iter().position(is_managed);

    if managed_index.is_none() && desired.folders.is_empty() && desired.urls.is_empty() {
        return Ok(None); // nothing to mirror yet — don't create an empty folder
    }

    let mut desired_children: Vec<Value> = Vec::new();
    for folder in &desired.folders {
        desired_children.push(desired_folder_to_json(folder, &mut next_id));
    }
    for (title, url) in &desired.urls {
        desired_children.push(desired_url_to_json(title, url, &mut next_id));
    }
    let desired_value = Value::Array(desired_children);

    if let Some(index) = managed_index {
        let existing = children[index]
            .get("children")
            .cloned()
            .unwrap_or_else(|| Value::Array(vec![]));
        if canonical(&existing) == canonical(&desired_value) {
            return Ok(None);
        }
        let old_urls = collect_urls(&existing);
        let new_urls = collect_desired_urls(desired);
        let added = new_urls.difference(&old_urls).count();
        let removed = old_urls.difference(&new_urls).count();
        children[index]["children"] = desired_value;
        write_doc(path, &mut doc)?;
        return Ok(Some((added, removed)));
    }

    let name = available_managed_name(children);
    let mut node = json!({
        "type": "folder",
        "name": name,
        "children": desired_value,
        "id": next_id.to_string(),
        "guid": new_guid(&mut next_id),
        "date_added": chrome_timestamp(),
        "date_modified": chrome_timestamp(),
        "meta_info": { "solomd_managed": "1" },
    });
    // Keep the marker stable even if json! ordering changes.
    node["meta_info"][MANAGED_MARKER] = json!("1");
    children.push(node);
    let added = collect_desired_urls(desired).len();
    write_doc(path, &mut doc)?;
    Ok(Some((added, 0)))
}

fn available_managed_name(children: &[Value]) -> String {
    let mut candidate = MANAGED_FOLDER.to_string();
    let mut n = 2;
    loop {
        let taken = children.iter().any(|c| {
            c.get("type").and_then(|t| t.as_str()) == Some("folder")
                && c.get("name").and_then(|x| x.as_str()) == Some(candidate.as_str())
        });
        if !taken {
            return candidate;
        }
        candidate = format!("{MANAGED_FOLDER} ({n})");
        n += 1;
    }
}

fn desired_folder_to_json(folder: &DesiredFolder, next_id: &mut u64) -> Value {
    let mut children: Vec<Value> = Vec::new();
    for child in &folder.folders {
        children.push(desired_folder_to_json(child, next_id));
    }
    for (title, url) in &folder.urls {
        children.push(desired_url_to_json(title, url, next_id));
    }
    let id = take_id(next_id);
    json!({
        "type": "folder",
        "name": &folder.name,
        "children": children,
        "id": id.to_string(),
        "guid": new_guid(next_id),
        "date_added": chrome_timestamp(),
        "date_modified": chrome_timestamp(),
    })
}

fn desired_url_to_json(title: &str, url: &str, next_id: &mut u64) -> Value {
    let id = take_id(next_id);
    json!({
        "type": "url",
        "name": title,
        "url": url,
        "id": id.to_string(),
        "guid": new_guid(next_id),
        "date_added": chrome_timestamp(),
    })
}

fn take_id(next_id: &mut u64) -> u64 {
    let id = *next_id;
    *next_id += 1;
    id
}

fn max_id(node: &Value) -> u64 {
    let mut max = node
        .get("id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    if let Some(children) = node.get("children").and_then(|c| c.as_array()) {
        for child in children {
            max = max.max(max_id(child));
        }
    }
    max
}

/// Only the fields we own. Dates/ids/guids are ignored when deciding whether
/// a write is needed, so touching the file never causes a rewrite loop.
fn canonical(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            if let Some(t) = map.get("type") {
                out.insert("type".into(), t.clone());
            }
            if let Some(name) = map.get("name") {
                out.insert("name".into(), name.clone());
            }
            if let Some(url) = map.get("url") {
                out.insert("url".into(), url.clone());
            }
            if let Some(children) = map.get("children") {
                out.insert("children".into(), canonical(children));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn collect_urls(value: &Value) -> HashSet<String> {
    let mut out = HashSet::new();
    collect_urls_into(value, &mut out);
    out
}

fn collect_urls_into(value: &Value, out: &mut HashSet<String>) {
    if let Some(children) = value.as_array() {
        for child in children {
            collect_urls_into(child, out);
        }
        return;
    }
    if value.get("type").and_then(|t| t.as_str()) == Some("url") {
        if let Some(url) = value.get("url").and_then(|u| u.as_str()) {
            let n = normalize_url(url);
            if !n.is_empty() {
                out.insert(n);
            }
        }
    }
    if let Some(children) = value.get("children") {
        collect_urls_into(children, out);
    }
}

fn collect_desired_urls(node: &DesiredFolder) -> HashSet<String> {
    let mut out = HashSet::new();
    collect_desired_urls_into(node, &mut out);
    out
}

fn collect_desired_urls_into(node: &DesiredFolder, out: &mut HashSet<String>) {
    for (_, url) in &node.urls {
        let n = normalize_url(url);
        if !n.is_empty() {
            out.insert(n);
        }
    }
    for child in &node.folders {
        collect_desired_urls_into(child, out);
    }
}

fn write_doc(path: &Path, doc: &mut Value) -> Result<(), String> {
    // Chromium recomputes the checksum on load. Leaving a stale one would
    // make it treat the file as externally modified.
    if let Some(obj) = doc.as_object_mut() {
        obj.remove("checksum");
    }

    let backup = path.with_file_name("Bookmarks.solomd.bak");
    fs::copy(path, &backup).map_err(|e| format!("backup failed: {e}"))?;

    let data = serde_json::to_vec(doc).map_err(|e| e.to_string())?;
    let tmp = path.with_file_name("Bookmarks.solomd.tmp");
    fs::write(&tmp, &data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename failed: {e}")
    })
}

fn chrome_timestamp() -> String {
    const WEBKIT_EPOCH_OFFSET_MICROS: u128 = 11_644_473_600 * 1_000_000;
    let micros = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros())
        .unwrap_or(0);
    (micros + WEBKIT_EPOCH_OFFSET_MICROS).to_string()
}

fn new_guid(seed: &mut u64) -> String {
    let mut x = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
        ^ seed.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    *seed = seed.wrapping_add(1);
    let mut bytes = [0u8; 16];
    for byte in &mut bytes {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        *byte = (x & 0xff) as u8;
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11],
        bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

// ---------------------------------------------------------------------------
// Process detection
// ---------------------------------------------------------------------------

/// Conservative: if we cannot tell, pretend it is running so we never race a
/// live browser.
fn browser_is_running(browser: &str) -> bool {
    let names = process_names(browser);
    #[cfg(target_os = "windows")]
    {
        let Ok(output) = std::process::Command::new("tasklist")
            .args(["/FO", "CSV", "/NH"])
            .output()
        else {
            return true;
        };
        if !output.status.success() {
            return true;
        }
        let text = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
        names.iter().any(|n| text.contains(&n.to_ascii_lowercase()))
    }
    #[cfg(not(target_os = "windows"))]
    {
        for name in names {
            match std::process::Command::new("pgrep")
                .args(["-x", name])
                .status()
            {
                Ok(status) => {
                    if status.success() {
                        return true;
                    }
                }
                Err(_) => return true,
            }
        }
        false
    }
}

fn process_names(browser: &str) -> &'static [&'static str] {
    match browser {
        "Chrome" => &["Google Chrome", "chrome.exe"],
        "Edge" => &["Microsoft Edge", "msedge.exe"],
        "Brave" => &["Brave Browser", "brave.exe"],
        "Arc" => &["Arc", "Arc.exe"],
        "Vivaldi" => &["Vivaldi", "vivaldi.exe"],
        "Chromium" => &["Chromium", "chromium.exe"],
        _ => &[],
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        json!({
            "checksum": "stale",
            "version": 1,
            "roots": {
                "bookmark_bar": {
                    "type": "folder",
                    "name": "Bookmarks bar",
                    "id": "1",
                    "children": [
                        { "type": "url", "name": "Rust", "url": "https://rust-lang.org/", "id": "2" },
                        { "type": "folder", "name": "Tech", "id": "3", "children": [
                            { "type": "url", "name": "Docs", "url": "https://doc.rust-lang.org/", "id": "4" },
                            { "type": "url", "name": "Tracking", "url": "https://example.com/page?utm_source=x", "id": "5" }
                        ]}
                    ]
                },
                "other": {
                    "type": "folder",
                    "name": "Other bookmarks",
                    "id": "6",
                    "children": [
                        { "type": "url", "name": "Ghost", "url": "javascript:void(0)", "id": "7" }
                    ]
                }
            }
        })
    }

    #[test]
    fn catalog_merges_roots_and_counts_urls() {
        let tree = merge_documents(vec![fixture()]);
        let bar = &tree[0];
        assert_eq!(bar.name, "Bookmarks bar");
        assert_eq!(count_urls(bar), 3);
        assert_eq!(bar.folders[0].name, "Tech");
        assert_eq!(count_urls(&bar.folders[0]), 2);
    }

    #[test]
    fn catalog_merges_same_path_across_profiles() {
        let mut second = fixture();
        second["roots"]["bookmark_bar"]["children"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "type": "url", "name": "Vue", "url": "https://vuejs.org/", "id": "8" }));
        let tree = merge_documents(vec![fixture(), second]);
        assert_eq!(count_urls(&tree[0]), 4);
    }

    #[test]
    fn managed_subtree_is_not_read_back() {
        let mut doc = fixture();
        doc["roots"]["bookmark_bar"]["children"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "type": "folder",
                "name": "SoloMD",
                "children": [
                    { "type": "url", "name": "Mirror", "url": "https://mirror.example/", "id": "9" }
                ],
                "meta_info": { "solomd_managed": "1" }
            }));
        let tree = merge_documents(vec![doc]);
        assert!(!tree[0].folders.iter().any(|f| f.name == "SoloMD"));
    }

    #[test]
    fn plan_mirrors_selected_folder_and_dedupes_urls() {
        let plan = plan_from_docs(
            &[fixture()],
            &[vec!["Bookmarks bar".into(), "Tech".into()]],
        );
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0].folder, vec!["Bookmarks bar", "Tech"]);
        assert_eq!(plan[0].normalized_url, "https://doc.rust-lang.org");
        assert_eq!(plan[1].normalized_url, "https://example.com/page");
    }

    #[test]
    fn plan_skips_non_http_and_unknown_folders() {
        let plan = plan_from_docs(&[fixture()], &[vec!["Other bookmarks".into()], vec!["Nope".into()]]);
        assert!(plan.is_empty());
    }

    #[test]
    fn desired_tree_dedupes_and_sorts() {
        let entries = vec![
            BookmarkWriteEntry {
                folder: vec!["Notes".into()],
                title: "b".into(),
                url: "https://b.example/".into(),
            },
            BookmarkWriteEntry {
                folder: vec!["Notes".into()],
                title: "a".into(),
                url: "https://a.example/".into(),
            },
            BookmarkWriteEntry {
                folder: vec!["Notes".into()],
                title: "dup".into(),
                url: "https://a.example/?utm_source=x".into(),
            },
        ];
        let desired = build_desired(&entries);
        assert_eq!(desired.folders.len(), 1);
        assert_eq!(desired.folders[0].urls.len(), 2);
        assert_eq!(desired.folders[0].urls[0].1, "https://a.example/");
    }

    fn write_fixture(dir: &Path) -> PathBuf {
        let path = dir.join("Bookmarks");
        fs::write(&path, serde_json::to_vec_pretty(&fixture()).unwrap()).unwrap();
        path
    }

    fn desired_for(urls: &[(&[&str], &str, &str)]) -> DesiredFolder {
        let entries: Vec<BookmarkWriteEntry> = urls
            .iter()
            .map(|(folder, title, url)| BookmarkWriteEntry {
                folder: folder.iter().map(|s| s.to_string()).collect(),
                title: title.to_string(),
                url: url.to_string(),
            })
            .collect();
        build_desired(&entries)
    }

    #[test]
    fn apply_creates_managed_root_and_keeps_user_nodes() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_fixture(dir.path());
        let before: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let desired = desired_for(&[(&["Notes"], "Rust", "https://rust-lang.org/")]);

        let result = apply_to_file(&path, &desired).unwrap();
        assert!(result.is_some());

        let after: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        // User bookmarks untouched (same URLs in the same nodes).
        let user_urls = |doc: &Value| -> Vec<String> {
            doc["roots"]["bookmark_bar"]["children"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|c| c["type"] == "url")
                .map(|c| c["url"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(user_urls(&before), user_urls(&after));
        let tech = |doc: &Value| -> String {
            doc["roots"]["bookmark_bar"]["children"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["name"] == "Tech")
                .map(|c| c["children"][0]["url"].as_str().unwrap().to_string())
                .unwrap()
        };
        assert_eq!(tech(&before), tech(&after));
        // Managed root exists and mirrors notes.
        let managed = after["roots"]["bookmark_bar"]["children"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["meta_info"]["solomd_managed"] == "1")
            .expect("managed root");
        assert_eq!(managed["name"], "SoloMD");
        assert_eq!(managed["children"][0]["name"], "Notes");
        assert_eq!(managed["children"][0]["children"][0]["name"], "Rust");
        // checksum dropped.
        assert!(after.get("checksum").is_none());
        // backup written.
        assert!(dir.path().join("Bookmarks.solomd.bak").exists());
    }

    #[test]
    fn apply_is_noop_when_already_aligned() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_fixture(dir.path());
        let desired = desired_for(&[(&["Notes"], "Rust", "https://rust-lang.org/")]);
        assert!(apply_to_file(&path, &desired).unwrap().is_some());
        let snapshot = fs::read(&path).unwrap();
        assert!(apply_to_file(&path, &desired).unwrap().is_none());
        assert_eq!(fs::read(&path).unwrap(), snapshot);
    }

    #[test]
    fn apply_removes_stale_managed_urls_and_empty_folders() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_fixture(dir.path());
        let first = desired_for(&[
            (&["Old", "Nested"], "Old", "https://old.example/"),
            (&["Keep"], "Keep", "https://keep.example/"),
        ]);
        apply_to_file(&path, &first).unwrap();

        let second = desired_for(&[(&["Keep"], "Keep", "https://keep.example/")]);
        let (added, removed) = apply_to_file(&path, &second).unwrap().unwrap();
        assert_eq!((added, removed), (0, 1));

        let after: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let managed = after["roots"]["bookmark_bar"]["children"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["meta_info"]["solomd_managed"] == "1")
            .unwrap();
        let names: Vec<_> = managed["children"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["Keep"]);
    }

    #[test]
    fn apply_does_not_hijack_an_unmarked_solomd_folder() {
        let dir = tempfile::tempdir().unwrap();
        let mut doc = fixture();
        doc["roots"]["bookmark_bar"]["children"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "type": "folder",
                "name": "SoloMD",
                "id": "20",
                "children": []
            }));
        let path = dir.path().join("Bookmarks");
        fs::write(&path, serde_json::to_vec_pretty(&doc).unwrap()).unwrap();

        let desired = desired_for(&[(&[], "Note", "https://note.example/")]);
        apply_to_file(&path, &desired).unwrap();

        let after: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let managed: Vec<_> = after["roots"]["bookmark_bar"]["children"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["meta_info"]["solomd_managed"] == "1")
            .collect();
        assert_eq!(managed.len(), 1);
        assert_eq!(managed[0]["name"], "SoloMD (2)");
    }

    #[test]
    fn apply_rejects_traversal_folder_names() {
        let desired = desired_for(&[(&["..", "/etc"], "x", "https://x.example/")]);
        fn names(node: &DesiredFolder, out: &mut Vec<String>) {
            for child in &node.folders {
                out.push(child.name.clone());
                names(child, out);
            }
        }
        let mut out = Vec::new();
        names(&desired, &mut out);
        assert!(!out.iter().any(|n| n == ".."));
        assert!(!out.iter().any(|n| n.contains('/')));
    }

    #[test]
    fn new_ids_are_unique_and_guid_looks_like_uuid() {
        let mut id = 0u64;
        let a = new_guid(&mut id);
        let b = new_guid(&mut id);
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        assert_eq!(&a[8..9], "-");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
    }
}
