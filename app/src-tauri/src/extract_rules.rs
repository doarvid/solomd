//! 站点抽取规则库。
//!
//! 抽取流水线的第 1 级：按域名查一条 CSS 选择器规则，命中就用它，
//! 命不中再去 SSR 数据块 / readability / AI 兜底（见 `webdoc.rs`）。
//!
//! # 规则的来源有三个
//!
//! - **seed** —— 292 条，由 `scripts/convert-simpread-rules.py` 从简悦
//!   （SimpRead）的 `website_list.json` 转换而来，编译期内嵌。详见 spec。
//! - **ai** —— AI 抽取时顺带学到的，运行时写盘。
//! - **user** —— 用户在设置里手写的，优先级最高。
//!
//! # 为什么要有失效机制
//!
//! 种子规则来自 2023 年的列表，站点改版后选择器会失效。失效的表现是
//! 「选择器匹配到了元素，但抽出来的东西是垃圾」或「什么都没匹配到」——
//! 两者都不能简单当成失败，因为一个正常页面也可能恰好很短。
//!
//! 所以判定分两步：匹配到 **且** 文本 > 300 字才算命中。持续未命中到
//! 一定次数就把规则标记为 stale，下次该域名直接跳过第 1 级。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

/// 少于这个字数就不算"抽到了正文"。
pub const MIN_CONTENT_CHARS: usize = 300;

/// 种子规则，编译期内嵌 —— 不需要运行时找资源文件，也不会被用户误删。
const SEED_JSON: &str = include_str!("../resources/seed-extract-rules.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleSource {
    Seed,
    Ai,
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    /// 正文容器的 CSS 选择器。
    pub content: String,
    /// 标题的 CSS 选择器。缺省则退回 `<title>` / `h1`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// 要剔除的选择器（导航、广告、相关推荐…）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remove: Vec<String>,
    pub source: RuleSource,
    /// 命中/未命中计数。种子规则初始为 0。
    #[serde(default)]
    pub hits: u32,
    #[serde(default)]
    pub misses: u32,
    #[serde(default)]
    pub updated_at: i64,
}

impl Rule {
    pub fn is_stale(&self) -> bool {
        // 种子规则没被用过之前不算过期 —— 否则一个从没命中过、也从来没被
        // 试过的规则会因为 misses 累积而被误判。misses >= 3 的前提就是
        // 它至少被试过三次。
        self.misses >= 3 && self.misses > self.hits
    }
}

#[derive(Debug, Deserialize)]
struct SeedDoc {
    rules: HashMap<String, Rule>,
}

/// 落盘的、**用户和 AI 学到的**规则。种子不在这个文件里 —— 它们跟着
/// 二进制走，每次启动重新展开，这样修正种子只需要改 resources 里的 JSON
/// 并重新发版，不用管用户机器上的状态。
#[derive(Debug, Default, Serialize, Deserialize)]
struct LearnedDoc {
    version: u32,
    rules: HashMap<String, Rule>,
}

static STATE: Lazy<Mutex<LearnedDoc>> = Lazy::new(|| Mutex::new(LearnedDoc::default()));
static SEED: Lazy<HashMap<String, Rule>> = Lazy::new(|| {
    // Keys are canonicalised at load so that every later comparison happens in
    // one form -- the source list has `article.huanqiu.com/` and `36kr.com`
    // mixed together, and a raw-key store would make lookup() miss whatever
    // domain_for() had just returned.
    serde_json::from_str::<SeedDoc>(SEED_JSON)
        .map(|d| {
            d.rules
                .into_iter()
                .map(|(k, v)| (canonical(&k), v))
                .collect()
        })
        .unwrap_or_default()
});

static RULES_PATH: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 唯一的域名规范化函数 —— 读、写、匹配三处必须用同一个，否则会出现
/// 「写得进去、查不出来」的不一致。
///
/// 做三件事：
/// - 小写 + 去首尾空白
/// - 去掉尾斜杠：源列表里有 `article.huanqiu.com/` 这种写法
/// - 去掉开头的 `www.`：种子的键不带 www（`36kr.com` 而不是
///   `www.36kr.com`），学习时也要对齐，否则同一站点会分裂成两条规则
///
/// **不去掉其它子域** —— `s.pingwest.com` 和 `wire.pingwest.com` 在种子库
/// 里是不同的条目，压平会把它们的规则搞混。
fn canonical(s: &str) -> String {
    let s = s.trim().trim_end_matches('/').to_ascii_lowercase();
    s.strip_prefix("www.").unwrap_or(&s).to_string()
}

/// 给定 URL 的 host，找出应该用哪条规则。
///
/// 匹配用**后缀**：规则 `36kr.com` 要能命中 `www.36kr.com`。从最具体的
/// 候选开始试（`article.huanqiu.com` 优先于 `huanqiu.com`），否则一个
/// 宽泛的父域规则会盖掉更准的子域规则。
pub fn domain_for(url_host: &str) -> Option<String> {
    let host = canonical(url_host);
    if host.is_empty() {
        return None;
    }

    let mut best: Option<String> = None;
    for key in SEED.keys().chain(learned_keys().iter()) {
        let d = canonical(key);
        // 精确相等，或者是 `.` 分隔的子域。
        let hit = host == d || host.ends_with(&format!(".{d}"));
        if hit {
            match &best {
                Some(b) if canonical(b).len() >= d.len() => {}
                _ => best = Some(key.clone()),
            }
        }
    }
    best
}

fn learned_keys() -> Vec<String> {
    STATE
        .lock()
        .map(|s| s.rules.keys().cloned().collect())
        .unwrap_or_default()
}

/// 写入路径用的键：不做规则匹配，直接从 host 推。
///
/// 和 `domain_for` 的区别很关键 —— `domain_for` 只在**已收录**的域名里
/// 找，因为它的用途是"这个站点有没有现成规则"。而写规则是反过来的：
/// 正因为还没有规则才要写。早期版本让 `upsert` 也走 `domain_for`，结果
/// 长尾站点（AI 学到规则的主要对象）永远存不进去。
#[allow(dead_code)] // used by upsert (P5) and the tests
fn host_key(host: &str) -> String {
    canonical(host)
}

/// 查规则。用户/AI 学到的优先于种子；stale 的一律不返回（相当于没有
/// 规则，让调用方走 readability 兜底）。
///
/// 种子的 hits/misses 不需要单独处理：第一次 `record_hit`/`record_miss`
/// 就会把种子复制一份进 learned，之后 learned 自然遮蔽种子，计数和失效
/// 判定都在那一份上累积。
pub fn lookup(host: &str) -> Option<Rule> {
    let domain = domain_for(host)?;

    if let Ok(state) = STATE.lock() {
        if let Some(r) = state.rules.get(&domain) {
            return if r.is_stale() { None } else { Some(r.clone()) };
        }
    }

    let seed = SEED.get(&domain)?;
    if seed.is_stale() {
        return None;
    }
    Some(seed.clone())
}

/// 取现有规则用于累计计数；没有就在 learned 里种一份种子的副本。
fn entry_for(state: &mut LearnedDoc, domain: &str) -> Rule {
    if let Some(existing) = state.rules.get(domain) {
        return existing.clone();
    }
    SEED.get(domain).cloned().unwrap_or(Rule {
        content: String::new(),
        title: None,
        remove: Vec::new(),
        source: RuleSource::Seed,
        hits: 0,
        misses: 0,
        updated_at: 0,
    })
}

fn persist(state: &LearnedDoc) {
    let Ok(path_guard) = RULES_PATH.lock() else {
        return;
    };
    let Some(path) = path_guard.as_ref() else {
        return;
    };
    let Ok(json) = serde_json::to_string_pretty(state) else {
        return;
    };
    // 临时文件 + rename：写一半崩了也不会留下半个 JSON 把规则库废掉。
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// 首次使用时由 lib.rs 调用。`path` 是规则文件的落盘位置（app data dir）。
pub fn init(path: PathBuf) {
    if let Ok(mut guard) = RULES_PATH.lock() {
        *guard = Some(path.clone());
    }
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(doc) = serde_json::from_str::<LearnedDoc>(&text) {
            let normalised = LearnedDoc {
                version: doc.version,
                rules: doc
                    .rules
                    .into_iter()
                    .map(|(k, v)| (canonical(&k), v))
                    .collect(),
            };
            if let Ok(mut state) = STATE.lock() {
                *state = normalised;
            }
        }
    }
}

/// 记录一次成功命中，并返回该规则的当前计数（供调用方判断是否值得
/// 继续用）。种子规则第一次被记到时会在 learned 里种一份副本，之后计数
/// 都累积在那一份上。
pub fn record_hit(host: &str) {
    mutate_rule(host, |r| {
        r.hits = r.hits.saturating_add(1);
    });
}

/// 记录一次未命中。
///
/// **hits 减半**是失效判定的关键 —— 早期版本用 `misses > hits`，但 hits
/// 单调递增，攒了 12 次命中后要连续 13 次失败才会失效，等于永不失效。
pub fn record_miss(host: &str) {
    mutate_rule(host, |r| {
        r.misses = r.misses.saturating_add(1);
        r.hits /= 2;
    });
}

fn mutate_rule(host: &str, f: impl FnOnce(&mut Rule)) {
    // 只对**已有规则**计数。给一个从没匹配过规则的域名记 misses 没有意义，
    // 而且会给每个抓取失败的陌生域名凭空建一条空规则。
    let Some(domain) = domain_for(host) else {
        return;
    };
    let Ok(mut state) = STATE.lock() else { return };
    let mut rule = entry_for(&mut state, &domain);
    f(&mut rule);
    rule.updated_at = now_secs();
    state.rules.insert(domain, rule);
    let snapshot = LearnedDoc {
        version: 1,
        rules: state.rules.clone(),
    };
    drop(state);
    persist(&snapshot);
}

/// 写入一条规则（AI 抽取成功后调用，或用户在设置里手写）。
///
/// 键由 host 直接推出，**不经过 `domain_for`** —— 否则长尾站点（还没有
/// 规则、正要学）永远写不进去。用户规则不会被 AI 覆盖。
// P5 的入口：AI 抽取出选择器后写回规则库。现在没有调用方，但它是
// 学习闭环的另一半，和 lookup / record_* 配套。
#[allow(dead_code)]
pub fn upsert(host: &str, rule: Rule) {
    let domain = host_key(host);
    if domain.is_empty() {
        return;
    }
    let Ok(mut state) = STATE.lock() else { return };
    if let Some(existing) = state.rules.get(&domain) {
        if existing.source == RuleSource::User && rule.source != RuleSource::User {
            return;
        }
    }
    state.rules.insert(domain, rule);
    let snapshot = LearnedDoc {
        version: 1,
        rules: state.rules.clone(),
    };
    drop(state);
    persist(&snapshot);
}

/// 仅供测试：读回 learned 里某条规则。
#[cfg(test)]
fn peek(host: &str) -> Option<Rule> {
    let key = host_key(host);
    STATE.lock().ok()?.rules.get(&key).cloned()
}

/// 仅供测试：清掉运行时状态，让每个用例从干净的种子开始。
#[cfg(test)]
pub fn _reset_for_test() {
    if let Ok(mut s) = STATE.lock() {
        s.rules.clear();
    }
}

/// 用例之间共享全局 STATE，且 `_reset_for_test` 会把它整个清空 —— 并行
/// 跑的时候一个用例的重置会把另一个用例跑到一半的计数抹掉，表现为随机
/// 失败。所有碰 STATE 的用例先拿这把锁。
#[cfg(test)]
static TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
fn serial() -> std::sync::MutexGuard<'static, ()> {
    TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_rules_parsed() {
        // 292 条是转换产物的大小，掉下来说明 resources 里的 JSON 坏了。
        assert!(
            SEED.len() >= 290,
            "seed rules should be ~292, got {}",
            SEED.len()
        );
        assert!(SEED.contains_key("36kr.com"));
    }

    #[test]
    fn seed_rule_has_content_selector() {
        let r = SEED.get("36kr.com").expect("36kr seed rule");
        assert_eq!(r.content, "div.articleDetailContent");
        assert_eq!(r.title.as_deref(), Some("title"));
        assert!(!r.remove.is_empty());
    }

    #[test]
    fn wechat_is_covered() {
        // 微信公众号这条特别值钱 —— 那个站点否则基本抓不到。
        let r = SEED.get("mp.weixin.qq.com").expect("wechat seed rule");
        assert_eq!(r.content, "div#js_content");
    }

    #[test]
    fn domain_matches_subdomain() {
        assert_eq!(domain_for("www.36kr.com").as_deref(), Some("36kr.com"));
        assert_eq!(domain_for("36kr.com").as_deref(), Some("36kr.com"));
    }

    #[test]
    fn more_specific_subdomain_wins() {
        // article.huanqiu.com 和 huanqiu.com 都在库里时，前者优先。
        let got = domain_for("article.huanqiu.com");
        assert_eq!(got.as_deref(), Some("article.huanqiu.com"));
    }

    #[test]
    fn unrelated_host_matches_nothing() {
        assert!(domain_for("example.invalid").is_none());
        assert!(lookup("example.invalid").is_none());
    }

    #[test]
    fn does_not_match_a_suffix_that_is_not_a_domain_label() {
        // not36kr.com 不应该命中 36kr.com —— 后缀匹配必须按 `.` 边界切。
        assert!(domain_for("not36kr.com").is_none());
    }

    #[test]
    fn trailing_slash_in_rule_key_is_tolerated() {
        // 源列表里出现过 `article.huanqiu.com/` 这种带尾斜杠的键。
        assert!(domain_for("article.huanqiu.com").is_some());
    }

    #[test]
    fn staleness_needs_three_misses() {
        let mut r = Rule {
            content: "div".into(),
            title: None,
            remove: vec![],
            source: RuleSource::Seed,
            hits: 0,
            misses: 2,
            updated_at: 0,
        };
        assert!(!r.is_stale(), "两次未命中还不该判失效");
        r.misses = 3;
        assert!(r.is_stale());
    }

    #[test]
    fn staleness_survives_a_long_hit_history() {
        // 这是 hits 减半规则存在的理由。朴素写法 `misses > hits` 下，
        // 攒了 12 次命中的规则需要连续 13 次未命中才失效 —— 实际上等于
        // 永不失效，而那正是"站点改版了但规则还赖着"的场景。
        let mut r = Rule {
            content: "div".into(),
            title: None,
            remove: vec![],
            source: RuleSource::User,
            hits: 12,
            misses: 3,
            updated_at: 0,
        };
        assert!(!r.is_stale(), "12 次命中、3 次未命中，仍然有效");

        // 每次 record_miss 把 hits 减半：12 → 6 → 3 → 1
        r.hits /= 2; // 6
        r.misses = 4;
        assert!(!r.is_stale(), "4 > 6 还不成立");
        r.hits /= 2; // 3
        r.misses = 5;
        assert!(r.is_stale(), "5 > 3 成立 —— 三次未命中就够，不是十三次");
    }

    fn rule(content: &str, source: RuleSource) -> Rule {
        Rule {
            content: content.into(),
            title: None,
            remove: vec![],
            source,
            hits: 0,
            misses: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn a_long_tail_site_can_be_learned() {
        let _g = serial();
        // 这条是 upsert 走 host_key 而不是 domain_for 的理由：长尾站点
        // 本来就不在种子库里，用 domain_for 会直接返回 None，规则永远
        // 存不进去 —— 而学习长尾站点正是 AI 抽取层的全部意义。
        _reset_for_test();
        upsert("some-long-tail.example", rule(".body", RuleSource::Ai));
        assert_eq!(
            peek("some-long-tail.example").map(|r| r.content),
            Some(".body".into())
        );
    }

    #[test]
    fn www_prefix_is_stripped_so_a_site_does_not_split_in_two() {
        let _g = serial();
        _reset_for_test();
        upsert("www.example.com", rule(".a", RuleSource::Ai));
        assert!(peek("www.example.com").is_some());
        // 同一个键，不会因为带不带 www 而分裂成两条。
        assert!(STATE.lock().unwrap().rules.contains_key("example.com"));
    }

    #[test]
    fn ai_does_not_overwrite_a_user_rule() {
        let _g = serial();
        _reset_for_test();
        upsert("example.com", rule(".user", RuleSource::User));
        upsert("example.com", rule(".ai", RuleSource::Ai));
        assert_eq!(peek("example.com").map(|r| r.content), Some(".user".into()));
    }

    #[test]
    fn user_rule_does_overwrite_an_ai_rule() {
        let _g = serial();
        _reset_for_test();
        upsert("example.com", rule(".ai", RuleSource::Ai));
        upsert("example.com", rule(".user", RuleSource::User));
        assert_eq!(peek("example.com").map(|r| r.content), Some(".user".into()));
    }

    #[test]
    fn misses_halve_hits_and_eventually_stale_a_seed_rule() {
        let _g = serial();
        _reset_for_test();
        // 36kr 是种子规则，没有任何 learned 记录。
        for _ in 0..4 {
            record_hit("36kr.com");
        }
        assert_eq!(peek("36kr.com").map(|r| r.hits), Some(4));
        assert!(lookup("36kr.com").is_some());

        // 每次未命中把 hits 减半：4 → 2 → 1 → 0，而 misses 到 3。
        record_miss("36kr.com");
        record_miss("36kr.com");
        record_miss("36kr.com");
        let r = peek("36kr.com").expect("tracked rule");
        assert_eq!((r.hits, r.misses), (0, 3));
        assert!(r.is_stale());
        // stale 之后 lookup 不再返回它，调用方会走 readability 兜底。
        assert!(lookup("36kr.com").is_none(), "stale rule must not be used");
    }

    #[test]
    fn an_unknown_host_is_never_tracked() {
        let _g = serial();
        _reset_for_test();
        record_miss("never-seen.invalid");
        assert!(peek("never-seen.invalid").is_none(), "不该凭空建空规则");
    }

    #[test]
    fn concurrent_counting_loses_nothing() {
        let _g = serial();
        _reset_for_test();
        let handles: Vec<_> = (0..8)
            .map(|_| {
                std::thread::spawn(|| {
                    for _ in 0..50 {
                        record_hit("36kr.com");
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().expect("thread");
        }
        assert_eq!(
            peek("36kr.com").map(|r| r.hits),
            Some(400),
            "并发计数丢更新 —— 读改写没有串行化"
        );
    }
}
