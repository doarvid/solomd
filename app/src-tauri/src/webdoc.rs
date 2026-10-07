//! 网页正文抽取 —— 抽取流水线的前三级（第 1~3 级）。
//!
//! 1. **站点规则**（`extract_rules`）：按域名查 CSS 选择器，命中即用。
//!    292 条种子来自简悦，长尾站点由 AI 学习补充（第 3 级，尚未实现）。
//! 2. **SSR 数据块**（`extract_from_data_island`）：Next.js 这类站点的正文
//!    根本不在静态 DOM 里，而在 `<script type="application/json">` 里。
//! 3. **Readability**（`dom_smoothie`）：离线、无 JS，对文章类页面命中率足够。
//! 4. **AI**：兜底，见 spec 的 P5。
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
    /// 从页面的 SSR 数据块里读的（正文根本不在这份 HTML 的 DOM 里）。
    Json,
    /// Readability 抽的。
    Readability,
    /// GitHub 仓库：直接读的 README，没有做正文抽取。
    Readme,
    /// 用户在浏览器里手动选中的。
    Selection,
    /// 只存了标题和链接，没有正文。
    Stub,
}

impl Via {
    pub fn as_str(self) -> &'static str {
        match self {
            Via::Selector => "selector",
            Via::Json => "json",
            Via::Readability => "readability",
            Via::Readme => "readme",
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
    /// 页面自己声明的元信息（作者 / 发布日期 / 摘要）。抽不到就是默认值。
    #[serde(default)]
    pub meta: PageMeta,
}

/// 页面自身的元信息，采集时写进 frontmatter。
///
/// 全部来自 `<meta>`，不猜也不从正文里凑：正文里的"作者：xxx"是排版结果，
/// 抽错的概率远高于漏掉。**拿不到的字段就是 None** —— 写一个空字符串比
/// 缺字段更糟，用户在笔记里看到 `author: ""` 只会以为采集坏了。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMeta {
    /// 作者。`<meta name="author">` 允许出现多次，所以是个列表。
    pub authors: Vec<String>,
    /// 发布日期，归一成 `YYYY-MM-DD`。
    pub published: Option<String>,
    /// 摘要（`description`，退化用 `og:description`）。
    pub description: Option<String>,
    /// 标签，页面自己声明的（见 `TAG_LIST_KEYS` / `TAG_ONE_KEYS`）。
    pub tags: Vec<String>,
}

/// 标签类 meta：值是**一整串逗号分隔的关键词**。
const TAG_LIST_KEYS: [&str; 5] = [
    "keywords",
    "news_keywords",
    "citation_keywords",
    // 新闻站的两种常见投放系统，值是同样的逗号列表。
    "sailthru.tags",
    "parsely-tags",
];

/// 标签类 meta：**一条一个标签**，可以重复出现。
const TAG_ONE_KEYS: [&str; 2] = ["article:tag", "og:article:tag"];

/// 一个页面最多取这么多标签。关键词列表偶尔是被 SEO 工具灌满的
/// （几十上百个词），那种列表写进 frontmatter 只会把笔记头撑爆。
const MAX_TAGS: usize = 20;

fn meta_attr(node: &scraper::ElementRef, name: &str) -> Option<String> {
    node.value().attr(name).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// 从 `<head>` 的 meta 标签读作者 / 发布日期 / 摘要。
///
/// 认的键名是 OpenGraph、Article 和常见的几种老式写法。**大小写不敏感** ——
/// `<meta NAME="Author">` 是合法的 HTML，`scraper` 把属性名小写化，但
/// `property` 的值不会，所以这里统一小写后再比。
pub fn extract_meta(html: &str) -> PageMeta {
    let doc = scraper::Html::parse_document(html);
    let Ok(sel) = scraper::Selector::parse("meta") else {
        return PageMeta::default();
    };

    let mut meta = PageMeta::default();
    let mut og_description: Option<String> = None;
    let mut og_author: Option<String> = None;

    for node in doc.select(&sel) {
        let Some(key) = meta_attr(&node, "name")
            .or_else(|| meta_attr(&node, "property"))
            .or_else(|| meta_attr(&node, "itemprop"))
        else {
            continue;
        };
        let Some(content) = meta_attr(&node, "content") else {
            continue;
        };
        match key.to_ascii_lowercase().as_str() {
            // twitter:creator 是 `@handle` 形式，前面的 `@` 是平台语法不是名字。
            "author" | "article:author" | "twitter:creator" => {
                let name = content.trim_start_matches('@').trim();
                // `og:article:author` 在 Facebook 生态里放的是主页 URL，
                // 当成作者名写进 frontmatter 会得到一个 url 当人名。
                if !name.is_empty() && !name.starts_with("http") && !meta.authors.iter().any(|a| a == name) {
                    meta.authors.push(name.to_string());
                }
            }
            "og:article:author" => {
                if !content.starts_with("http") && og_author.is_none() {
                    og_author = Some(content);
                }
            }
            "article:published_time" | "og:article:published_time" | "datepublished" | "pubdate"
            | "publishdate" => {
                if meta.published.is_none() {
                    meta.published = Some(normalize_date(&content));
                }
            }
            "description" => {
                if meta.description.is_none() {
                    meta.description = Some(content);
                }
            }
            "og:description" | "twitter:description" => {
                if og_description.is_none() {
                    og_description = Some(content);
                }
            }
            key if TAG_LIST_KEYS.contains(&key) => {
                // 中英文逗号都可能出现，分号也有站点用。
                for t in content.split(['，', ',', '；', ';']) {
                    push_tag(&mut meta.tags, t);
                }
            }
            key if TAG_ONE_KEYS.contains(&key) => push_tag(&mut meta.tags, &content),
            _ => {}
        }
    }

    if meta.authors.is_empty() {
        if let Some(a) = og_author {
            meta.authors.push(a);
        }
    }
    if meta.description.is_none() {
        meta.description = og_description;
    }
    meta
}

/// 收一个标签：去空白、去空串、去重，到上限就不收了。
fn push_tag(tags: &mut Vec<String>, raw: &str) {
    if tags.len() >= MAX_TAGS {
        return;
    }
    let t = raw.trim();
    if t.is_empty() || tags.iter().any(|x| x == t) {
        return;
    }
    tags.push(t.to_string());
}

/// `2024-01-30T23:05:08+08:00` → `2024-01-30`。
///
/// 只认 ISO 形的开头。认不出来就**原样留着** —— frontmatter 里放一个不认识
/// 的日期串，总比丢掉这条信息好。
fn normalize_date(s: &str) -> String {
    let s = s.trim();
    let b = s.as_bytes();
    let iso = b.len() >= 10
        && b[..4].iter().all(|c| c.is_ascii_digit())
        && b[4] == b'-'
        && b[5..7].iter().all(|c| c.is_ascii_digit())
        && b[7] == b'-'
        && b[8..10].iter().all(|c| c.is_ascii_digit());
    if iso {
        // 上面逐段校验过全是 ASCII 数字和 `-`，所以 10 一定是字符边界。
        s[..10].to_string()
    } else {
        s.to_string()
    }
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
        // 由 `extract()` 统一补上 —— 两条抽取路径共用一次解析。
        meta: PageMeta::default(),
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
        meta: PageMeta::default(),
    })
}

/// 抽正文。前一级不够就降级，两级都不行返回 None（调用方转存根）。
///
/// 命中与否会喂回规则库的计数 —— 这是种子规则能自我淘汰的唯一途径。
pub fn extract(html: &str, url: &str, host: &str) -> Option<Extracted> {
    // 元信息和正文走两条独立的路：正文抽不到（readability 失败、正文太短）
    // 时元信息往往还在，那种页面正需要 frontmatter 里的标题和日期来辨认。
    let meta = extract_meta(html);

    let mut out = if let Some(e) = extract_with_rule(html, host, url) {
        extract_rules::record_hit(host);
        e
    } else {
        if has_rule(host) {
            // 有规则但没抽到东西 —— 规则失效了，记一笔。攒够就 stale，之后
            // 该域名直接跳过第 1 级。
            extract_rules::record_miss(host);
        }
        // 数据块**排在 readability 前面**：这类页面的 DOM 是个壳，静态
        // HTML 里只有面包屑、作者和发布时间，readability 在上面会一本正经
        // 地抽出这堆页头 —— 而且往往超过 MIN_CONTENT_CHARS，于是正文彻底
        // 丢了还看不出来。数据块里有全文，先拿它。
        extract_from_data_island(html, url)
            .or_else(|| extract_with_readability(html, url))?
    };
    out.meta = meta;
    Some(out)
}

/// 数据块里的"正文"候选下限（字符数）。
///
/// 比 `MIN_CONTENT_CHARS` 高一截：数据块里还躺着摘要、推荐语、SEO 描述
/// 这些几百字的字段，正文跟它们不是一个量级。
const MIN_ISLAND_CHARS: usize = 500;

/// 第 2 级：从 SSR 数据块里读正文。
///
/// Next.js（以及抄了这套的站点，如腾讯云开发者社区）把整页数据塞进
/// `<script type="application/json">`，DOM 交给 JS 渲染。采集走的是
/// reqwest，不执行 JS，所以静态 HTML 里没有正文 —— 但数据块里有，而且
/// 往往比渲染结果还干净（腾讯云那边直接给的就是 markdown，9446 字）。
///
/// 标题优先用 `<h1>` 而不是 `<title>`：标题标签通常挂着站点后缀
/// （"…-腾讯云开发者社区-腾讯云"），而它要拿去做文件名。
fn extract_from_data_island(html: &str, url: &str) -> Option<Extracted> {
    let doc = scraper::Html::parse_document(html);
    let sel = scraper::Selector::parse(r#"script[type="application/json"]"#).ok()?;

    let mut best: Option<String> = None;
    for node in doc.select(&sel) {
        let raw = node.text().collect::<String>();
        // 数据块不一定是合法 JSON（有的站点塞的是别的东西），跳过就好。
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        longest_article_string(&value, &mut best);
    }

    let winner = best?;
    let title = first_h1(&doc).unwrap_or_else(|| document_title(&doc));
    let markdown = if winner.contains("<p") || winner.contains("<div") {
        html_to_markdown(&winner)
    } else {
        // 已经是 markdown 就别再过一遍 HTML 转换 —— 那会吃掉 `#`、`-`、`*`
        // 这些本来就有意义的字符。
        winner
    };

    Some(Extracted {
        title,
        markdown,
        via: Via::Json,
        url: url.to_string(),
        meta: PageMeta::default(),
    })
}

/// 递归找数据块里**最长的**那个像正文的字符串。
///
/// 取最长而不是按 key 名匹配（`content` / `articleContent` / `body`…）：
/// key 名每个站点都不一样，而"正文是这坨 JSON 里最长的那段结构化文本"是
/// 通用的 —— 推荐阅读、评论、SEO 描述都比它短。
///
/// ponytail: 启发式，天花板是"一页里塞了多篇全文"（列表页）时会取到最长
/// 的那篇而不是当前这篇。真遇到再加"先按当前 URL / articleId 定位"。
fn longest_article_string(value: &serde_json::Value, best: &mut Option<String>) {
    match value {
        serde_json::Value::String(s) => {
            if looks_like_article(s) && best.as_ref().is_none_or(|b| s.len() > b.len()) {
                *best = Some(s.clone());
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                longest_article_string(item, best);
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values() {
                longest_article_string(item, best);
            }
        }
        _ => {}
    }
}

/// 数据块里"像正文"的判据。
///
/// **这是启发式，宁可漏也不要错**：漏了只是退回 readability（不会更差），
/// 抓错一坨 JSON 当正文，用户看到的是满屏乱码。
///
/// 判据是"块级结构 + 分段"：正文由标题/段落堆出来，而 base64、压缩过的
/// JS、整个 JSON 的字符串化都是**一坨没有分段的长字符串**。
fn looks_like_article(s: &str) -> bool {
    if s.trim().chars().count() < MIN_ISLAND_CHARS {
        return false;
    }
    let md_headings = s.lines().filter(|l| l.trim_start().starts_with('#')).count();
    let html_blocks = s.matches("<p").count() + s.matches("<div").count() + s.matches("<h").count();
    let blank_lines = s.matches("\n\n").count();
    (md_headings + html_blocks) >= 3 && (blank_lines >= 3 || html_blocks >= 10)
}

/// 页面里第一个 `<h1>` 的文本。
fn first_h1(doc: &scraper::Html) -> Option<String> {
    let sel = scraper::Selector::parse("h1").ok()?;
    let t = doc
        .select(&sel)
        .next()?
        .text()
        .collect::<String>()
        .trim()
        .to_string();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
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
        meta: PageMeta::default(),
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

    /// 真实站点的 meta 片段（bingal.com 的一篇文章），字段名和大小写
    /// 都照抄 —— 这批字段就是要能被这样的页面填满。
    const META_HEAD: &str = r#"<html><head>
        <meta property="og:title" content="CodeLlama-7b-Instruct 只需一个 ”exe“ 文件" />
        <meta name="author" content="Bingal" />
        <meta name="description" content="本方案采用 llamafile 的格式。" />
        <meta property="og:description" content="og 的摘要" />
        <meta property="og:url" content="https://www.bingal.com/posts/codellama-7b-instruct-llamafile-usage/" />
        <meta property="article:published_time" content="2024-01-30T23:05:08+08:00" />
        </head><body><p>正文</p></body></html>"#;

    #[test]
    fn extract_meta_reads_the_usual_head_tags() {
        let m = extract_meta(META_HEAD);
        assert_eq!(m.authors, vec!["Bingal".to_string()]);
        // 完整时间戳只留日期部分 —— frontmatter 里 `published` 是给人看的。
        assert_eq!(m.published.as_deref(), Some("2024-01-30"));
        assert_eq!(m.description.as_deref(), Some("本方案采用 llamafile 的格式。"));
    }

    #[test]
    fn extract_meta_falls_back_to_og_description() {
        let html = r#"<html><head><meta property="og:description" content="og 的摘要" /></head></html>"#;
        assert_eq!(extract_meta(html).description.as_deref(), Some("og 的摘要"));
    }

    #[test]
    fn extract_meta_keeps_several_authors_and_drops_the_at_sign() {
        let html = r#"<html><head>
            <meta name="author" content="Bingal" />
            <meta name="twitter:creator" content="@someone" />
            <meta name="author" content="Bingal" />
            </head></html>"#;
        // 去重，且 `@handle` 里的 `@` 是平台语法不是名字的一部分。
        assert_eq!(extract_meta(html).authors, vec!["Bingal".to_string(), "someone".to_string()]);
    }

    #[test]
    fn extract_meta_ignores_an_author_url() {
        // Facebook 生态的 og:article:author 放的是主页 URL；当成作者名写进
        // frontmatter 会得到一个 URL 当人名。
        let html = r#"<html><head>
            <meta property="og:article:author" content="https://www.facebook.com/someone" />
            </head></html>"#;
        assert!(extract_meta(html).authors.is_empty());
    }

    #[test]
    fn extract_meta_reads_tags_from_the_keyword_keys() {
        // 腾讯云那页的 keywords 就是中文逗号分隔的一串。
        let html = r#"<html><head>
            <meta name="keywords" content="AIAgent框架,多渠道接入，本地部署" />
            </head></html>"#;
        assert_eq!(
            extract_meta(html).tags,
            vec!["AIAgent框架".to_string(), "多渠道接入".to_string(), "本地部署".to_string()]
        );
    }

    #[test]
    fn extract_meta_accepts_one_tag_per_meta_and_dedupes() {
        let html = r#"<html><head>
            <meta property="article:tag" content="Rust" />
            <meta property="article:tag" content="笔记" />
            <meta name="keywords" content="Rust, 笔记" />
            </head></html>"#;
        // 两个来源重了就去重，顺序按出现次序。
        assert_eq!(extract_meta(html).tags, vec!["Rust".to_string(), "笔记".to_string()]);
    }

    #[test]
    fn extract_meta_tags_are_capped() {
        // SEO 工具能把 keywords 灌到几十上百个，写进 frontmatter 只会把
        // 笔记头撑爆。
        let many = (0..50).map(|i| format!("tag{i}")).collect::<Vec<_>>().join(",");
        let html = format!(r#"<html><head><meta name="keywords" content="{many}" /></head></html>"#);
        assert_eq!(extract_meta(&html).tags.len(), 20);
    }

    #[test]
    fn extract_meta_on_a_page_without_any_is_empty_not_guessed() {
        // 拿不到就不写 —— 从正文里猜"作者：xxx"抽错的概率远高于漏掉。
        let m = extract_meta("<html><head><title>只有标题</title></head><body>x</body></html>");
        assert_eq!(m, PageMeta::default());
    }

    #[test]
    fn extract_meta_keeps_an_unrecognised_date_verbatim() {
        let html = r#"<html><head><meta property="article:published_time" content="2024年1月30日" /></head></html>"#;
        assert_eq!(extract_meta(html).published.as_deref(), Some("2024年1月30日"));
    }

    /// 正文样本：带 markdown 结构，也带 `&` 和 `<` —— 拿它顺便验证"已经是
    /// markdown 就不再过一遍 HTML 转换"（那样会把 `&` 变成 `&amp;`）。
    fn island_article() -> String {
        let mut s = String::from("## 摘要\n\n本文对比 AT&T 与 a < b 两种写法。\n\n- 要点一\n- 要点二\n\n");
        for i in 0..40 {
            s.push_str(&format!("## 第 {i} 节\n\n这一节讲的是选型时的取舍，够长才有意义。\n\n"));
        }
        s
    }

    /// 一个"DOM 是壳、正文在 `__NEXT_DATA__` 里"的页面 —— 腾讯云开发者
    /// 社区就是这个形状：静态 HTML 只有面包屑/作者/发布时间，正文靠 JS 灌。
    fn json_island_page(extra_json: &str) -> String {
        let payload = format!(
            r#"{{"props":{{"pageProps":{{"fallback":{{"/api/article/detail":{{"articleInfo":{{"summary":"短摘要","content":{},"extra":{}}}}}}}}}}}}}"#,
            serde_json::to_string(&island_article()).unwrap(),
            extra_json
        );
        format!(
            r#"<html><head><title>干净的标题-站点后缀-腾讯云</title></head><body>
               <div class="mod-article-content"><h1 class="title-text">干净的标题</h1>
                 <span class="author">七夜zippoe</span><span>发布 于 2026-05-01 17:04:49</span></div>
               <script id="__NEXT_DATA__" type="application/json">{payload}</script>
               </body></html>"#
        )
    }

    #[test]
    fn a_data_island_supplies_the_body_when_the_dom_is_only_a_shell() {
        let e = extract(&json_island_page("null"), "https://cloud.tencent.cn/developer/article/1", "cloud.tencent.cn")
            .expect("数据块里有全文，应该抽到");
        assert_eq!(e.via, Via::Json);
        assert_eq!(e.markdown, island_article(), "markdown 正文被二次转换了");
        // 标题取 `<h1>` 而不是挂着站点后缀的 `<title>` —— 它要拿去做文件名。
        assert_eq!(e.title, "干净的标题");
    }

    #[test]
    fn a_data_island_body_that_is_html_gets_converted() {
        let body: String = "<p>第一段内容。</p><p>第二段内容。</p><h2>小标题</h2>".repeat(20);
        let payload = format!(
            r#"{{"props":{{"pageProps":{{"articleInfo":{{"content":{}}}}}}}}}"#,
            serde_json::to_string(&body).unwrap()
        );
        let html = format!(
            r#"<html><head><title>标题</title></head><body><h1>标题</h1>
               <script type="application/json">{payload}</script></body></html>"#
        );
        let e = extract(&html, "https://x.example/a", "x.example").expect("应该抽到");
        assert_eq!(e.via, Via::Json);
        assert!(e.markdown.contains("第一段内容。"), "HTML 没被转成 markdown");
        assert!(!e.markdown.contains("<p>"), "HTML 标签漏进了正文");
    }

    #[test]
    fn a_data_island_without_article_like_text_falls_through_to_readability() {
        // 5000 个 `A` 是"一坨没有分段的长字符串"—— base64、压缩过的 JS、
        // 整个 JSON 的字符串化都长这样。抓错它会得到满屏乱码。
        let blob = "A".repeat(5000);
        let long_body = "这是一段足够长的正文内容，用来通过最少字数门槛。".repeat(30);
        let payload = format!(r#"{{"props":{{"payload":{}}}}}"#, serde_json::to_string(&blob).unwrap());
        let html = format!(
            r#"<html><head><title>标题</title></head><body>
               <article class="post"><h1>标题</h1><p>{long_body}</p></article>
               <script type="application/json">{payload}</script></body></html>"#
        );
        let e = extract(&html, "https://x.example/a", "x.example").expect("readability 应该兜住");
        assert_eq!(e.via, Via::Readability, "把非正文的数据块当成正文了");
    }

    #[test]
    fn a_short_structured_island_field_is_not_mistaken_for_the_body() {
        // 摘要字段也是"有结构的 markdown"，但它远短于正文，该让给 readability。
        let summary = "## 摘要\n\n短短一段。\n\n- 一\n- 二\n";
        let long_body = "这是一段足够长的正文内容，用来通过最少字数门槛。".repeat(30);
        let payload = format!(
            r#"{{"props":{{"articleInfo":{{"summary":{}}}}}}}"#,
            serde_json::to_string(summary).unwrap()
        );
        let html = format!(
            r#"<html><head><title>标题</title></head><body>
               <article class="post"><h1>标题</h1><p>{long_body}</p></article>
               <script type="application/json">{payload}</script></body></html>"#
        );
        let e = extract(&html, "https://x.example/a", "x.example").expect("应该抽到");
        assert_eq!(e.via, Via::Readability, "把摘要当成正文了");
    }

    #[test]
    fn a_broken_json_island_is_skipped_not_fatal() {
        // 有的站点往 `type="application/json"` 里塞的是别的东西。
        let long_body = "这是一段足够长的正文内容，用来通过最少字数门槛。".repeat(30);
        let html = format!(
            r#"<html><head><title>标题</title></head><body>
               <article class="post"><h1>标题</h1><p>{long_body}</p></article>
               <script type="application/json">{{ not json at all </script></body></html>"#
        );
        let e = extract(&html, "https://x.example/a", "x.example").expect("readability 应该兜住");
        assert_eq!(e.via, Via::Readability);
    }

    #[test]
    fn extract_attaches_the_meta_to_whatever_path_won() {
        // 元信息由 extract() 统一补上，两条抽取路径都不该漏掉它。
        let html = format!(
            r#"<html><head><title>站点标题</title>
            <meta name="author" content="Bingal" />
            <meta property="article:published_time" content="2024-01-30T23:05:08+08:00" /></head>
            <body><article class="post"><h1>标题</h1><p>{}</p></article></body></html>"#,
            "这是一段足够长的正文内容，用来通过最少字数门槛。".repeat(30)
        );
        let e = extract(&html, "https://x.example/a", "x.example").expect("应该抽到");
        assert_eq!(e.meta.authors, vec!["Bingal".to_string()]);
        assert_eq!(e.meta.published.as_deref(), Some("2024-01-30"));
    }
}


