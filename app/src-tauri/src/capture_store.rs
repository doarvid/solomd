//! 采集产物的落盘与"是否已采集"索引。
//!
//! 布局（见 spec）：
//!
//! ```text
//! D/
//! ├── <对话标题>.md      对话平铺
//! └── refs/
//!     └── <网页标题>.md  采集到的引用页
//! ```
//!
//! D 是每个浏览器 tab 各自关联的目录（`Tab.captureDir`），**所有路径都
//! 从它推导** —— 不存在全局默认目录，两个 tab 不会互相覆盖。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::webdoc;

/// 文件名里不能出现的字符。Windows 比 Unix 更严（`<>:"/\|?*`），按 Windows
/// 的标准来就两边都不会出错 —— 笔记目录经常被同步盘在两边搬。
const ILLEGAL: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// 文件名长度上限。留出 `.md` 和去重后缀的余量；按字符算（CJK 一个字
/// 就是一个字符），不按字节。
const MAX_STEM_CHARS: usize = 120;

/// 把标题变成安全的文件名。**不做 slug 化** —— 用户要求"以标题为文件名"，
/// 中文标题要原样保留可读。
pub fn safe_filename(title: &str) -> String {
    // 控制字符（换行、制表）先变成**空格**而不是 `-`：标题里的换行是排版，
    // 不是分隔符。早期版本把两者都替换成 `-`，于是 "第一行\n第二行" 变成
    // "第一行-第二行"。真正的路径分隔符才变 `-`。
    let mut s: String = title
        .chars()
        .map(|c| {
            if ILLEGAL.contains(&c) {
                '-'
            } else if c.is_control() {
                ' '
            } else {
                c
            }
        })
        .collect();

    // 折叠连续空白（含刚换过来的那些）。
    s = s.split_whitespace().collect::<Vec<_>>().join(" ");

    // 首尾的 `.` / `-` / 空白：以点开头在 Unix 上是隐藏文件，用户会以为
    // 笔记丢了；两端都是连字符的名字（标题是 "///" 时）没有任何信息量。
    s = s
        .trim_matches(|c: char| c == '.' || c == '-' || c.is_whitespace())
        .to_string();

    if s.chars().count() > MAX_STEM_CHARS {
        s = s
            .chars()
            .take(MAX_STEM_CHARS)
            .collect::<String>()
            .trim_end()
            .to_string();
    }

    if s.is_empty() {
        // 标题全是非法字符或空白时的兜底。
        s = "untitled".to_string();
    }
    s
}

/// 在 `dir` 里找一个不冲突的 `<stem>.md`，必要时加 `-2`、`-3`。
///
/// 不复用 `capture_endpoint.rs` 的时间戳前缀方案：那里的产物是 inbox 里
/// 的速记，重名无所谓；这里的文件名是用户要认的标题，加时间戳会毁掉
/// 可读性。
fn unique_path(dir: &Path, stem: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.md"));
    if !first.exists() {
        return first;
    }
    for n in 2..1000 {
        let p = dir.join(format!("{stem}-{n}.md"));
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("{stem}-{}.md", now_millis()))
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// URL 归一化 —— 判定"是否已采集"的比对标尺。
///
/// 规则照搬 `obsidian-omnichat/ai.js` 的 `normalizeRefUrl`：去 hash、去跟踪
/// 参数、去尾斜杠。少了这一步，同一个页面因为 `?utm_source=...` 就会被
/// 当成两个不同的链接。
pub fn normalize_url(raw: &str) -> String {
    let s = raw.trim();
    if s.is_empty() {
        return String::new();
    }

    let Ok(mut u) = tauri::Url::parse(s) else {
        // 解析不了的（极少数畸形 URL）退化成"去 hash + 去尾斜杠"。
        return s.split('#').next().unwrap_or(s).trim_end_matches('/').to_string();
    };

    u.set_fragment(None);

    const TRACKING: &[&str] = &[
        "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "spm", "from",
        "source", "feature", "ref", "ref_src", "fbclid", "gclid", "msclkid", "ved", "ei",
    ];
    let keep: Vec<(String, String)> = u
        .query_pairs()
        .filter(|(k, _)| !TRACKING.contains(&k.as_ref()))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if keep.is_empty() {
        u.set_query(None);
    } else {
        let mut qp = u.query_pairs_mut();
        qp.clear();
        for (k, v) in &keep {
            qp.append_pair(k, v);
        }
        drop(qp);
    }

    let mut out = u.to_string();
    if out.ends_with('/') && !out.ends_with("://") {
        out.pop();
    }
    out
}

/// 从一段 frontmatter 文本里取 `url:`。只认最朴素的 `url: value` 与
/// `url: "value"`，不引 YAML 解析器 —— 这是内部产物，格式由我们控制。
fn url_from_frontmatter(text: &str) -> Option<String> {
    let rest = text.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    let fm = &rest[..end];
    for line in fm.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("url:") {
            let v = v.trim().trim_matches('"').trim_matches('\'').trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

pub fn url_of_note(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    url_from_frontmatter(&text)
}

/// 扫描目标目录里所有已采集笔记的 URL（归一化后）。
///
/// 范围是 D 本身加上 D/refs —— 对话笔记和引用页都可能带 `url:`。对话的
/// url 是 DeepSeek 会话地址，不会与引用页冲突。
///
/// **只扫一层**，不递归：这个目录是用户为一次研究建的，不该把整个 vault
/// 拖进来。只读 frontmatter，不解析正文。
pub fn collect_captured_urls(dir: &Path) -> HashSet<String> {
    let mut out = HashSet::new();
    for sub in [dir.to_path_buf(), dir.join("refs")] {
        let Ok(entries) = std::fs::read_dir(&sub) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().map(|e| e.eq_ignore_ascii_case("md")) != Some(true) {
                continue;
            }
            if let Some(u) = url_of_note(&p) {
                let n = normalize_url(&u);
                if !n.is_empty() {
                    out.insert(n);
                }
            }
        }
    }
    out
}

/// 落盘一篇笔记，返回实际写入的路径。
///
/// `sub` 为 None 写进 D 本身（对话），为 Some("refs") 写进子目录（引用页）。
pub fn write_note(
    dir: &Path,
    sub: Option<&str>,
    title: &str,
    body: &str,
) -> Result<PathBuf, String> {
    let target = match sub {
        Some(s) => dir.join(s),
        None => dir.to_path_buf(),
    };
    std::fs::create_dir_all(&target).map_err(|e| format!("创建目录失败 {}: {e}", target.display()))?;

    let stem = safe_filename(title);
    let path = unique_path(&target, &stem);
    std::fs::write(&path, body).map_err(|e| format!("写入失败 {}: {e}", path.display()))?;
    Ok(path)
}

/// 拼对话笔记的 frontmatter + 正文。
pub fn render_conversation(title: &str, url: &str, model: &str, captured: &str, body: &str) -> String {
    let mut s = String::from("---\n");
    s.push_str(&format!("title: {}\n", yaml_scalar(title)));
    s.push_str("source: deepseek\n");
    if !url.is_empty() {
        s.push_str(&format!("url: {}\n", yaml_scalar(url)));
    }
    if !model.is_empty() {
        s.push_str(&format!("model: {}\n", yaml_scalar(model)));
    }
    s.push_str(&format!("captured: {captured}\n"));
    s.push_str("---\n\n");
    s.push_str(body.trim());
    s.push('\n');
    s
}

/// 拼引用页的 frontmatter + 正文。
pub fn render_reference(
    title: &str,
    url: &str,
    captured: &str,
    via: &str,
    body: &str,
) -> String {
    let domain = tauri::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_default();

    let mut s = String::from("---\n");
    s.push_str(&format!("title: {}\n", yaml_scalar(title)));
    s.push_str(&format!("url: {}\n", yaml_scalar(url)));
    if !domain.is_empty() {
        s.push_str(&format!("domain: {domain}\n"));
    }
    s.push_str(&format!("captured: {captured}\n"));
    s.push_str(&format!("via: {via}\n"));
    s.push_str("---\n\n");
    s.push_str(body.trim());
    s.push('\n');
    s
}

/// YAML 标量：含特殊字符时加引号，避免标题里的 `:` 把 frontmatter 弄坏。
fn yaml_scalar(s: &str) -> String {
    let needs_quotes = s.is_empty()
        || s.chars().any(|c| matches!(c, ':' | '#' | '"' | '\'' | '\n' | '\r'))
        || s.starts_with([' ', '-', '?', '*', '&', '!', '|', '>', '@', '`'])
        || s.ends_with(' ');
    if needs_quotes {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchOutcome {
    pub url: String,
    /// 落盘后的标题（抓取失败时是存根用的原始标题）。
    pub title: String,
    /// 写入的文件路径；None 表示没写。
    pub path: Option<String>,
    /// `selector` / `readability` / `stub`。
    pub via: String,
    /// 失败原因；成功时 None。
    pub error: Option<String>,
}

/// 保存一篇对话笔记到 `<dir>/<标题>.md`。
#[tauri::command]
pub fn capture_save_conversation(
    dir: String,
    title: String,
    url: String,
    model: String,
    markdown: String,
) -> Result<String, String> {
    let dir = PathBuf::from(dir);
    let captured = chrono::Local::now().to_rfc3339();
    let body = render_conversation(&title, &url, &model, &captured, &markdown);

    // 标题为空时用时间戳兜底，避免所有空标题对话都叫 untitled 然后一路 -2 -3。
    let stem = if safe_filename(&title) == "untitled" {
        format!("对话 {}", chrono::Local::now().format("%Y-%m-%d %H%M%S"))
    } else {
        title.clone()
    };

    let path = write_note(&dir, None, &stem, &body)?;
    Ok(path.to_string_lossy().to_string())
}

/// 抓一个引用链接：拉页面 → 抽正文 → 写 `<dir>/refs/<标题>.md`。
///
/// 抓取失败**不返回 Err** —— 那样调用方就得区分"整体失败"和"这一条失败"。
/// 改成始终返回 `FetchOutcome`，把失败装进 `error` 字段，逐条状态由前端展示。
#[tauri::command]
pub async fn capture_fetch_page(
    dir: String,
    url: String,
    fallback_title: String,
) -> Result<FetchOutcome, String> {
    let dir = PathBuf::from(dir);
    let captured = chrono::Local::now().to_rfc3339();

    let host = tauri::Url::parse(&url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_default();

    let (final_url, html) = match webdoc::fetch_html(&url).await {
        Ok(v) => v,
        Err(e) => {
            // 抓不到就落一个存根：用户至少能在列表里看到"这条存在但没抓到"，
            // 而不是它凭空消失。
            let ext = webdoc::stub(&url, &fallback_title);
            let body = render_reference(&ext.title, &url, &captured, ext.via.as_str(), "");
            let path = write_note(&dir, Some("refs"), &ext.title, &body)?;
                    return Ok(FetchOutcome {
                url,
                title: ext.title,
                path: Some(path.to_string_lossy().to_string()),
                via: ext.via.as_str().to_string(),
                error: Some(e),
            });
        }
    };

    let extracted = webdoc::extract(&html, &final_url, &host);
    let (title, markdown, via, error) = match extracted {
        Some(e) => (
            if e.title.trim().is_empty() {
                fallback_title.clone()
            } else {
                e.title
            },
            e.markdown,
            e.via.as_str().to_string(),
            None,
        ),
        None => (
            if fallback_title.trim().is_empty() {
                final_url.clone()
            } else {
                fallback_title.clone()
            },
            String::new(),
            "stub".to_string(),
            Some("没能抽到正文（页面可能需要登录或由 JS 渲染）".to_string()),
        ),
    };

    let body = render_reference(&title, &final_url, &captured, &via, &markdown);
    let path = write_note(&dir, Some("refs"), &title, &body)?;

    Ok(FetchOutcome {
        url: final_url,
        title: title.to_string(),
        path: Some(path.to_string_lossy().to_string()),
        via: via.to_string(),
        error,
    })
}

/// 扫描目标目录，返回**已采集的归一化 URL**。前端用它给每个链接打标。
#[tauri::command]
pub fn capture_captured_urls(dir: String) -> Result<Vec<String>, String> {
    let set = collect_captured_urls(Path::new(&dir));
    Ok(set.into_iter().collect())
}

/// 归一化一个 URL —— 前端的比对必须和 Rust 侧用同一套规则，所以由这里
/// 提供，避免两边各写一份然后慢慢漂移。
#[tauri::command]
pub fn capture_normalize_url(url: String) -> String {
    normalize_url(&url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filename_keeps_cjk_and_spaces() {
        assert_eq!(safe_filename("如何理解 Transformer 架构"), "如何理解 Transformer 架构");
    }

    #[test]
    fn filename_replaces_path_separators() {
        // 标题里带 `/` 会直接导致建文件失败或写错目录。
        assert_eq!(safe_filename("A/B 测试"), "A-B 测试");
        assert_eq!(safe_filename("2024: 年终总结"), "2024- 年终总结");
    }

    #[test]
    fn filename_collapses_whitespace_including_newlines() {
        assert_eq!(safe_filename("第一行\n第二行"), "第一行 第二行");
        assert_eq!(safe_filename("  多余   空格  "), "多余 空格");
    }

    #[test]
    fn filename_strips_leading_dots() {
        // 以点开头的文件在 Unix 上是隐藏文件，用户会以为笔记丢了。
        assert_eq!(safe_filename("...hidden"), "hidden");
    }

    #[test]
    fn filename_never_comes_back_empty() {
        assert_eq!(safe_filename("///"), "untitled");
        assert_eq!(safe_filename("   "), "untitled");
    }

    #[test]
    fn filename_is_capped_by_chars_not_bytes() {
        let long = "中".repeat(500);
        let got = safe_filename(&long);
        assert_eq!(got.chars().count(), MAX_STEM_CHARS);
    }

    #[test]
    fn url_normalisation_drops_tracking_params() {
        let a = normalize_url("https://example.com/p/1?utm_source=x&spm=y");
        let b = normalize_url("https://example.com/p/1");
        assert_eq!(a, b, "跟踪参数不同不该被当成两个页面");
    }

    #[test]
    fn url_normalisation_keeps_meaningful_params() {
        let a = normalize_url("https://example.com/p?id=42");
        assert!(a.contains("id=42"), "有意义的参数被误删: {a}");
    }

    #[test]
    fn url_normalisation_drops_fragment_and_trailing_slash() {
        assert_eq!(
            normalize_url("https://example.com/a/#section"),
            "https://example.com/a"
        );
        // 裸域名的尾斜杠也去掉，且「带不带尾斜杠」必须归一成同一个值 ——
        // 否则同一篇文章的两个写法会被当成两篇。
        assert_eq!(normalize_url("https://example.com/"), "https://example.com");
        assert_eq!(
            normalize_url("https://example.com/"),
            normalize_url("https://example.com")
        );
    }

    #[test]
    fn url_normalisation_survives_a_malformed_url() {
        // 不能 panic —— 这串东西来自任意网页。
        assert_eq!(normalize_url("not a url#frag"), "not a url");
        assert_eq!(normalize_url(""), "");
    }

    #[test]
    fn frontmatter_url_is_read() {
        let text = "---\ntitle: x\nurl: https://example.com/a\nvia: selector\n---\n\nbody";
        assert_eq!(
            url_from_frontmatter(text).as_deref(),
            Some("https://example.com/a")
        );
    }

    #[test]
    fn frontmatter_url_handles_quotes() {
        let text = "---\nurl: \"https://example.com/a?b=1\"\n---\n";
        assert_eq!(
            url_from_frontmatter(text).as_deref(),
            Some("https://example.com/a?b=1")
        );
    }

    #[test]
    fn a_note_without_frontmatter_has_no_url() {
        assert!(url_from_frontmatter("# 只是标题\n\n正文").is_none());
        assert!(url_from_frontmatter("---\ntitle: x\n---\n").is_none());
    }

    #[test]
    fn yaml_scalar_quotes_when_needed() {
        assert_eq!(yaml_scalar("普通标题"), "普通标题");
        assert_eq!(yaml_scalar("A: B"), "\"A: B\"");
        assert_eq!(yaml_scalar("say \"hi\""), "\"say \\\"hi\\\"\"");
    }

    #[test]
    fn render_conversation_has_a_parseable_frontmatter() {
        let md = render_conversation("标题", "https://chat.deepseek.com/a/chat/s/1", "deepseek-chat", "2026-10-04T00:00:00Z", "正文");
        assert!(md.starts_with("---\n"));
        assert_eq!(
            url_from_frontmatter(&md).as_deref(),
            Some("https://chat.deepseek.com/a/chat/s/1")
        );
        assert!(md.contains("正文"));
    }

    #[test]
    fn write_note_creates_the_refs_subdir_and_dedupes_names() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();

        let a = write_note(root, Some("refs"), "同名", "第一篇").expect("write a");
        assert!(a.ends_with("refs/同名.md"), "路径不对: {}", a.display());
        let b = write_note(root, Some("refs"), "同名", "第二篇").expect("write b");
        assert!(b.ends_with("refs/同名-2.md"), "重名没有加后缀: {}", b.display());

        assert_eq!(std::fs::read_to_string(&a).unwrap(), "第一篇");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "第二篇");
    }

    #[test]
    fn collect_captured_urls_scans_both_the_dir_and_refs() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();

        write_note(
            root,
            None,
            "对话",
            "---\nurl: https://chat.deepseek.com/a/chat/s/1\n---\n",
        )
        .unwrap();
        write_note(
            root,
            Some("refs"),
            "网页",
            "---\nurl: https://example.com/a?utm_source=x\n---\n",
        )
        .unwrap();
        // 没有 url 的笔记不该影响索引。
        write_note(root, Some("refs"), "无链接", "# 纯笔记\n").unwrap();
        // 非 md 文件要被忽略。
        std::fs::write(root.join("refs/ignore.txt"), "url: https://nope.example/").unwrap();

        let got = collect_captured_urls(root);
        assert_eq!(got.len(), 2, "扫到的 URL 数量不对: {got:?}");
        assert!(got.contains("https://chat.deepseek.com/a/chat/s/1"));
        // 关键：带跟踪参数的那条要以归一化形式入索引，否则下次比对不上。
        assert!(
            got.contains("https://example.com/a"),
            "URL 没有归一化: {got:?}"
        );
    }

    #[test]
    fn collect_on_a_missing_directory_is_empty_not_an_error() {
        let got = collect_captured_urls(Path::new("/definitely/not/here"));
        assert!(got.is_empty());
    }
}
