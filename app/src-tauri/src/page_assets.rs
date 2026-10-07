//! 采集网页时把正文里的图片下载到本地。
//!
//! 目录约定沿用编辑器自己的「每文件一个资源目录」模式：
//!
//! ```text
//! D/refs/
//! ├── 某篇文章.md
//! └── 某篇文章.assets/       ← 和文档同级、同名
//!     ├── 1-figure.png
//!     └── 2-chart.jpg
//! ```
//!
//! 这个命名不是随便定的：`fs_rename` 在重命名笔记时**已经会**把
//! `<stem>.assets/` 一起搬走并改写正文里的引用（见 lib/cm-image-paste.ts
//! 的说明）。用同一套约定，重命名就能免费工作；换个名字就得在那边再补一条
//! 规则。
//!
//! 图片下载失败**不算整体失败**：正文本身有价值，缺一张图不该让整篇丢掉。
//! 失败的图保留原远程 URL，至少还能点开。

use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

use serde::Serialize;

use super::capture_store::safe_filename;

/// 图片下载上限。一篇文章几十张图是正常的，几百张多半是误抓。
const MAX_IMAGES: usize = 200;

/// 单张图片的大小上限。
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

const FETCH_TIMEOUT_SECS: u64 = 20;

const UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/124.0 Safari/537.36 SoloMD/1.0";

/// markdown 图片：`![alt](url "title")`。只取 URL，alt/title 原样保留。
static MD_IMG: once_cell::sync::Lazy<regex_lite::Regex> = once_cell::sync::Lazy::new(|| {
    regex_lite::Regex::new(r#"!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)"#).expect("md img regex")
});

/// 残留的 HTML `<img src="...">`（htmd 不保证把所有 img 都转成 markdown）。
static HTML_IMG: once_cell::sync::Lazy<regex_lite::Regex> = once_cell::sync::Lazy::new(|| {
    regex_lite::Regex::new(r#"(?i)<img[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>"#).expect("html img")
});

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetReport {
    pub downloaded: usize,
    pub failed: usize,
    /// 资源目录相对于笔记的路径，例如 `./某篇文章.assets`。没下载任何图时为 None。
    pub folder: Option<String>,
}

/// 从 markdown 里收集图片 URL（保持出现顺序，去重）。
pub fn collect_image_urls(markdown: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for caps in MD_IMG.captures_iter(markdown) {
        if let Some(m) = caps.get(2) {
            let u = m.as_str().trim().to_string();
            if !u.is_empty() && seen.insert(u.clone()) {
                out.push(u);
            }
        }
    }
    for caps in HTML_IMG.captures_iter(markdown) {
        if let Some(m) = caps.get(1) {
            let u = m.as_str().trim().to_string();
            if !u.is_empty() && seen.insert(u.clone()) {
                out.push(u);
            }
        }
    }
    out
}

/// 从 URL 推一个本地文件名。
///
/// 保留原文件名（SEO 友好的站点会给出有意义的 slug），加序号前缀保证顺序
/// 且避免重名。没有扩展名时按 content-type 猜（见 `ext_for`）。
fn local_name(index: usize, url: &str, content_type: Option<&str>) -> String {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let raw = path.rsplit('/').next().unwrap_or("");
    let decoded = percent_decode(raw);

    let (stem, ext) = match decoded.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric()) => {
            (s.to_string(), e.to_ascii_lowercase())
        }
        _ => (decoded.clone(), String::new()),
    };

    let stem = safe_filename(if stem.is_empty() { "image" } else { &stem });
    let ext = if ext.is_empty() {
        ext_for(content_type).to_string()
    } else {
        ext
    };

    // 序号前缀：保证目录里的顺序和正文一致，也天然避免重名。
    format!("{index}-{stem}.{ext}")
}

fn ext_for(content_type: Option<&str>) -> &'static str {
    match content_type.unwrap_or("").split(';').next().unwrap_or("").trim() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/avif" => "avif",
        "image/bmp" => "bmp",
        _ => "png",
    }
}

/// 极简百分号解码。图片名里 `%20` 之类很常见，留着会让文件名难看且难匹配。
///
/// `pub(crate)`：webdoc 解 Lake 的 `<card value="data:%7B...">` 也要用它 ——
/// 同一套规则没必要写两遍。
pub(crate) fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 把相对路径编码成 markdown 链接目标认得的形式。
///
/// 规则要和前端 `lib/md-image-url.ts` 的 `encodeImageDestination` 对齐 ——
/// 两边一个 .ts 一个 .rs，没有能共享的地方，只能靠同一批用例钉住
/// （见本文件与 `app/src/lib/md-image-url.test.ts` 的测试）。
///
/// 为什么必须编码：CommonMark 的裸目标不允许空格，`![](./My Note.assets/1-x.png)`
/// **根本不是图片**，markdown-it 会把整行当普通文本原样渲染（#345）。而这里
/// 的目录名就是文章标题，`safe_filename` 保留空格 —— 英文标题基本都带空格，
/// 于是表现就是"图下载了，正文里却是一行字面文本"。`%` 也要转义：渲染出的
/// `src` 回到路径时只解码一次，留着会把 `100%.png` 解坏。
///
/// 只动会破坏目标的字符：字母、CJK 和 `/` 都原样留着。
/// `pub(crate)`：`commands.rs` 改笔记名时也要用它 —— 正文里的 `.assets/`
/// 引用可能是编码过的，磁盘上的目录名是原文，两边得用同一套规则对齐。
pub(crate) fn encode_md_destination(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for ch in path.chars() {
        match ch {
            '%' => out.push_str("%25"),
            ' ' => out.push_str("%20"),
            '(' => out.push_str("%28"),
            ')' => out.push_str("%29"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            // 其余空白（制表、换行、不间断空格）按 UTF-8 逐字节编码。
            c if c.is_whitespace() => {
                for b in c.to_string().as_bytes() {
                    out.push_str(&format!("%{b:02X}"));
                }
            }
            c => out.push(c),
        }
    }
    out
}

/// 下载正文里的图片，写到 `<dir>/<stem>.assets/`，并把 markdown 里的远程
/// URL 改写成相对路径（编码见 `encode_md_destination`）。
///
/// 返回改写后的 markdown 和一份统计。任何一张图失败都只影响它自己 ——
/// 保留原 URL，正文照常落盘。
pub async fn localise_images(dir: &Path, stem: &str, markdown: &str) -> (String, AssetReport) {
    let urls = collect_image_urls(markdown);
    if urls.is_empty() {
        return (markdown.to_string(), AssetReport::default());
    }

    let folder_name = format!("{}.assets", safe_filename(stem));
    let folder = dir.join(&folder_name);

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT_SECS))
        .user_agent(UA)
        .build()
    {
        Ok(c) => c,
        // 连 client 都建不起来就别建目录了，直接放弃本地化。
        Err(_) => return (markdown.to_string(), AssetReport::default()),
    };

    let mut out = markdown.to_string();
    let mut report = AssetReport::default();

    for (i, url) in urls.iter().take(MAX_IMAGES).enumerate() {
        // 只处理远程图片；已经是本地相对路径的跳过（重复采集时会出现）。
        if !url.starts_with("http://") && !url.starts_with("https://") {
            continue;
        }

        let resp = match client.get(url).send().await {
            Ok(r) if r.status().is_success() => r,
            _ => {
                report.failed += 1;
                continue;
            }
        };

        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());

        let bytes = match resp.bytes().await {
            Ok(b) if b.len() <= MAX_IMAGE_BYTES => b,
            _ => {
                report.failed += 1;
                continue;
            }
        };

        let name = local_name(i + 1, url, content_type.as_deref());
        if std::fs::create_dir_all(&folder).is_err() || std::fs::write(folder.join(&name), &bytes).is_err() {
            report.failed += 1;
            continue;
        }

        let rel = encode_md_destination(&format!("./{}/{}", folder_name, name));
        out = out.replace(url.as_str(), &rel);
        report.downloaded += 1;
    }

    if report.downloaded == 0 {
        // 一张都没下成，别留下一个空目录。
        let _ = std::fs::remove_dir(&folder);
    } else {
        report.folder = Some(format!("./{folder_name}"));
    }

    (out, report)
}

/// 资源目录的绝对路径。只给测试用 —— 生产路径是在 `localise_images` 里
/// 现算的，没有第二个调用方。
#[cfg(test)]
fn assets_dir(dir: &Path, stem: &str) -> PathBuf {
    dir.join(format!("{}.assets", safe_filename(stem)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_markdown_images_in_order() {
        let md = "![a](https://x.example/1.png)\n\ntext\n\n![b](https://x.example/2.png)";
        assert_eq!(
            collect_image_urls(md),
            vec!["https://x.example/1.png", "https://x.example/2.png"]
        );
    }

    #[test]
    fn collects_html_images() {
        let md = r#"<img src="https://x.example/a.png" alt="x">"#;
        assert_eq!(collect_image_urls(md), vec!["https://x.example/a.png"]);
    }

    #[test]
    fn deduplicates_repeated_images() {
        let md = "![a](https://x.example/1.png)\n![b](https://x.example/1.png)";
        assert_eq!(collect_image_urls(md), vec!["https://x.example/1.png"]);
    }

    #[test]
    fn ignores_non_image_links() {
        // 普通链接不是图片，不该被当资源下载。
        assert!(collect_image_urls("[文字](https://x.example/page)").is_empty());
    }

    #[test]
    fn strips_title_and_angle_brackets_from_markdown_images() {
        let md = "![a](<https://x.example/1.png> \"标题\")";
        assert_eq!(collect_image_urls(md), vec!["https://x.example/1.png"]);
    }

    #[test]
    fn local_name_keeps_the_original_filename_with_an_order_prefix() {
        assert_eq!(
            local_name(1, "https://x.example/path/figure-1.png", None),
            "1-figure-1.png"
        );
    }

    #[test]
    fn local_name_drops_query_strings() {
        assert_eq!(
            local_name(2, "https://x.example/a.jpg?w=800&h=600", None),
            "2-a.jpg"
        );
    }

    #[test]
    fn local_name_guesses_extension_from_content_type() {
        // 很多 CDN 的图片 URL 没有扩展名，靠 content-type 补。
        assert_eq!(
            local_name(3, "https://x.example/image", Some("image/webp")),
            "3-image.webp"
        );
        assert_eq!(
            local_name(3, "https://x.example/image", Some("image/jpeg; charset=binary")),
            "3-image.jpg"
        );
    }

    #[test]
    fn local_name_decodes_percent_escapes() {
        assert_eq!(
            local_name(1, "https://x.example/%E4%B8%AD%E6%96%87.png", None),
            "1-中文.png"
        );
        assert_eq!(local_name(1, "https://x.example/a%20b.png", None), "1-a b.png");
    }

    #[test]
    fn local_name_falls_back_when_there_is_no_usable_name() {
        // 典型的 CDN 形态：路径以 / 结尾，没有文件名。
        let got = local_name(1, "https://x.example/", None);
        assert!(got.starts_with("1-image"), "got {got}");
    }

    #[test]
    fn local_name_sanitises_path_separators_that_arrive_encoded() {
        // 解码后可能出现分隔符 —— 必须挡住，否则会写到别的目录去。
        let got = local_name(1, "https://x.example/a%2Fb.png", None);
        assert!(!got.contains('/'), "文件名里出现了路径分隔符: {got}");
    }

    #[test]
    fn percent_decode_leaves_plain_text_alone() {
        assert_eq!(percent_decode("plain-name.png"), "plain-name.png");
        // 畸形的转义序列不能 panic，也不能丢字符。
        assert_eq!(percent_decode("bad%zz"), "bad%zz");
        assert_eq!(percent_decode("trailing%"), "trailing%");
    }

    #[test]
    fn assets_dir_sits_next_to_the_document() {
        // 用户明确要求：资源目录和文档同级、同名。
        let got = assets_dir(Path::new("/vault/refs"), "某篇文章");
        assert_eq!(got, PathBuf::from("/vault/refs/某篇文章.assets"));
    }

    #[test]
    fn assets_dir_sanitises_the_stem_the_same_way_as_the_note() {
        // 文档名里的 `/` 会被文件名规范化换成 `-`，目录名必须跟着一致，
        // 否则目录对不上正文里的相对路径。
        let stem = safe_filename("A/B 测试");
        assert_eq!(
            assets_dir(Path::new("/vault"), "A/B 测试"),
            PathBuf::from(format!("/vault/{stem}.assets"))
        );
    }

    #[tokio::test]
    async fn a_document_with_no_images_is_untouched() {
        let dir = tempfile::tempdir().expect("tempdir");
        let md = "# 标题\n\n没有图片。";
        let (out, report) = localise_images(dir.path(), "x", md).await;
        assert_eq!(out, md);
        assert_eq!(report.downloaded, 0);
        assert!(report.folder.is_none());
        // 不能凭空建一个空目录。
        assert!(!dir.path().join("x.assets").exists());
    }

    // 下面这批用例和 app/src/lib/md-image-url.test.ts 一一对应：两份实现
    // 没有共享代码的地方，靠同一批输入钉住它们不会漂移。
    #[test]
    fn encode_md_destination_matches_the_frontend() {
        // 带空格的标题 → 带空格的目录名，这是采集最常见的形态。
        assert_eq!(
            encode_md_destination("./How to Build a Widget.assets/1-figure.png"),
            "./How%20to%20Build%20a%20Widget.assets/1-figure.png"
        );
        // 没问题的字符不该被改动 —— 中文标题、下划线目录都保持可读。
        assert_eq!(encode_md_destination("./图片.assets/1-截图.png"), "./图片.assets/1-截图.png");
        assert_eq!(encode_md_destination("_assets/image-1.png"), "_assets/image-1.png");
    }

    #[test]
    fn encode_md_destination_handles_every_character_that_breaks_a_bare_target() {
        // 括号：markdown-it 在裸目标里遇到不成对的括号同样解析不出来。
        assert_eq!(
            encode_md_destination("./Pictures (old)/x.png"),
            "./Pictures%20%28old%29/x.png"
        );
        // `%` 必须先转义：渲染出的 src 回到路径时只解码一次。
        assert_eq!(encode_md_destination("./100%.png"), "./100%25.png");
        assert_eq!(encode_md_destination("./a%20b.png"), "./a%2520b.png");
        assert_eq!(encode_md_destination("./a<b>c.png"), "./a%3Cb%3Ec.png");
    }

    #[tokio::test]
    async fn unreachable_images_leave_the_markdown_intact() {
        // 下载全失败时正文必须原样保留，远程 URL 还在，用户还能点开。
        let dir = tempfile::tempdir().expect("tempdir");
        let md = "![a](https://127.0.0.1:1/nope.png)";
        let (out, report) = localise_images(dir.path(), "x", md).await;
        assert_eq!(out, md, "正文被改坏了");
        assert_eq!(report.downloaded, 0);
        assert_eq!(report.failed, 1);
        assert!(!dir.path().join("x.assets").exists(), "留下了空目录");
    }
}
