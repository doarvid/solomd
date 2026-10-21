//! LanguageTool grammar / style / spell checking — opt-in, three backends.
//!
//! * **local**   — a LanguageTool HTTP server the user runs themselves
//!   (`languagetool-server.jar`, Docker, …), default `http://localhost:8081`.
//!   Nothing leaves the machine.
//! * **premium** — `https://api.languagetoolplus.com`, authenticated with the
//!   account e-mail (`username`, kept in settings) and an API key (kept in the
//!   OS keychain through `ai_keystore`, provider id `languagetool` — the key
//!   never reaches the WebView).
//! * **public**  — the free `https://api.languagetool.org`, rate limited by
//!   LanguageTool (20 requests / minute); we enforce that locally so the user
//!   sees a clean "slow down" instead of an IP ban.
//!
//! The frontend (`cm-languagetool.ts`) sends Markdown as LanguageTool
//! *AnnotatedText* (`data={"annotation":[{text},{markup,interpretAs}]}`):
//! markup is skipped by the checker but still counted in offsets, so the
//! returned `offset`/`length` index straight into the annotation the frontend
//! built. Offsets are UTF-16 code units (LanguageTool is Java), the same unit
//! CodeMirror uses, so unlike `spellcheck.rs` there is no byte conversion.
//!
//! Errors are returned as `lt:<code>[: detail]` strings so the frontend can
//! map them to translated messages: `lt:unreachable`, `lt:auth`,
//! `lt:no-credentials`, `lt:rate-limited`, `lt:too-large`, `lt:http`.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

pub const DEFAULT_LOCAL_URL: &str = "http://localhost:8081";
pub const PREMIUM_URL: &str = "https://api.languagetoolplus.com";
pub const PUBLIC_URL: &str = "https://api.languagetool.org";

/// `ai_keystore` provider id for the Premium API key.
const KEY_PROVIDER: &str = "languagetool";

/// Free public API: 20 requests per rolling minute (LanguageTool's limit).
const PUBLIC_MAX_PER_MINUTE: usize = 20;

// ---------------------------------------------------------------------------
// Wire types (frontend <-> Rust)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtConfig {
    /// `"local" | "premium" | "public"`.
    pub mode: String,
    /// Local server URL; ignored for premium / public.
    #[serde(default)]
    pub base_url: Option<String>,
    /// Premium account e-mail.
    #[serde(default)]
    pub username: Option<String>,
}

/// One AnnotatedText segment. Exactly one of `text` / `markup` is set.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub markup: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interpret_as: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRequest {
    pub config: LtConfig,
    pub annotation: Vec<Segment>,
    /// `"auto"` or a LanguageTool code such as `de-DE`.
    pub language: String,
    #[serde(default)]
    pub mother_tongue: Option<String>,
    /// Only meaningful with `language = "auto"`, e.g. `"en-GB,de-DE"`.
    #[serde(default)]
    pub preferred_variants: Option<String>,
    /// `"default" | "picky"`.
    #[serde(default)]
    pub level: Option<String>,
    #[serde(default)]
    pub disabled_rules: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LtMatch {
    pub offset: usize,
    pub length: usize,
    pub message: String,
    pub short_message: String,
    pub replacements: Vec<String>,
    pub rule_id: String,
    pub rule_description: String,
    pub category_id: String,
    /// LanguageTool `issueType`: misspelling, grammar, style, typographical,
    /// whitespace, uncategorized, …
    pub issue_type: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckResponse {
    pub matches: Vec<LtMatch>,
    /// Language LanguageTool actually used (relevant for `auto`).
    pub language: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LtLanguage {
    pub name: String,
    pub code: String,
    pub long_code: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LtStatus {
    pub ok: bool,
    pub languages: Vec<LtLanguage>,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// LanguageTool response shapes (only the fields we read)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RawResponse {
    #[serde(default)]
    matches: Vec<RawMatch>,
    #[serde(default)]
    language: Option<RawLanguage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawLanguage {
    #[serde(default)]
    code: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMatch {
    offset: usize,
    length: usize,
    #[serde(default)]
    message: String,
    #[serde(default)]
    short_message: String,
    #[serde(default)]
    replacements: Vec<RawReplacement>,
    rule: RawRule,
}

#[derive(Deserialize)]
struct RawReplacement {
    #[serde(default)]
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRule {
    #[serde(default)]
    id: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    issue_type: String,
    #[serde(default)]
    category: Option<RawCategory>,
}

#[derive(Deserialize)]
struct RawCategory {
    #[serde(default)]
    id: String,
}

/// Parse a `/v2/check` body into our flat match list (max 5 replacements,
/// like the Hunspell menu).
pub fn parse_check_response(body: &str) -> Result<CheckResponse, String> {
    let raw: RawResponse =
        serde_json::from_str(body).map_err(|e| format!("lt:http: invalid response: {e}"))?;
    let matches = raw
        .matches
        .into_iter()
        .map(|m| LtMatch {
            offset: m.offset,
            length: m.length,
            message: m.message,
            short_message: m.short_message,
            replacements: m
                .replacements
                .into_iter()
                .map(|r| r.value)
                .filter(|v| !v.is_empty())
                .take(5)
                .collect(),
            rule_id: m.rule.id,
            rule_description: m.rule.description,
            category_id: m.rule.category.map(|c| c.id).unwrap_or_default(),
            issue_type: if m.rule.issue_type.is_empty() {
                "uncategorized".into()
            } else {
                m.rule.issue_type
            },
        })
        .collect();
    Ok(CheckResponse {
        matches,
        language: raw.language.map(|l| l.code).unwrap_or_default(),
    })
}

// ---------------------------------------------------------------------------
// Endpoint resolution
// ---------------------------------------------------------------------------

/// Base URL (no trailing slash, no `/v2`) for a config. `SOLOMD_LT_BASE_URL`
/// overrides every mode — the hook the tests use to point at a fixture.
pub fn base_url(cfg: &LtConfig) -> String {
    if let Ok(v) = std::env::var("SOLOMD_LT_BASE_URL") {
        if !v.trim().is_empty() {
            return normalize_base(&v);
        }
    }
    match cfg.mode.as_str() {
        "premium" => PREMIUM_URL.to_string(),
        "public" => PUBLIC_URL.to_string(),
        _ => normalize_base(cfg.base_url.as_deref().unwrap_or(DEFAULT_LOCAL_URL)),
    }
}

/// Accept `localhost:8081`, `http://host:8081/`, `http://host:8081/v2` alike.
pub fn normalize_base(raw: &str) -> String {
    let mut s = raw.trim().trim_end_matches('/').to_string();
    if s.is_empty() {
        return DEFAULT_LOCAL_URL.to_string();
    }
    if !s.contains("://") {
        s = format!("http://{s}");
    }
    if let Some(stripped) = s.strip_suffix("/v2") {
        s = stripped.to_string();
    }
    s
}

fn is_local_mode(cfg: &LtConfig) -> bool {
    cfg.mode != "premium" && cfg.mode != "public"
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

static CLIENT: Lazy<Result<reqwest::Client, String>> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(5))
        .user_agent(concat!("SoloMD/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("http client init failed: {e}"))
});

fn client() -> Result<&'static reqwest::Client, String> {
    CLIENT.as_ref().map_err(|e| e.clone())
}

/// Rolling one-minute window of public-API request instants.
static PUBLIC_WINDOW: Lazy<Mutex<VecDeque<Instant>>> = Lazy::new(|| Mutex::new(VecDeque::new()));

/// Reserve a slot in the public-API window, or report how long to wait.
fn take_public_slot(now: Instant, window: &mut VecDeque<Instant>) -> Result<(), Duration> {
    while let Some(&t) = window.front() {
        if now.duration_since(t) >= Duration::from_secs(60) {
            window.pop_front();
        } else {
            break;
        }
    }
    if window.len() >= PUBLIC_MAX_PER_MINUTE {
        let oldest = *window.front().expect("non-empty");
        return Err(Duration::from_secs(60).saturating_sub(now.duration_since(oldest)));
    }
    window.push_back(now);
    Ok(())
}

fn map_send_error(e: reqwest::Error) -> String {
    if e.is_connect() || e.is_timeout() {
        format!("lt:unreachable: {e}")
    } else {
        format!("lt:http: {e}")
    }
}

fn map_status(status: reqwest::StatusCode, body: &str) -> String {
    let detail: String = body.trim().chars().take(200).collect();
    match status.as_u16() {
        401 | 403 => format!("lt:auth: {detail}"),
        413 => "lt:too-large".to_string(),
        429 => "lt:rate-limited".to_string(),
        // LanguageTool answers 400 for both bad parameters and "text too long".
        400 if detail.to_ascii_lowercase().contains("too long") => "lt:too-large".to_string(),
        _ => format!("lt:http: {status} {detail}"),
    }
}

fn premium_credentials(cfg: &LtConfig) -> Result<(String, String), String> {
    let user = cfg.username.as_deref().unwrap_or("").trim().to_string();
    if user.is_empty() {
        return Err("lt:no-credentials".into());
    }
    let key = super::ai_keystore::read_key(KEY_PROVIDER).map_err(|_| "lt:no-credentials".to_string())?;
    if key.trim().is_empty() {
        return Err("lt:no-credentials".into());
    }
    Ok((user, key))
}

/// Form fields for `/v2/check`. Split out so it is unit-testable without a
/// keychain.
fn check_form(
    req: &CheckRequest,
    creds: Option<(String, String)>,
) -> Result<Vec<(&'static str, String)>, String> {
    let data = serde_json::json!({ "annotation": req.annotation }).to_string();
    let lang = if req.language.trim().is_empty() { "auto".to_string() } else { req.language.trim().to_string() };
    let mut form: Vec<(&'static str, String)> = vec![("data", data), ("language", lang.clone())];
    if let Some(mt) = req.mother_tongue.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        form.push(("motherTongue", mt.to_string()));
    }
    if lang == "auto" {
        if let Some(pv) = req.preferred_variants.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            form.push(("preferredVariants", pv.to_string()));
        }
    }
    if let Some(level) = req.level.as_deref().filter(|l| *l == "picky") {
        form.push(("level", level.to_string()));
    }
    let disabled: Vec<&str> = req
        .disabled_rules
        .iter()
        .map(|r| r.trim())
        .filter(|r| !r.is_empty())
        .collect();
    if !disabled.is_empty() {
        form.push(("disabledRules", disabled.join(",")));
    }
    if let Some((user, key)) = creds {
        form.push(("username", user));
        form.push(("apiKey", key));
    }
    Ok(form)
}

pub async fn check(req: CheckRequest) -> Result<CheckResponse, String> {
    let cfg = &req.config;
    if req.annotation.is_empty() {
        return Ok(CheckResponse { matches: Vec::new(), language: String::new() });
    }
    let creds = if cfg.mode == "premium" { Some(premium_credentials(cfg)?) } else { None };
    if cfg.mode == "public" && std::env::var("SOLOMD_LT_BASE_URL").is_err() {
        let mut w = PUBLIC_WINDOW.lock().map_err(|e| e.to_string())?;
        if take_public_slot(Instant::now(), &mut w).is_err() {
            return Err("lt:rate-limited".into());
        }
    }
    let form = check_form(&req, creds)?;
    let url = format!("{}/v2/check", base_url(cfg));
    let resp = client()?
        .post(&url)
        .form(&form)
        .send()
        .await
        .map_err(map_send_error)?;
    let status = resp.status();
    let body = resp.text().await.map_err(map_send_error)?;
    if !status.is_success() {
        return Err(map_status(status, &body));
    }
    parse_check_response(&body)
}

pub async fn detect(cfg: &LtConfig) -> LtStatus {
    let url = format!("{}/v2/languages", base_url(cfg));
    let Ok(c) = client() else { return LtStatus::default() };
    let budget = if is_local_mode(cfg) { 3 } else { 10 };
    let resp = match c.get(&url).timeout(Duration::from_secs(budget)).send().await {
        Ok(r) => r,
        Err(e) => return LtStatus { error: Some(map_send_error(e)), ..Default::default() },
    };
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return LtStatus { error: Some(map_status(status, &body)), ..Default::default() };
    }
    match serde_json::from_str::<Vec<LtLanguage>>(&body) {
        Ok(mut languages) => {
            languages.sort_by(|a, b| a.name.cmp(&b.name));
            LtStatus { ok: true, languages, error: None }
        }
        Err(e) => LtStatus { error: Some(format!("lt:http: invalid response: {e}")), ..Default::default() },
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn languagetool_check(req: CheckRequest) -> Result<CheckResponse, String> {
    check(req).await
}

/// Probe the configured server (`GET /v2/languages`). Never errors — the
/// failure reason is in `LtStatus.error` so Settings can show one status pill.
/// For premium it also verifies that credentials are stored, since the
/// languages endpoint itself is unauthenticated.
#[tauri::command]
pub async fn languagetool_detect(config: LtConfig) -> LtStatus {
    let mut st = detect(&config).await;
    if st.ok && config.mode == "premium" {
        if let Err(e) = premium_credentials(&config) {
            st.ok = false;
            st.error = Some(e);
        }
    }
    st
}

#[tauri::command]
pub fn languagetool_set_api_key(key: String) -> Result<(), String> {
    let k = key.trim();
    if k.is_empty() {
        return Err("empty key".into());
    }
    super::ai_keystore::set_key(KEY_PROVIDER, k)
}

#[tauri::command]
pub fn languagetool_has_api_key() -> Result<bool, String> {
    super::ai_keystore::has_key(KEY_PROVIDER)
}

#[tauri::command]
pub fn languagetool_clear_api_key() -> Result<(), String> {
    super::ai_keystore::clear_key(KEY_PROVIDER)
}

/// Premium only: add `word` to the account's LanguageTool dictionary so it is
/// accepted on every device / add-on the user runs LanguageTool in.
#[tauri::command]
pub async fn languagetool_words_add(config: LtConfig, word: String) -> Result<(), String> {
    let (user, key) = premium_credentials(&config)?;
    let url = format!("{}/v2/words/add", base_url(&config));
    let resp = client()?
        .post(&url)
        .form(&[("word", word.trim()), ("username", user.as_str()), ("apiKey", key.as_str())])
        .send()
        .await
        .map_err(map_send_error)?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(map_status(status, &body));
    }
    Ok(())
}

/// Premium only: the words in the account's LanguageTool dictionary.
#[tauri::command]
pub async fn languagetool_words_list(config: LtConfig) -> Result<Vec<String>, String> {
    let (user, key) = premium_credentials(&config)?;
    let url = format!("{}/v2/words", base_url(&config));
    let resp = client()?
        .get(&url)
        .query(&[("username", user.as_str()), ("apiKey", key.as_str()), ("limit", "500")])
        .send()
        .await
        .map_err(map_send_error)?;
    let status = resp.status();
    let body = resp.text().await.map_err(map_send_error)?;
    if !status.is_success() {
        return Err(map_status(status, &body));
    }
    parse_words(&body)
}

fn parse_words(body: &str) -> Result<Vec<String>, String> {
    #[derive(Deserialize)]
    struct Words {
        #[serde(default)]
        words: Vec<String>,
    }
    serde_json::from_str::<Words>(body)
        .map(|w| w.words)
        .map_err(|e| format!("lt:http: invalid response: {e}"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Real `/v2/check` answer from LanguageTool 6.6 (trimmed) for the
    /// annotation `Das ist ein **Fehler** , oder nicht?`.
    const CHECK_BODY: &str = r#"{
      "software": {"name": "LanguageTool", "version": "6.6"},
      "language": {"name": "German (Germany)", "code": "de-DE"},
      "matches": [{
        "message": "Vor dem Komma sollte kein Leerzeichen stehen.",
        "shortMessage": "",
        "replacements": [{"value": ","}],
        "offset": 22, "length": 2,
        "context": {"text": "...", "offset": 22, "length": 2},
        "sentence": "Das ist ein **Fehler** , oder nicht?",
        "rule": {
          "id": "COMMA_PARENTHESIS_WHITESPACE",
          "description": "Leerzeichen vor/hinter Kommas und Klammern",
          "issueType": "whitespace",
          "category": {"id": "TYPOGRAPHY", "name": "Typografie"}
        }
      }, {
        "message": "Möglicher Tippfehler gefunden.",
        "replacements": [{"value": "a"}, {"value": "b"}, {"value": "c"}, {"value": "d"}, {"value": "e"}, {"value": "f"}],
        "offset": 30, "length": 8,
        "rule": {"id": "GERMAN_SPELLER_RULE", "description": "Rechtschreibung", "issueType": "misspelling",
                 "category": {"id": "TYPOS"}}
      }]
    }"#;

    fn cfg(mode: &str) -> LtConfig {
        LtConfig { mode: mode.into(), base_url: None, username: None }
    }

    fn request(cfg: LtConfig) -> CheckRequest {
        CheckRequest {
            config: cfg,
            annotation: vec![
                Segment { text: Some("Hello ".into()), markup: None, interpret_as: None },
                Segment { text: None, markup: Some("`x`".into()), interpret_as: Some("Dummy".into()) },
            ],
            language: "auto".into(),
            mother_tongue: Some("de-DE".into()),
            preferred_variants: Some("en-GB,de-DE".into()),
            level: Some("picky".into()),
            disabled_rules: vec!["WHITESPACE_RULE".into(), " ".into(), "EN_QUOTES".into()],
        }
    }

    #[test]
    fn parses_matches_and_caps_replacements() {
        let r = parse_check_response(CHECK_BODY).unwrap();
        assert_eq!(r.language, "de-DE");
        assert_eq!(r.matches.len(), 2);
        let m = &r.matches[0];
        assert_eq!((m.offset, m.length), (22, 2));
        assert_eq!(m.rule_id, "COMMA_PARENTHESIS_WHITESPACE");
        assert_eq!(m.issue_type, "whitespace");
        assert_eq!(m.category_id, "TYPOGRAPHY");
        assert_eq!(m.replacements, vec![","]);
        assert_eq!(r.matches[1].replacements.len(), 5, "replacements are capped at 5");
    }

    #[test]
    fn parses_word_list() {
        assert_eq!(parse_words(r#"{"words":["Fehlr","SoloMD"]}"#).unwrap(), vec!["Fehlr", "SoloMD"]);
        assert!(parse_words("nope").is_err());
    }

    #[test]
    fn invalid_body_is_an_lt_error() {
        assert!(parse_check_response("<html>").unwrap_err().starts_with("lt:http"));
    }

    #[test]
    fn segments_serialize_as_annotated_text() {
        let s = Segment { text: None, markup: Some("**".into()), interpret_as: None };
        assert_eq!(serde_json::to_string(&s).unwrap(), r#"{"markup":"**"}"#);
        let s = Segment { text: None, markup: Some("`a`".into()), interpret_as: Some("Dummy".into()) };
        assert_eq!(serde_json::to_string(&s).unwrap(), r#"{"markup":"`a`","interpretAs":"Dummy"}"#);
    }

    #[test]
    fn form_carries_options_and_credentials() {
        let form = check_form(&request(cfg("premium")), Some(("me@x.de".into(), "k3y".into()))).unwrap();
        let get = |k: &str| form.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone());
        assert_eq!(get("language").as_deref(), Some("auto"));
        assert_eq!(get("motherTongue").as_deref(), Some("de-DE"));
        assert_eq!(get("preferredVariants").as_deref(), Some("en-GB,de-DE"));
        assert_eq!(get("level").as_deref(), Some("picky"));
        assert_eq!(get("disabledRules").as_deref(), Some("WHITESPACE_RULE,EN_QUOTES"));
        assert_eq!(get("username").as_deref(), Some("me@x.de"));
        assert_eq!(get("apiKey").as_deref(), Some("k3y"));
        assert_eq!(
            get("data").as_deref(),
            Some(r#"{"annotation":[{"text":"Hello "},{"interpretAs":"Dummy","markup":"`x`"}]}"#)
        );
    }

    #[test]
    fn preferred_variants_only_with_auto_and_default_level_omitted() {
        let mut req = request(cfg("local"));
        req.language = "de-DE".into();
        req.level = Some("default".into());
        let form = check_form(&req, None).unwrap();
        assert!(form.iter().all(|(k, _)| *k != "preferredVariants" && *k != "level" && *k != "apiKey"));
    }

    #[test]
    fn base_urls_normalize() {
        assert_eq!(normalize_base("localhost:8081"), "http://localhost:8081");
        assert_eq!(normalize_base("http://lt.lan:8010/v2/"), "http://lt.lan:8010");
        assert_eq!(normalize_base("  "), DEFAULT_LOCAL_URL);
        if std::env::var("SOLOMD_LT_BASE_URL").is_err() {
            assert_eq!(base_url(&cfg("premium")), PREMIUM_URL);
            assert_eq!(base_url(&cfg("public")), PUBLIC_URL);
            assert_eq!(base_url(&cfg("local")), DEFAULT_LOCAL_URL);
        }
    }

    #[test]
    fn public_window_allows_twenty_per_minute() {
        let mut w = VecDeque::new();
        let t0 = Instant::now();
        for _ in 0..PUBLIC_MAX_PER_MINUTE {
            assert!(take_public_slot(t0, &mut w).is_ok());
        }
        let wait = take_public_slot(t0 + Duration::from_secs(10), &mut w).unwrap_err();
        assert_eq!(wait, Duration::from_secs(50));
        assert!(take_public_slot(t0 + Duration::from_secs(61), &mut w).is_ok());
    }

    #[test]
    fn status_codes_map_to_lt_errors() {
        use reqwest::StatusCode;
        assert!(map_status(StatusCode::UNAUTHORIZED, "bad key").starts_with("lt:auth"));
        assert_eq!(map_status(StatusCode::TOO_MANY_REQUESTS, ""), "lt:rate-limited");
        assert_eq!(map_status(StatusCode::PAYLOAD_TOO_LARGE, ""), "lt:too-large");
        assert_eq!(
            map_status(StatusCode::BAD_REQUEST, "Error: Your text exceeds the limit (text too long)"),
            "lt:too-large"
        );
        assert!(map_status(StatusCode::INTERNAL_SERVER_ERROR, "boom").starts_with("lt:http"));
    }

    async fn serve_once(status_line: &'static str, body: &'static str) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = vec![0u8; 16 * 1024];
                let _ = socket.read(&mut buf).await;
                let resp = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(resp.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });
        addr
    }

    #[tokio::test]
    async fn check_round_trips_against_a_server() {
        let addr = serve_once("200 OK", CHECK_BODY).await;
        let mut c = cfg("local");
        c.base_url = Some(format!("http://{addr}/v2"));
        let r = check(request(c)).await.unwrap();
        assert_eq!(r.matches.len(), 2);
    }

    #[tokio::test]
    async fn detect_reports_languages_and_failures() {
        let addr = serve_once(
            "200 OK",
            r#"[{"name":"German (Germany)","code":"de","longCode":"de-DE"},{"name":"English (US)","code":"en","longCode":"en-US"}]"#,
        )
        .await;
        let mut c = cfg("local");
        c.base_url = Some(format!("http://{addr}"));
        let st = detect(&c).await;
        assert!(st.ok);
        assert_eq!(st.languages[0].long_code, "en-US", "sorted by name");

        // Nothing listens on a port we just released.
        let free = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap();
        c.base_url = Some(format!("http://{free}"));
        let st = detect(&c).await;
        assert!(!st.ok);
        assert!(st.error.unwrap().starts_with("lt:unreachable"));
    }

    #[tokio::test]
    async fn premium_without_username_needs_credentials() {
        let r = check(request(cfg("premium"))).await;
        assert_eq!(r.unwrap_err(), "lt:no-credentials");
    }
}
