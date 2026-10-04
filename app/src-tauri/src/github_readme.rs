//! GitHub 仓库页直接读 README，不做正文抽取。
//!
//! 理由：仓库首页的 DOM 是导航、文件列表、语言统计、issue 计数等一堆
//! 与内容无关的东西。readability 在上面要么抽出一个空壳，要么把侧边栏
//! 当正文。而这个页面**真正有价值的就是 README**，它本来就是 markdown。
//!
//! 走 GitHub 的 API 拿 README，而不是拼 `raw.githubusercontent.com`：
//!
//! - 默认分支名不确定（`main` / `master` / 其他）
//! - 文件名不确定（`README.md` / `README.rst` / `readme.txt` / 大小写）
//! - 可能在 `.github/` 子目录里
//!
//! `/repos/{owner}/{repo}/readme` 把这些都处理掉了，返回的就是渲染用的那一份。
//!
//! **限流**：未认证的 API 每小时 60 次/IP。对"一次研究里采几十个仓库"够用，
//! 超了会返回 403 —— 那时降级成存根，用户至少看得到是哪条失败。

use serde::Deserialize;

/// 只认仓库首页，不认仓库内的路径。这些是第一段路径里**不是用户名**的保留字。
const RESERVED: &[&str] = &[
    "settings", "marketplace", "explore", "topics", "trending", "notifications", "new", "login",
    "logout", "join", "signup", "orgs", "organizations", "sponsors", "features", "about",
    "pricing", "search", "apps", "collections", "events", "dashboard", "pulls", "issues",
    "codespaces", "account", "site", "security", "enterprise", "team", "customer-stories",
];

/// 从 URL 里解析出 `(owner, repo)`；不是仓库首页就返回 None。
///
/// 接受：
/// - `https://github.com/owner/repo`
/// - `.../owner/repo/`、`?tab=readme-ov-file`、`#readme`、结尾 `.git`
///
/// 拒绝：
/// - `github.com/owner`（用户/组织主页，没有 README 可读）
/// - `github.com/owner/repo/tree/main`、`/blob/...`、`/issues` 等仓库内页面
/// - 非 github.com 的 host（含 gist、企业版自建域名 —— 后者的 API 路径不同，
///   不该按 github.com 的规则瞎猜）
pub fn parse_repo_url(raw: &str) -> Option<(String, String)> {
    let u = tauri::Url::parse(raw.trim()).ok()?;
    if u.host_str()? != "github.com" && u.host_str()? != "www.github.com" {
        return None;
    }

    let segs: Vec<&str> = u
        .path_segments()?
        .filter(|s| !s.is_empty())
        .collect();

    // 只有恰好两段才是仓库首页。
    if segs.len() != 2 {
        return None;
    }

    let owner = segs[0];
    // `repo.git` 是 clone URL 的写法，粘进浏览器很常见。
    let repo = segs[1].strip_suffix(".git").unwrap_or(segs[1]);

    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    if RESERVED.contains(&owner.to_ascii_lowercase().as_str()) {
        return None;
    }
    // 仓库本身可以叫 `issues` / `tree` 之类，所以两段路径一律当仓库首页。
    // 仓库内的页面（`/issues`、`/tree/main`）至少三段，已在上面被挡掉。

    Some((owner.to_string(), repo.to_string()))
}

/// 只取 description —— 仓库简介往往比 README 第一行（常常是 badge 图片）
/// 更有信息量，放在正文最前面。
///
/// 不取 `default_branch`：`/readme` 接口自己会解析默认分支和文件名，拿了
/// 也没用。
#[derive(Debug, Deserialize)]
struct RepoMeta {
    #[serde(default)]
    description: Option<String>,
}

/// 读一个仓库的 README。返回 `(标题, markdown 正文)`。
pub async fn fetch_readme(owner: &str, repo: &str) -> Result<(String, String), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    // 先要仓库元信息：description 用来在 README 很长时补一个标题，
    // 也让失败信息更有用（区分"仓库不存在"和"没有 README"）。
    let meta: Option<RepoMeta> = match client
        .get(format!("https://api.github.com/repos/{owner}/{repo}"))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r.json().await.ok(),
        Ok(r) if r.status().as_u16() == 404 => {
            return Err(format!("仓库不存在：{owner}/{repo}"));
        }
        Ok(r) if r.status().as_u16() == 403 => {
            return Err("GitHub API 限流（未认证每小时 60 次），稍后再试".to_string());
        }
        _ => None,
    };

    // Accept: raw 让 API 直接返回 README 的原始内容，而不是带 base64 的 JSON。
    let resp = client
        .get(format!("https://api.github.com/repos/{owner}/{repo}/readme"))
        .header("Accept", "application/vnd.github.raw")
        .send()
        .await
        .map_err(|e| format!("请求 README 失败: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            404 => format!("{owner}/{repo} 没有 README"),
            403 => "GitHub API 限流（未认证每小时 60 次），稍后再试".to_string(),
            c => format!("GitHub 返回 HTTP {c}"),
        });
    }

    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取 README 失败: {e}"))?;
    if body.trim().is_empty() {
        return Err(format!("{owner}/{repo} 的 README 是空的"));
    }

    let title = format!("{owner}/{repo}");
    // description 放在正文最前面：仓库简介往往比 README 开头更有信息量，
    // 而 README 的第一行常常只是一张 badge 图片。
    let markdown = match meta.and_then(|m| m.description).filter(|d| !d.trim().is_empty()) {
        Some(desc) => format!("> {}\n\n{}", desc.trim(), body.trim_start()),
        None => body,
    };

    Ok((title, markdown))
}

/// 带 SoloMD 标识，让 GitHub 那边能看出流量来源（也便于将来申请更高配额）。
const USER_AGENT: &str = "SoloMD/1.0 (+https://solomd.app)";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_plain_repo_url() {
        assert_eq!(
            parse_repo_url("https://github.com/tauri-apps/tauri"),
            Some(("tauri-apps".into(), "tauri".into()))
        );
    }

    #[test]
    fn accepts_trailing_slash_query_and_fragment() {
        for u in [
            "https://github.com/tauri-apps/tauri/",
            "https://github.com/tauri-apps/tauri?tab=readme-ov-file",
            "https://github.com/tauri-apps/tauri#readme",
        ] {
            assert_eq!(
                parse_repo_url(u),
                Some(("tauri-apps".into(), "tauri".into())),
                "failed on {u}"
            );
        }
    }

    #[test]
    fn accepts_a_dot_git_suffix() {
        // clone URL 被粘进地址栏很常见。
        assert_eq!(
            parse_repo_url("https://github.com/tauri-apps/tauri.git"),
            Some(("tauri-apps".into(), "tauri".into()))
        );
    }

    #[test]
    fn rejects_in_repo_pages() {
        // 这些不是仓库首页，抽 README 是错的。
        for u in [
            "https://github.com/tauri-apps/tauri/issues",
            "https://github.com/tauri-apps/tauri/tree/dev",
            "https://github.com/tauri-apps/tauri/blob/dev/README.md",
            "https://github.com/tauri-apps/tauri/releases/tag/v2.0.0",
            "https://github.com/tauri-apps/tauri/pulls",
        ] {
            assert_eq!(parse_repo_url(u), None, "should reject {u}");
        }
    }

    #[test]
    fn rejects_a_profile_page() {
        // 只有一段路径 —— 用户/组织主页，没有 README。
        assert_eq!(parse_repo_url("https://github.com/tauri-apps"), None);
    }

    #[test]
    fn rejects_reserved_first_segments() {
        assert_eq!(parse_repo_url("https://github.com/settings/profile"), None);
        assert_eq!(parse_repo_url("https://github.com/topics/rust"), None);
        assert_eq!(parse_repo_url("https://github.com/explore"), None);
    }

    #[test]
    fn rejects_other_hosts() {
        assert_eq!(parse_repo_url("https://gist.github.com/a/b"), None);
        assert_eq!(parse_repo_url("https://gitlab.com/a/b"), None);
        // 企业版自建域名走不同的 API 路径，不该按 github.com 的规则猜。
        assert_eq!(parse_repo_url("https://github.example.com/a/b"), None);
    }

    #[test]
    fn rejects_non_urls_and_garbage() {
        assert_eq!(parse_repo_url(""), None);
        assert_eq!(parse_repo_url("not a url"), None);
        assert_eq!(parse_repo_url("https://github.com/"), None);
    }

    #[test]
    fn a_repo_named_like_a_subpage_is_still_accepted() {
        // `github.com/owner/issues` 是**合法的仓库名**。只有三段以上才可能
        // 是仓库内的页面，而那段已经被 len != 2 挡掉了 —— 所以两段时不该
        // 再拿子页面列表去排除。
        assert_eq!(
            parse_repo_url("https://github.com/owner/issues"),
            Some(("owner".into(), "issues".into()))
        );
    }

    #[test]
    fn is_case_insensitive_for_the_host() {
        assert_eq!(
            parse_repo_url("https://GitHub.com/tauri-apps/tauri"),
            Some(("tauri-apps".into(), "tauri".into()))
        );
    }
}
