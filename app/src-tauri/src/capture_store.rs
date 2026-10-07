//! 采集产物的落盘与"是否已采集"索引。
//!
//! 布局：一切都平铺在给定的 D 里。
//!
//! ```text
//! D/
//! ├── <对话标题>.md        对话
//! ├── <网页标题>.md        采集到的引用页
//! └── <网页标题>.assets/   引用页的图片（和笔记同名同级）
//! ```
//!
//! **D 由调用方定死，这里不再往下拼子目录。** 早期版本无条件往 `refs/`
//! 里塞引用页，但"引用页该在哪一层"取决于 tab 是怎么打开的，不取决于采集
//! 本身：关联链接（反链）场景是"给这篇笔记收一批引用"，落 `D/refs/`；
//! 打开浏览器读当前文档原文的场景是"给这篇文档留一份"，落文档自己的目录。
//! 那条规则现在住在开 tab 的地方（`stores/tabs.ts` 的 `newBrowserTab`），
//! 每个 tab 的 `refsDir` 在打开时就定好，这里只管写。
//!
//! 已存在的 `D/refs/` 仍会被索引扫到（见 `collect_captured_urls`），不会
//! 因为这次改动全部变回"未采集"。

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
/// 预留一个不冲突的落盘路径。
///
/// 对采集而言这一步必须**先于**下载图片：资源目录跟着最终文件名走，而重名
/// 时会加 `-2` 后缀 —— 先下图片再定文件名的话，目录名和正文里的相对路径
/// 就对不上了。
pub fn reserve_path(dir: &Path, stem: &str) -> PathBuf {
    unique_path(dir, stem)
}

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
/// 范围是 D 本身加上 D/refs —— 关联链接场景把引用页收在 D/refs/ 下，面板
/// 拿到的却是 D，不连子目录一起扫就找不到刚采完的那条。对话笔记和引用页
/// 都可能带 `url:`；对话的 url 是 DeepSeek 会话地址，不会与引用页冲突。
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

/// 落盘一篇笔记，返回实际写入的路径。写进 D 本身 —— D 就是最终目录。
pub fn write_note(dir: &Path, title: &str, body: &str) -> Result<PathBuf, String> {
    let target = dir.to_path_buf();
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
///
/// `captured` 是落盘时刻的 RFC3339，`created` 直接取它的日期部分 —— 多传
/// 一个参数只会多一种把两个日期传反的机会。
pub fn render_reference(
    title: &str,
    url: &str,
    captured: &str,
    via: &str,
    meta: &webdoc::PageMeta,
    body: &str,
    from: Option<&str>,
) -> String {
    let domain = tauri::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_default();

    let mut s = String::from("---\n");
    s.push_str(&format!("title: {}\n", yaml_scalar(title)));
    // `source` 是网页地址（Obsidian Web Clipper 的约定）。`url` 留一份同值
    // 的副本：已采集索引（url_from_frontmatter）和历史笔记都按 `url:` 找，
    // 去掉它等于让所有旧笔记从索引里消失。
    s.push_str(&format!("source: {}\n", yaml_scalar(url)));
    s.push_str(&format!("url: {}\n", yaml_scalar(url)));
    if !domain.is_empty() {
        s.push_str(&format!("domain: {domain}\n"));
    }
    // 作者写成 wikilink，和来源笔记同一个道理：这样"某位作者"在
    // 反向链接面板里能看到自己名下采过什么。
    if !meta.authors.is_empty() {
        s.push_str("author:\n");
        for a in &meta.authors {
            s.push_str(&format!("  - {}\n", yaml_scalar(&format!("[[{a}]]"))));
        }
    }
    if let Some(p) = meta.published.as_deref().filter(|v| !v.trim().is_empty()) {
        s.push_str(&format!("published: {}\n", yaml_scalar(p)));
    }
    s.push_str(&format!("created: {}\n", yaml_scalar(&date_of(captured))));
    s.push_str(&format!("captured: {captured}\n"));
    if let Some(d) = meta.description.as_deref().filter(|v| !v.trim().is_empty()) {
        s.push_str(&format!("description: {}\n", yaml_scalar(d.trim())));
    }
    // 标签全部来自页面自己声明的 meta（keywords / article:tag 之类）。
    // 页面没写就不写这个键 —— 和 author/published 一个规矩：空字符串比
    // 缺字段更糟。
    if !meta.tags.is_empty() {
        s.push_str("tags:\n");
        for t in &meta.tags {
            s.push_str(&format!("  - {}\n", yaml_scalar(t)));
        }
    }
    s.push_str(&format!("via: {via}\n"));
    // 指向来源笔记。**写成 wikilink**，反向链接是靠 workspace index 扫
    // 正文/frontmatter 里的 `[[...]]` 建立的 —— 写个普通字符串不会有任何
    // 关联，用户在来源笔记里看不到"它引用的东西都采过哪些"。
    if let Some(src) = from.filter(|v| !v.trim().is_empty()) {
        s.push_str(&format!("from: {}\n", yaml_scalar(&format!("[[{}]]", src.trim()))));
    }
    s.push_str("---\n\n");
    if let Some(src) = from.filter(|v| !v.trim().is_empty()) {
        // 正文里再放一条：frontmatter 里的 wikilink 不一定会被所有渲染器
        // 显示成可点的链接，正文这条保证它在阅读视图里看得见。
        s.push_str(&format!("> 采集自 [[{}]]\n\n", src.trim()));
    }
    s.push_str(body.trim());
    s.push('\n');
    s
}

/// RFC3339 时间戳 → `YYYY-MM-DD`。认不出来就原样返回。
fn date_of(timestamp: &str) -> String {
    let head = timestamp.trim();
    let b = head.as_bytes();
    let iso = b.len() >= 10
        && b[..4].iter().all(|c| c.is_ascii_digit())
        && b[4] == b'-'
        && b[5..7].iter().all(|c| c.is_ascii_digit())
        && b[7] == b'-'
        && b[8..10].iter().all(|c| c.is_ascii_digit());
    if iso {
        head[..10].to_string()
    } else {
        head.to_string()
    }
}

/// YAML 标量：需要时加引号。
///
/// 判据是 YAML 的**指示符**集合，不只是"看起来含特殊字符"。踩过的坑：
/// `[[某次对话]]` 看着挺正常，但以 `[` 开头在 YAML 里是流式序列的语法，
/// 于是 `source: [[x]]` 会被解析成嵌套数组而不是字符串 —— wikilink 就
/// 永远找不到了。同理还有 `{`、`*`、`&` 等。
fn yaml_scalar(s: &str) -> String {
    // YAML 规范里不能作为普通标量开头的指示符。
    const INDICATORS: [char; 18] = [
        '[', ']', '{', '}', ',', '&', '*', '#', '?', '|', '-', '<', '>', '=', '!', '%', '@', '`',
    ];
    let needs_quotes = s.is_empty()
        || s.chars().any(|c| matches!(c, ':' | '#' | '"' | '\'' | '\n' | '\r'))
        || s.starts_with(INDICATORS)
        || s.starts_with(' ')
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

    let path = write_note(&dir, &stem, &body)?;
    Ok(path.to_string_lossy().to_string())
}

/// 抓一个引用链接：拉页面 → 抽正文 → 写 `<dir>/<标题>.md`（图片落
/// `<dir>/<标题>.assets/`）。`dir` 由调用方定死 —— 关联链接场景传的是
/// `D/refs`，读原文场景传的是文档自己的目录。
///
/// 抓取失败**不返回 Err** —— 那样调用方就得区分"整体失败"和"这一条失败"。
/// 改成始终返回 `FetchOutcome`，把失败装进 `error` 字段，逐条状态由前端展示。
#[tauri::command]
pub async fn capture_fetch_page(
    dir: String,
    url: String,
    fallback_title: String,
    source_title: Option<String>,
) -> Result<FetchOutcome, String> {
    let dir = PathBuf::from(dir);

    // GitHub 仓库页单独走一条路：那个页面真正有价值的就是 README，而
    // 首页 DOM 是导航 + 文件列表 + 统计，readability 在上面抽不出像样的
    // 东西。直接读 README 既准又省。
    if let Some((owner, repo)) = super::github_readme::parse_repo_url(&url) {
        return capture_github_repo(&dir, &url, &owner, &repo, source_title.as_deref()).await;
    }

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
            let body = render_reference(
                &ext.title,
                &url,
                &captured,
                ext.via.as_str(),
                &ext.meta,
                "",
                source_title.as_deref(),
            );
            let path = write_note(&dir, &ext.title, &body)?;
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
    let (title, markdown, via, error, meta) = match extracted {
        Some(e) => (
            if e.title.trim().is_empty() {
                fallback_title.clone()
            } else {
                e.title
            },
            e.markdown,
            e.via.as_str().to_string(),
            None,
            e.meta,
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
            // 正文抽不到不代表页面没声明作者和日期 —— 这种页面恰恰最需要
            // frontmatter 里的信息来辨认，所以单独再读一次 meta。
            webdoc::extract_meta(&html),
        ),
    };

    let path = write_reference_with_assets(
        &dir,
        &title,
        &final_url,
        &captured,
        &via,
        &meta,
        &markdown,
        source_title.as_deref(),
    )
    .await?;

    Ok(FetchOutcome {
        url: final_url,
        title: title.to_string(),
        path: Some(path.to_string_lossy().to_string()),
        via: via.to_string(),
        error,
    })
}

/// 采一个 GitHub 仓库：读 README 落盘，不做正文抽取。
///
/// 文件名用 `owner/repo` 连起来（`tauri-apps__tauri.md`）—— 单用 repo 名会
/// 在 `tauri` 和 `awesome` 这种常见名上撞得很难看。
async fn capture_github_repo(
    dir: &Path,
    url: &str,
    owner: &str,
    repo: &str,
    source_title: Option<&str>,
) -> Result<FetchOutcome, String> {
    let captured = chrono::Local::now().to_rfc3339();
    let title = format!("{owner}__{repo}");

    match super::github_readme::fetch_readme(owner, repo).await {
        Ok((_name, markdown)) => {
            // `via: readme` 让用户一眼看出这篇没有走正文抽取，内容就是
            // README 原文 —— 以后想重新抽也有据可查。
            let path = write_reference_with_assets(
                dir,
                &title,
                url,
                &captured,
                webdoc::Via::Readme.as_str(),
                // README 是仓库里的文件，不是网页 —— 它没有 og:author 之类的
                // 页面元信息，作者/日期这些字段本来就不存在。
                &webdoc::PageMeta::default(),
                &markdown,
                source_title,
            )
            .await?;
            Ok(FetchOutcome {
                url: url.to_string(),
                title,
                path: Some(path.to_string_lossy().to_string()),
                via: webdoc::Via::Readme.as_str().to_string(),
                error: None,
            })
        }
        Err(e) => {
            // 限流、没 README、网络失败 —— 一律落存根，用户至少看得到是哪条。
            let body = render_reference(
                &title,
                url,
                &captured,
                webdoc::Via::Stub.as_str(),
                &webdoc::PageMeta::default(),
                "",
                source_title,
            );
            let p = write_note(dir, &title, &body)?;
            Ok(FetchOutcome {
                url: url.to_string(),
                title,
                path: Some(p.to_string_lossy().to_string()),
                via: webdoc::Via::Stub.as_str().to_string(),
                error: Some(e),
            })
        }
    }
}

/// 写一篇引用页，并把正文里的图片落到 `<文档名>.assets/`。
///
/// 顺序很关键：**先定文件名，再下图片，最后写正文**。资源目录名跟着最终
/// 文件名走（重名会加 `-2` 后缀），反过来的话目录名与正文里的相对路径会错开。
///
/// 图片下载失败**不算整体失败** —— 正文本身有价值，缺一张图不该让整篇丢掉。
async fn write_reference_with_assets(
    dir: &Path,
    title: &str,
    url: &str,
    captured: &str,
    via: &str,
    meta: &webdoc::PageMeta,
    markdown: &str,
    source: Option<&str>,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败 {}: {e}", dir.display()))?;

    let path = reserve_path(dir, &safe_filename(title));
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| safe_filename(title));

    let (localised, _report) = super::page_assets::localise_images(dir, &stem, markdown).await;

    let body = render_reference(title, url, captured, via, meta, &localised, source);
    std::fs::write(&path, body).map_err(|e| format!("写入失败 {}: {e}", path.display()))?;
    Ok(path)
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
    fn yaml_scalar_quotes_yaml_indicators() {
        // 以指示符开头的值在 YAML 里是语法，不是文本：`[[x]]` 会被解析成
        // 嵌套数组。wikilink 正好长这样，所以这条必须引号包起来。
        assert_eq!(yaml_scalar("[[某次对话]]"), "\"[[某次对话]]\"");
        assert_eq!(yaml_scalar("{a: b}"), "\"{a: b}\"");
        assert_eq!(yaml_scalar("*bold*"), "\"*bold*\"");
        // 指示符出现在中间是无害的。
        assert_eq!(yaml_scalar("A [[x]] B"), "A [[x]] B");
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

    fn sample_meta() -> webdoc::PageMeta {
        webdoc::PageMeta {
            authors: vec!["Bingal".to_string()],
            published: Some("2024-01-30".to_string()),
            description: Some("本方案采用 llamafile 的格式".to_string()),
            tags: vec!["AIAgent框架".to_string(), "本地部署".to_string()],
        }
    }

    #[test]
    fn a_reference_without_a_source_has_no_link() {
        let md = render_reference(
            "网页",
            "https://x.example/a",
            "2026-01-01T00:00:00Z",
            "readability",
            &webdoc::PageMeta::default(),
            "正文",
            None,
        );
        assert!(!md.contains("from:"), "无来源时不该写 from 字段");
        assert!(!md.contains("[["), "无来源时不该出现 wikilink");
    }

    #[test]
    fn a_reference_links_back_to_its_source_note() {
        // 反向链接靠 workspace index 扫 `[[...]]` 建立 —— 写个普通字符串
        // 不会在来源笔记里产生任何关联。
        let md = render_reference(
            "网页",
            "https://x.example/a",
            "2026-01-01T00:00:00Z",
            "readability",
            &webdoc::PageMeta::default(),
            "正文",
            Some("某次对话"),
        );
        assert!(md.contains("from: \"[[某次对话]]\""), "frontmatter 里没有 wikilink:\n{md}");
        assert!(md.contains("> 采集自 [[某次对话]]"), "正文里没有可见的链接:\n{md}");
    }

    #[test]
    fn a_blank_source_is_treated_as_no_source() {
        // 空标题会渲染出 `[[]]`，那是个指向不存在笔记的悬空链接。
        let md = render_reference(
            "网页",
            "https://x.example/a",
            "t",
            "stub",
            &webdoc::PageMeta::default(),
            "",
            Some("   "),
        );
        assert!(!md.contains("[["), "空白来源不该产生 wikilink");
    }

    #[test]
    fn a_reference_carries_the_page_meta_and_keeps_the_url_key() {
        // 目标格式：source/author/published/created/description/tags，
        // 外加 url —— 索引和历史笔记都按 `url:` 找，去掉它等于让所有
        // 旧笔记从"已采集"里消失。
        let md = render_reference(
            "网页",
            "https://x.example/a",
            "2026-01-01T10:20:30+08:00",
            "readability",
            &sample_meta(),
            "正文",
            Some("某次对话"),
        );
        // URL 含 `:`，yaml_scalar 会给它加引号 —— 和 Web Clipper 写出来
        // 的形式一致，也是合法 YAML。
        assert!(md.contains("source: \"https://x.example/a\""), "缺 source（URL）:\n{md}");
        assert!(md.contains("url: \"https://x.example/a\""), "缺 url:\n{md}");
        assert_eq!(
            url_from_frontmatter(&md).as_deref(),
            Some("https://x.example/a"),
            "索引读不到 url 了"
        );
        // 作者是列表，每项都是 wikilink（YAML 里 `[[x]]` 必须加引号，
        // 否则会被解析成嵌套数组）。
        assert!(md.contains("author:\n  - \"[[Bingal]]\"\n"), "作者格式不对:\n{md}");
        assert!(md.contains("published: 2024-01-30"), "缺 published:\n{md}");
        // created 取 captured 的日期部分，精确时刻仍然留在 captured 里。
        assert!(md.contains("created: 2026-01-01\n"), "缺 created:\n{md}");
        assert!(md.contains("captured: 2026-01-01T10:20:30+08:00\n"), "缺 captured:\n{md}");
        assert!(md.contains("description: 本方案采用 llamafile 的格式\n"), "缺 description:\n{md}");
        // 标签是页面自己声明的（keywords / article:tag），不再写死 clippings。
        assert!(
            md.contains("tags:\n  - AIAgent框架\n  - 本地部署\n"),
            "tags 不是页面 meta 里的那几个:\n{md}"
        );
        assert!(!md.contains("clippings"), "还留着写死的 clippings:\n{md}");
        assert!(md.contains("via: readability\n"), "缺 via:\n{md}");
    }

    #[test]
    fn a_reference_omits_the_meta_keys_it_does_not_have() {
        // 空字符串比缺字段更糟：用户在笔记里看到 `author: ""` 只会以为
        // 采集坏了。
        let md = render_reference(
            "网页",
            "https://x.example/a",
            "2026-01-01T10:20:30+08:00",
            "stub",
            &webdoc::PageMeta::default(),
            "",
            None,
        );
        assert!(!md.contains("author:"), "无作者时不该写 author:\n{md}");
        assert!(!md.contains("published:"), "无日期时不该写 published:\n{md}");
        assert!(!md.contains("description:"), "无摘要时不该写 description:\n{md}");
        // 页面没声明标签就不写 tags —— 空列表比缺字段更糟。
        assert!(!md.contains("tags:"), "无标签时不该写 tags:\n{md}");
        // 这两个永远在。
        assert!(md.contains("created: 2026-01-01\n"));
        assert!(md.contains("captured: 2026-01-01T10:20:30+08:00\n"));
    }

    #[test]
    fn write_note_writes_into_the_given_dir_and_dedupes_names() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();

        // `refs` 由调用方决定（关联链接场景会传 D/refs），这里只认它给的那个目录。
        let refs = root.join("refs");
        let a = write_note(&refs, "同名", "第一篇").expect("write a");
        assert!(a.ends_with("refs/同名.md"), "路径不对: {}", a.display());
        let b = write_note(&refs, "同名", "第二篇").expect("write b");
        assert!(b.ends_with("refs/同名-2.md"), "重名没有加后缀: {}", b.display());

        assert_eq!(std::fs::read_to_string(&a).unwrap(), "第一篇");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "第二篇");
    }

    #[test]
    fn write_note_does_not_add_a_subdir_of_its_own() {
        // 读原文的场景直接落文档自己的目录 —— 多拼一层 refs 就跑到别处去了。
        let dir = tempfile::tempdir().expect("tempdir");
        let p = write_note(dir.path(), "网页", "正文").expect("write");
        assert_eq!(p.parent(), Some(dir.path()), "被多套了一层目录: {}", p.display());
    }

    #[test]
    fn collect_captured_urls_scans_the_dir_and_the_refs_subdir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();

        write_note(root, "对话", "---\nurl: https://chat.deepseek.com/a/chat/s/1\n---\n").unwrap();
        write_note(root, "网页", "---\nurl: https://example.com/a?utm_source=x\n---\n").unwrap();
        // 没有 url 的笔记不该影响索引。
        write_note(root, "无链接", "# 纯笔记\n").unwrap();

        // 关联链接场景把引用页收在 D/refs/ 下 —— 面板扫 D 时必须连它一起扫，
        // 否则刚采完的那条仍然显示"未采集"，用户会重复采一遍。
        let refs = root.join("refs");
        write_note(&refs, "引用页", "---\nurl: https://refs.example/page\n---\n").unwrap();
        // 非 md 文件要被忽略。
        std::fs::write(refs.join("ignore.txt"), "url: https://nope.example/").unwrap();

        let got = collect_captured_urls(root);
        assert_eq!(got.len(), 3, "扫到的 URL 数量不对: {got:?}");
        assert!(got.contains("https://chat.deepseek.com/a/chat/s/1"));
        assert!(
            got.iter().any(|u| u.contains("refs.example")),
            "D/refs/ 里的引用页没被扫到: {got:?}"
        );
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
