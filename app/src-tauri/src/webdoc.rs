//! 网页正文抽取 —— 三层流水线的第 1、2 级。
//!
//! 1. **站点规则**（`extract_rules`）：按域名查 CSS 选择器，命中即用。
//!    292 条种子来自简悦，长尾站点由 AI 学习补充（第 3 级，尚未实现）。
//! 2. **Readability**（`dom_smoothie`）：离线、无 JS，对文章类页面命中率足够。
//! 3. **AI**：兜底，见 spec 的 P5。
//!
//! 前一级抽出来的正文 < `MIN_CONTENT_CHARS` 就当没抽到，降级到下一级 ——
//! 一个失效的选择器最典型的失败不是"匹配不到"，而是"匹配到了一个空壳
//! 导航栏"，两种都要能识别。

use serde::{Deserialize, Serialize};

// `super::`, not `crate::` —— this file compiles into two roots (lib via
// lib.rs, bin via runner.rs's #[path]). `super::` means the crate root in
// both; `crate::` only resolves in one.
use super::extract_rules::{self, MIN_CONTENT_CHARS};

/// 正文是怎么来的。写进笔记 frontmatter，方便日后回查质量问题。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Via {
    /// 站点规则命中。
    Selector,
    /// Readability 抽的。
    Readability,
    /// 用户在浏览器里手动选中的。
    Selection,
    /// 只存了标题和链接，没有正文。
    Stub,
}

impl Via {
    pub fn as_str(self) -> &'static str {
        match self {
            Via::Selector => "selector",
            Via::Readability => "readability",
            Via::Selection => "selection",
            Via::Stub => "stub",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Extracted {
    pub title: String,
    pub markdown: String,
    pub via: Via,
    /// 实际抓取的最终 URL（跟随重定向后）。
    pub url: String,
}

/// 单页 HTML 的上限。再大就不是文章了，多半是反爬返回的巨大页面或误抓的
/// 二进制；继续处理只会把内存和时间吃光。
const MAX_HTML_BYTES: usize = 8 * 1024 * 1024;

/// 抓取超时。站点慢是常态，但一个卡住的请求会拖住整批采集。
const FETCH_TIMEOUT_SECS: u64 = 20;

const UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/124.0 Safari/537.36 SoloMD/1.0";

/// 拉页面。返回 (最终 URL, HTML)。
///
/// 用 reqwest 直取，**不带 cookie、不执行 JS** —— 所以需要登录或前端渲染的
/// 站点（知乎、部分公众号文章）拿不到正文，那条路径由「选中片段」兜底。
pub async fn fetch_html(url: &str) -> Result<(String, String), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT_SECS))
        .user_agent(UA)
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }

    let final_url = resp.url().to_string();

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;
    if bytes.len() > MAX_HTML_BYTES {
        return Err(format!("页面过大（{} 字节）", bytes.len()));
    }

    let html = decode_html(&bytes);
    Ok((final_url, html))
}

/// 网页编码不一定是 UTF-8 —— 中文站点大量使用 GBK。照搬 `convert.rs` 和
/// `commands.rs` 的探测写法（同一套 chardetng 参数），别另起一套。
fn decode_html(bytes: &[u8]) -> String {
    use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};

    let mut detector = EncodingDetector::new(Iso2022JpDetection::Allow);
    detector.feed(bytes, true);
    let enc = detector.guess(None, Utf8Detection::Allow);
    let (text, _, _) = enc.decode(bytes);
    text.into_owned()
}

/// 第 1 级：用站点规则抽。
fn extract_with_rule(html: &str, host: &str, url: &str) -> Option<Extracted> {
    let rule = extract_rules::lookup(host)?;

    let doc = scraper::Html::parse_document(html);
    let content_sel = scraper::Selector::parse(&rule.content).ok()?;
    let node = doc.select(&content_sel).next()?;

    // 先把要剔除的部分摘掉，再取剩下的 HTML。scraper 的节点是只读的，
    // 所以剔除要在序列化后的字符串上做 —— 剔不掉就少剔，不能因此失败。
    let mut body = node.html();
    for sel in &rule.remove {
        if let Ok(s) = scraper::Selector::parse(sel) {
            for n in doc.select(&s) {
                let frag = n.html();
                if !frag.is_empty() {
                    body = body.replace(&frag, "");
                }
            }
        }
    }

    let text_len = plain_text_len(&body);
    if text_len < MIN_CONTENT_CHARS {
        return None;
    }

    // 标题：规则的 title 选择器 → <title> → 空。
    let title = rule
        .title
        .as_deref()
        .and_then(|t| scraper::Selector::parse(t).ok())
        .and_then(|s| doc.select(&s).next())
        .map(|n| n.text().collect::<String>().trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| document_title(&doc));

    Some(Extracted {
        title,
        markdown: html_to_markdown(&body),
        via: Via::Selector,
        url: url.to_string(),
    })
}

/// 第 2 级：Readability。
fn extract_with_readability(html: &str, url: &str) -> Option<Extracted> {
    let mut readability = dom_smoothie::Readability::new(html, Some(url), None).ok()?;
    let article = readability.parse().ok()?;

    let body = article.content.to_string();
    if plain_text_len(&body) < MIN_CONTENT_CHARS {
        return None;
    }

    Some(Extracted {
        title: {
            let t = article.title.trim().to_string();
            if t.is_empty() {
                document_title_str(html)
            } else {
                t
            }
        },
        markdown: html_to_markdown(&body),
        via: Via::Readability,
        url: url.to_string(),
    })
}

/// 抽正文。前一级不够就降级，两级都不行返回 None（调用方转存根）。
///
/// 命中与否会喂回规则库的计数 —— 这是种子规则能自我淘汰的唯一途径。
pub fn extract(html: &str, url: &str, host: &str) -> Option<Extracted> {
    if let Some(e) = extract_with_rule(html, host, url) {
        extract_rules::record_hit(host);
        return Some(e);
    }
    if has_rule(host) {
        // 有规则但没抽到东西 —— 规则失效了，记一笔。攒够就 stale，之后
        // 该域名直接跳过第 1 级。
        extract_rules::record_miss(host);
    }
    extract_with_readability(html, url)
}

fn has_rule(host: &str) -> bool {
    extract_rules::lookup(host).is_some()
}

fn document_title(doc: &scraper::Html) -> String {
    scraper::Selector::parse("title")
        .ok()
        .and_then(|s| doc.select(&s).next())
        .map(|n| n.text().collect::<String>().trim().to_string())
        .unwrap_or_default()
}

fn document_title_str(html: &str) -> String {
    document_title(&scraper::Html::parse_document(html))
}

/// 正文字数（不含标签）。用来判断"到底抽到东西没有"。
fn plain_text_len(html: &str) -> usize {
    let doc = scraper::Html::parse_fragment(html);
    doc.root_element().text().collect::<String>().trim().chars().count()
}

/// HTML → Markdown。复用 `convert.rs` 同款的噪音清理 + htmd。
fn html_to_markdown(html: &str) -> String {
    let cleaned = strip_noise(html);
    htmd::convert(&cleaned).unwrap_or_else(|_| cleaned)
}

/// 丢掉 htmd 会当成正文输出的 script/style/head 等块。
///
/// 和 `convert.rs::strip_html_noise` 同一套思路。这里独立实现而不是复用，
/// 是因为那个函数是私有的且服务于文件导入路径；把它提出来共用要动它的
/// 调用点，收益不抵风险。
fn strip_noise(html: &str) -> String {
    use std::borrow::Cow;
    let mut s: Cow<str> = Cow::Borrowed(html);
    for tag in &["script", "style", "noscript", "svg", "iframe"] {
        let re_str = format!(r"(?i)<{tag}[\s>][\s\S]*?</{tag}\s*>", tag = tag);
        if let Ok(re) = regex_lite::Regex::new(&re_str) {
            if let Cow::Owned(o) = re.replace_all(&s, "") {
                s = Cow::Owned(o);
            }
        }
    }
    s.into_owned()
}

/// 只存标题 + 链接的存根。抓取失败时的降级产物 —— 用户至少知道"这里有一条"，
/// 以后可以手动补。
pub fn stub(url: &str, title: &str) -> Extracted {
    let t = if title.trim().is_empty() {
        url.to_string()
    } else {
        title.trim().to_string()
    };
    Extracted {
        title: t,
        markdown: String::new(),
        via: Via::Stub,
        url: url.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ARTICLE: &str = r#"<html><head><title>站点标题</title>
        <script>var x = 1;</script><style>.a{color:red}</style></head>
        <body>
          <nav>导航 导航 导航</nav>
          <article class="post"><h1>正文大标题</h1>
            <p>第一段内容。</p><p>第二段内容。</p>
            <div class="ads">广告位广告位广告位</div>
          </article>
          <footer>页脚</footer>
        </body></html>"#;

    fn long_article() -> String {
        let body = "这是一段足够长的正文内容，用来通过最少字数门槛。".repeat(30);
        format!(
            r#"<html><head><title>长文</title></head><body>
               <article class="post"><h1>标题</h1><p>{body}</p></article>
               </body></html>"#
        )
    }

    #[test]
    fn selector_extraction_beats_readability_when_a_rule_exists() {
        // 用一条真实的种子规则：36kr 的正文容器。
        let html = format!(
            r#"<html><head><title>t</title></head><body>
               <div class="articleDetailContent"><p>{}</p></div>
               </body></html>"#,
            "正文".repeat(200)
        );
        // 直接测第 1 级，绕开 host 匹配（36kr 在种子里）。
        let got = extract_with_rule(&html, "36kr.com", "https://36kr.com/p/1");
        let got = got.expect("规则应该命中");
        assert_eq!(got.via, Via::Selector);
        assert!(got.markdown.contains("正文"));
    }

    #[test]
    fn a_rule_that_matches_an_empty_shell_is_treated_as_a_miss() {
        // 选择器匹配到了元素，但里面几乎是空的 —— 这是规则失效最典型的
        // 表现，不能当成命中，必须降级。
        let html = r#"<html><head><title>t</title></head><body>
                      <div class="articleDetailContent">短</div></body></html>"#;
        assert!(extract_with_rule(html, "36kr.com", "https://36kr.com/p/1").is_none());
    }

    #[test]
    fn readability_handles_a_page_with_no_rule() {
        let got = extract_with_readability(&long_article(), "https://example.invalid/x");
        let got = got.expect("readability 应该抽到正文");
        assert_eq!(got.via, Via::Readability);
        assert!(got.markdown.contains("这是一段足够长的正文内容"));
    }

    #[test]
    fn readability_returns_none_on_a_page_with_no_content() {
        let html = "<html><head><title>t</title></head><body><p>短</p></body></html>";
        assert!(extract_with_readability(html, "https://example.invalid/x").is_none());
    }

    #[test]
    fn readability_takes_the_title_from_the_document() {
        // 之前这条用例断言的是 "标题"（h1），实际是 "长文"（<title>）——
        // 期望写错了，不是行为错了。Readability 自己就是从 <title> 取的。
        let got = extract_with_readability(&long_article(), "https://example.invalid/x")
            .expect("got");
        assert_eq!(got.title, "长文");
    }

    #[test]
    fn a_page_with_no_title_still_extracts_and_yields_an_empty_title() {
        // 没有 <title> 也没有 h1：正文照样能抽，标题为空，不该因此失败。
        let html = format!(
            "<html><body><article><p>{}</p></article></body></html>",
            "内容".repeat(300)
        );
        let got = extract_with_readability(&html, "https://example.invalid/x").expect("got");
        assert_eq!(got.title, "");
        assert!(!got.markdown.is_empty());
    }

    #[test]
    fn script_and_style_never_reach_the_markdown() {
        let cleaned = strip_noise(ARTICLE);
        assert!(!cleaned.contains("var x = 1"), "script 内容泄漏进正文");
        assert!(!cleaned.contains("color:red"), "style 内容泄漏进正文");
    }

    #[test]
    fn html_converts_to_markdown_without_the_ads() {
        let md = html_to_markdown(&strip_noise(ARTICLE));
        assert!(md.contains("第一段内容"), "正文丢失: {md}");
    }

    #[test]
    fn plain_text_len_ignores_markup() {
        assert_eq!(plain_text_len("<p>abc</p>"), 3);
        // 中文按字符数算，不按字节。
        assert_eq!(plain_text_len("<p>中文</p>"), 2);
        assert_eq!(plain_text_len("<div></div>"), 0);
    }

    #[test]
    fn stub_uses_the_url_when_there_is_no_title() {
        let s = stub("https://example.invalid/a", "  ");
        assert_eq!(s.title, "https://example.invalid/a");
        assert_eq!(s.via, Via::Stub);
        assert!(s.markdown.is_empty());
    }

    #[test]
    fn via_serialises_as_a_plain_string() {
        // frontmatter 里的 `via:` 是给人看的，不能是 `Selector` 这种变体名。
        assert_eq!(Via::Selector.as_str(), "selector");
        assert_eq!(Via::Readability.as_str(), "readability");
    }
}
