//! 隐藏采集 webview 的 Rust 侧：请求/回传配对与生命周期。
//!
//! 页面脚本经哨兵 URL 回传（见 `browser.rs`），这里只做投递：
//! 同一 kind 同时最多一个等待者，重复请求直接报 busy，避免两轮数据
//! 的分片互相污染。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use once_cell::sync::Lazy;
use tauri::AppHandle;
use tokio::sync::oneshot;

use super::browser;

/// 前端不感知的保留 tab id。label 由 `browser::label_for` 规则拼出。
pub const COLLECTOR_ID: &str = "collector";
const COLLECTOR_LABEL: &str = "browser-collector";

/// 允许从 collector 回传的 kind。与 `browser::parse_sentinel` 的白名单一致。
const KINDS: [&str; 3] = ["probe", "collect", "render"];

static WAITERS: Lazy<Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub fn is_collector_label(label: &str) -> bool {
    label == COLLECTOR_LABEL
}

/// 收齐一片后调用。没有等待者就丢弃 —— 迟到的一片不应该串进下一轮。
pub fn deliver(label: &str, kind: &str, payload: serde_json::Value) {
    if !is_collector_label(label) || !KINDS.contains(&kind) {
        return;
    }
    let tx = WAITERS.lock().ok().and_then(|mut m| m.remove(kind));
    if let Some(tx) = tx {
        let _ = tx.send(payload);
    }
}

/// 等一次回传。调用方负责先 `browser::clear_chunks`。
pub async fn wait_for(kind: &str, timeout: Duration) -> Result<serde_json::Value, String> {
    if !KINDS.contains(&kind) {
        return Err(format!("unknown collector kind: {kind}"));
    }
    let (tx, rx) = oneshot::channel();
    {
        let mut map = WAITERS.lock().map_err(|e| e.to_string())?;
        if map.contains_key(kind) {
            return Err("collector busy".into());
        }
        map.insert(kind.to_string(), tx);
    }

    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => Err("collector channel closed".into()),
        Err(_) => {
            if let Ok(mut map) = WAITERS.lock() {
                map.remove(kind);
            }
            Err("collector timed out".into())
        }
    }
}

/// 丢掉上一轮残片后开始等待。`navigate_and_wait` 与脚本 eval 之间必须
/// 走这里，否则超时请求留下的空洞会拼坏下一轮。
pub fn begin(kind: &str) {
    browser::clear_chunks(COLLECTOR_LABEL, kind);
}

const TOUTIAO_FAVOURITES: &str = "https://www.toutiao.com/c/user/favourite/";

/// 采集入口 URL。来源白名单和 `collections.rs` 的 source 集合一致。
pub fn source_url(source: &str) -> Result<&'static str, String> {
    match source {
        "toutiao" => Ok(TOUTIAO_FAVOURITES),
        other => Err(format!("unknown collection source: {other}")),
    }
}

pub fn ensure(app: &AppHandle) -> Result<(), String> {
    browser::ensure_collector(app)
}

/// 导航到 `url` 并等一次 load Finished，再留 500 ms 给 hydration。
pub async fn navigate_and_wait(
    app: &AppHandle,
    url: &str,
    timeout: Duration,
) -> Result<(), String> {
    ensure(app)?;
    let generation = browser::collector_load_generation();
    browser::collector_navigate(url)?;
    browser::wait_collector_loaded(generation, timeout).await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_collector_label_is_recognised() {
        assert!(is_collector_label("browser-collector"));
        assert!(!is_collector_label("browser-abc"));
        assert!(!is_collector_label("collector"));
    }

    #[tokio::test]
    async fn deliver_wakes_the_waiter() {
        let wait = tokio::spawn(wait_for("probe", Duration::from_secs(1)));
        tokio::task::yield_now().await;
        deliver(
            COLLECTOR_LABEL,
            "probe",
            serde_json::json!({ "loggedIn": true }),
        );
        let value = wait.await.expect("join").expect("payload");
        assert_eq!(value["loggedIn"], true);
    }

    #[tokio::test]
    async fn a_second_concurrent_wait_is_busy() {
        let first = tokio::spawn(wait_for("collect", Duration::from_secs(1)));
        tokio::task::yield_now().await;
        let second = wait_for("collect", Duration::from_millis(50)).await;
        assert_eq!(second, Err("collector busy".into()));
        deliver(COLLECTOR_LABEL, "collect", serde_json::json!({ "items": [] }));
        assert!(first.await.expect("join").is_ok());
    }

    #[test]
    fn late_or_foreign_payloads_are_dropped() {
        // 没有等待者 / label 不对 / kind 不认识 —— 全部静默丢弃。
        deliver(COLLECTOR_LABEL, "render", serde_json::json!({ "html": "x" }));
        deliver("browser-abc", "probe", serde_json::json!({}));
        deliver(COLLECTOR_LABEL, "evil", serde_json::json!({}));
    }

    #[tokio::test]
    async fn unknown_kind_is_rejected_without_waiting() {
        let err = wait_for("evil", Duration::from_millis(10)).await.unwrap_err();
        assert!(err.contains("unknown collector kind"));
    }

    #[tokio::test]
    async fn a_timeout_removes_the_waiter() {
        let err = wait_for("render", Duration::from_millis(10)).await.unwrap_err();
        assert_eq!(err, "collector timed out");
        // 超时后可以立刻再等同一个 kind —— 残留等待者已被清掉。
        let second = tokio::spawn(wait_for("render", Duration::from_secs(1)));
        tokio::task::yield_now().await;
        deliver(COLLECTOR_LABEL, "render", serde_json::json!({ "html": "ok" }));
        assert!(second.await.expect("join").is_ok());
    }
}
