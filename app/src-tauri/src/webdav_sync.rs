//! #458 — WebDAV workspace sync (坚果云 Nutstore, Nextcloud, ownCloud, AList /
//! OpenList, Synology WebDAV, etc.).
//!
//! Uses pure HTTP/WebDAV (`PROPFIND`, `MKCOL`, `GET`, `PUT`) over `reqwest`
//! with Basic Auth so it works across macOS, Windows, Linux, iOS, and Android
//! without needing `libgit2`.

use reqwest::Method;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebdavSyncResult {
    pub uploaded: usize,
    pub downloaded: usize,
    pub message: String,
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .user_agent("SoloMD-WebDAV/5.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))
}

fn normalize_base_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

fn normalize_remote_path(remote_path: &str) -> String {
    let trimmed = remote_path.trim().replace('\\', "/");
    let stripped = trimmed.trim_matches('/');
    if stripped.is_empty() {
        String::new()
    } else {
        format!("/{stripped}")
    }
}

fn percent_encode_segment(seg: &str) -> String {
    let mut out = String::with_capacity(seg.len());
    for &b in seg.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            ) {
                out.push(((hi << 4) | lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

fn encode_rel_segments(rel: &str) -> String {
    rel.split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .map(percent_encode_segment)
        .collect::<Vec<_>>()
        .join("/")
}

fn build_target_url(base_url: &str, remote_path: &str, rel_path: &str) -> String {
    let base = normalize_base_url(base_url);
    let root = normalize_remote_path(remote_path);
    let root_encoded = if root.is_empty() {
        String::new()
    } else {
        format!("/{}", encode_rel_segments(&root[1..]))
    };
    let rel_encoded = encode_rel_segments(rel_path);
    if rel_encoded.is_empty() {
        format!("{base}{root_encoded}/")
    } else {
        format!("{base}{root_encoded}/{rel_encoded}")
    }
}

async fn ensure_remote_dir(
    client: &reqwest::Client,
    base_url: &str,
    remote_path: &str,
    rel_dir: &str,
    username: &str,
    password: &str,
    created_cache: &mut HashSet<String>,
) -> Result<(), String> {
    let mut parts: Vec<String> = Vec::new();
    let root = normalize_remote_path(remote_path);
    if !root.is_empty() {
        for seg in root.trim_matches('/').split('/') {
            if !seg.is_empty() {
                parts.push(seg.to_string());
            }
        }
    }
    for seg in rel_dir.trim_matches('/').split('/') {
        if !seg.is_empty() && seg != "." {
            parts.push(seg.to_string());
        }
    }

    let base = normalize_base_url(base_url);
    let mut current = String::new();
    for seg in parts {
        if !current.is_empty() {
            current.push('/');
        }
        current.push_str(&seg);
        if created_cache.contains(&current) {
            continue;
        }
        let encoded = encode_rel_segments(&current);
        let dir_url = format!("{base}/{encoded}/");
        let mkcol = Method::from_bytes(b"MKCOL").map_err(|e| e.to_string())?;
        let resp = client
            .request(mkcol, &dir_url)
            .basic_auth(username, Some(password))
            .send()
            .await
            .map_err(|e| format!("MKCOL {dir_url} failed: {e}"))?;
        let code = resp.status().as_u16();
        // 201 Created, 405 Method Not Allowed (already exists), 301/200/409
        if code == 401 || code == 403 {
            return Err(format!("Authentication failed (HTTP {code})"));
        }
        created_cache.insert(current.clone());
    }
    Ok(())
}

fn should_skip_dir(name: &str) -> bool {
    name.starts_with('.')
        || name == "node_modules"
        || name == "target"
        || name == "dist"
}

fn should_sync_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if name.starts_with('.') || name == "Thumbs.db" || name == ".DS_Store" {
        return false;
    }
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "md" | "markdown" | "mdown" | "mkd" | "txt" | "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "pdf" | "bib" | "csl"
    )
}

fn collect_local_files(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if path.is_dir() {
            if should_skip_dir(name) {
                continue;
            }
            collect_local_files(root, &path, out);
        } else if path.is_file() && should_sync_file(&path) {
            if let Ok(rel) = path.strip_prefix(root) {
                let rel_str = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                if !rel_str.is_empty() {
                    out.push((rel_str, path));
                }
            }
        }
    }
}

/// Extract `<d:href>` / `<D:href>` / `<href>` entries from a WebDAV `PROPFIND` XML response,
/// paired with whether the `<response>` contains `<collection/>`.
fn parse_propfind_xml(xml: &str) -> Vec<(String, bool)> {
    let mut results = Vec::new();
    let lower = xml.to_ascii_lowercase();
    let mut pos = 0;
    while let Some(resp_start) = lower[pos..].find("response") {
        let abs_start = pos + resp_start;
        // Ensure it's an opening tag `<d:response` or `<response`
        if abs_start == 0 || !matches!(xml.as_bytes()[abs_start - 1], b'<' | b':') {
            pos = abs_start + 8;
            continue;
        }
        let Some(resp_end_rel) = lower[abs_start..].find("response>") else {
            break;
        };
        let block_end = abs_start + resp_end_rel + 9;
        let block = &xml[abs_start..block_end];
        let block_lower = &lower[abs_start..block_end];
        pos = block_end;

        // Extract href
        if let Some(href_open) = block_lower.find("href>") {
            let content_start = href_open + 5;
            if let Some(href_close) = block_lower[content_start..].find("href>") {
                let raw_inside = &block[content_start..content_start + href_close];
                // Strip trailing `</d:` or `</`
                let href = raw_inside
                    .trim_end_matches(|c: char| c != '<')
                    .trim_end_matches('<')
                    .trim();
                let is_collection = block_lower.contains(":collection")
                    || block_lower.contains("<collection");
                if !href.is_empty() {
                    results.push((href.to_string(), is_collection));
                }
            }
        }
    }
    results
}

#[tauri::command]
pub async fn webdav_test_connection(
    url: String,
    username: String,
    password: String,
    remote_path: String,
) -> Result<String, String> {
    if url.trim().is_empty() {
        return Err("WebDAV server URL is required".into());
    }
    let client = build_client()?;
    let target = build_target_url(&url, &remote_path, "");
    let propfind = Method::from_bytes(b"PROPFIND").map_err(|e| e.to_string())?;
    let resp = client
        .request(propfind.clone(), &target)
        .header("Depth", "0")
        .basic_auth(username.trim(), Some(password.as_str()))
        .send()
        .await
        .map_err(|e| format!("Connection failed: {e}"))?;

    let status = resp.status().as_u16();
    if status == 401 || status == 403 {
        return Err(format!("Authentication failed (HTTP {status})"));
    }
    if status == 404 {
        // Attempt to create the remote folder automatically
        let mut cache = HashSet::new();
        ensure_remote_dir(
            &client,
            &url,
            &remote_path,
            "",
            username.trim(),
            password.as_str(),
            &mut cache,
        )
        .await?;
        return Ok("Connected (created remote folder)".into());
    }
    if (200..300).contains(&status) || status == 207 {
        return Ok(format!("Connected (HTTP {status})"));
    }
    Err(format!("WebDAV server returned HTTP {status}"))
}

#[tauri::command]
pub async fn webdav_push_workspace(
    workspace: String,
    url: String,
    username: String,
    password: String,
    remote_path: String,
) -> Result<WebdavSyncResult, String> {
    let ws_path = PathBuf::from(workspace.trim());
    if !ws_path.is_dir() {
        return Err("Open a workspace folder before syncing".into());
    }
    if url.trim().is_empty() {
        return Err("Configure WebDAV server URL in Settings › Sync first".into());
    }

    let mut files = Vec::new();
    collect_local_files(&ws_path, &ws_path, &mut files);

    let client = build_client()?;
    let mut created_dirs = HashSet::new();
    ensure_remote_dir(
        &client,
        &url,
        &remote_path,
        "",
        username.trim(),
        password.as_str(),
        &mut created_dirs,
    )
    .await?;

    let mut uploaded = 0usize;
    for (rel, full_path) in files {
        if let Some((parent, _)) = rel.rsplit_once('/') {
            ensure_remote_dir(
                &client,
                &url,
                &remote_path,
                parent,
                username.trim(),
                password.as_str(),
                &mut created_dirs,
            )
            .await?;
        }
        let bytes = std::fs::read(&full_path)
            .map_err(|e| format!("Failed to read {rel}: {e}"))?;
        let file_url = build_target_url(&url, &remote_path, &rel);
        let resp = client
            .put(&file_url)
            .basic_auth(username.trim(), Some(password.as_str()))
            .body(bytes)
            .send()
            .await
            .map_err(|e| format!("Failed to upload {rel}: {e}"))?;
        let code = resp.status().as_u16();
        if code == 401 || code == 403 {
            return Err(format!("Authentication failed while uploading {rel} (HTTP {code})"));
        }
        if !(200..300).contains(&code) {
            return Err(format!("Upload failed for {rel} (HTTP {code})"));
        }
        uploaded += 1;
    }

    Ok(WebdavSyncResult {
        uploaded,
        downloaded: 0,
        message: format!("Uploaded {uploaded} files to WebDAV"),
    })
}

#[tauri::command]
pub async fn webdav_pull_workspace(
    workspace: String,
    url: String,
    username: String,
    password: String,
    remote_path: String,
) -> Result<WebdavSyncResult, String> {
    let ws_path = PathBuf::from(workspace.trim());
    if !ws_path.is_dir() {
        return Err("Open a workspace folder before syncing".into());
    }
    if url.trim().is_empty() {
        return Err("Configure WebDAV server URL in Settings › Sync first".into());
    }

    let client = build_client()?;
    let propfind = Method::from_bytes(b"PROPFIND").map_err(|e| e.to_string())?;

    // Breadth-first `Depth: 1` traversal (works on all WebDAV servers including
    // 坚果云 Nutstore and Nextcloud, which reject `Depth: infinity`).
    let mut queue: Vec<String> = vec![String::new()];
    let mut visited_dirs: HashSet<String> = HashSet::new();
    let mut downloaded = 0usize;

    while let Some(rel_dir) = queue.pop() {
        if !visited_dirs.insert(rel_dir.clone()) {
            continue;
        }
        let dir_url = build_target_url(&url, &remote_path, &rel_dir);
        let resp = client
            .request(propfind.clone(), &dir_url)
            .header("Depth", "1")
            .basic_auth(username.trim(), Some(password.as_str()))
            .send()
            .await
            .map_err(|e| format!("PROPFIND failed: {e}"))?;

        let status = resp.status().as_u16();
        if status == 404 && rel_dir.is_empty() {
            return Ok(WebdavSyncResult {
                uploaded: 0,
                downloaded: 0,
                message: "Remote WebDAV folder is empty".into(),
            });
        }
        if status == 401 || status == 403 {
            return Err(format!("Authentication failed (HTTP {status})"));
        }
        if !(200..300).contains(&status) && status != 207 {
            return Err(format!("WebDAV PROPFIND returned HTTP {status}"));
        }

        let xml = resp.text().await.unwrap_or_default();
        let entries = parse_propfind_xml(&xml);
        for (idx, (href, is_collection)) in entries.into_iter().enumerate() {
            // The first entry in Depth:1 response is typically the directory itself.
            let decoded = percent_decode(&href);
            let trimmed_href = decoded.trim_end_matches('/');
            let Some(leaf) = trimmed_href.rsplit('/').next() else {
                continue;
            };
            if leaf.is_empty() || leaf.starts_with('.') {
                continue;
            }
            if idx == 0 {
                continue;
            }
            let child_rel = if rel_dir.is_empty() {
                leaf.to_string()
            } else {
                format!("{rel_dir}/{leaf}")
            };
            if is_collection {
                if !should_skip_dir(leaf) && visited_dirs.len() < 200 {
                    queue.push(child_rel);
                }
            } else {
                let local_target = ws_path.join(&child_rel);
                if !should_sync_file(&local_target) {
                    continue;
                }
                let file_url = build_target_url(&url, &remote_path, &child_rel);
                let get_resp = client
                    .get(&file_url)
                    .basic_auth(username.trim(), Some(password.as_str()))
                    .send()
                    .await
                    .map_err(|e| format!("Failed to download {child_rel}: {e}"))?;
                if get_resp.status().is_success() {
                    if let Some(parent) = local_target.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let bytes = get_resp
                        .bytes()
                        .await
                        .map_err(|e| format!("Read error for {child_rel}: {e}"))?;
                    std::fs::write(&local_target, &bytes)
                        .map_err(|e| format!("Write error for {child_rel}: {e}"))?;
                    downloaded += 1;
                }
            }
        }
    }

    Ok(WebdavSyncResult {
        uploaded: 0,
        downloaded,
        message: format!("Downloaded {downloaded} files from WebDAV"),
    })
}
