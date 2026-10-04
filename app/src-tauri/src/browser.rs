//! 内嵌浏览器子 webview（桌面独占）。
//!
//! Tauri 无法在 Android/iOS 上把第二个 webview 嵌进主 webview 的布局，
//! 只能另开全屏 Activity，与本功能的设计冲突。移动端走 `browser_mobile.rs`
//! 的 stub，模块名同样是 `browser`，所以 `lib.rs` 的 `generate_handler!`
//! 不必按平台分叉。
//!
//! # 安全边界
//!
//! 子 webview 加载任意远程页面，所以：
//!
//! 1. **`on_navigation` 只放行 http/https。** 其余 scheme（`tauri://`、
//!    `asset://`、`file://`、应用注册的自定义协议）一律取消。这条针对
//!    CVE-2026-42184 —— Windows/Android 上 `is_local_url()` 只取域名第一段，
//!    `http://asset.evil.com/` 会被误判成本地来源，而本应用的 capability
//!    给 main 窗口发了 `fs:allow-read-file`（`**` 范围）。
//! 2. **子 webview 不调用任何 Tauri 命令。** 采集数据经哨兵 URL 由
//!    `on_navigation` 回传，页面拿不到任何能力 —— 没有可调的命令，
//!    也就没有需要授权的 ACL 条目可以配错。
//! 3. **收到的内容只进内存缓冲**（由前端持有），不落盘。
//!
//! # 为什么不用 IPC 回传
//!
//! tauri 2.10.3 的 IPC 门是
//! `if (plugin_command.is_some() || has_app_acl_manifest) && …`，而本 crate
//! 不声明 AppManifest，于是**所有 app 命令都绕过 ACL**，远程页面能直接调
//! `read_file`。2.12.1 加了 `|| !is_local` 才把远程来源挡住（见 Cargo.toml
//! 的版本说明）。即便如此，走 `on_navigation` 更省事：不需要 capability、
//! 不需要 AppManifest（声明它会连锁要求给 ~150 个命令补授权），也不受
//! Chrome 142+ Private Network Access 对回环地址的限制。

use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine as _;
use once_cell::sync::Lazy;
use tauri::{
    webview::WebviewBuilder, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl,
};

// `super::`, not `crate::`: this file is compiled into two roots (the lib via
// lib.rs, the bin via runner.rs's #[path] declaration). `super::browser_types`
// resolves to the crate root in both; `crate::browser_types` would only work
// in one.
use super::browser_types::CapturePayload;

/// 活着的子 webview，按前端 tab id 索引。
static WEBVIEWS: Lazy<Mutex<HashMap<String, tauri::Webview>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// 分片重组缓冲。key 是 `(webview_label, kind)`。
static PENDING_CHUNKS: Lazy<Mutex<HashMap<(String, String), Vec<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// 子 webview label 前缀。前端拿到的 `tabId` 是裸 id，`on_navigation`
/// 回调里拿到的是完整 label，两边靠这个前缀互相转换（前端
/// `stores/browser.ts` 的 `stripLabel`）。
const LABEL_PREFIX: &str = "browser-";

/// 回传哨兵域名。必须是 RFC 2606 保留域名（永不解析）——这样即使
/// `on_navigation` 在某平台没拦住，也只是一次失败的导航，不会把
/// 采集内容发到互联网上。
const SENTINEL_HOST: &str = "solomd.invalid";

/// 防御性上限：分片总数和单页总量。
///
/// 注意：Rust 侧**不做分片**，只做重组 —— 切片大小是注入脚本里
/// `CAPTURE_SCRIPT` 的 `CHUNK`，那里是唯一的可调点（P0 Task 5 Step 6
/// 实测出导航 URL 上限后改那个数）。这里只挡页面自称的荒谬值。
const MAX_CHUNKS: usize = 4096;
const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;

fn label_for(tab_id: &str) -> String {
    format!("{LABEL_PREFIX}{tab_id}")
}

/// 注入页面里的采集入口。
///
/// 逻辑住在 `capture_script.js` 里而不是内联成字符串：它有两百多行，内联
/// 会把这个文件淹没，也没法单独测。`include_str!` 在编译期嵌进来，运行时
/// 不读文件。
///
/// **刻意不碰任何 Tauri API** —— 不读 `__TAURI_INTERNALS__`，不调命令。
/// 数据通过赋值 `location.href` 指向哨兵域名送出，由 on_navigation 截获。
const CAPTURE_SCRIPT: &str = include_str!("capture_script.js");

/// 拆解哨兵 URL：`/capture/<kind>/<n>/<total>#<b64片>`。
///
/// 返回 `(kind, index, total, chunk)`。不是哨兵 URL、或格式不对，返回 None。
///
/// **这是不可信输入** —— 来自任意页面。所有解析失败都只返回 None，不 panic。
fn parse_sentinel(url: &tauri::Url) -> Option<(String, usize, usize, String)> {
    if url.host_str() != Some(SENTINEL_HOST) {
        return None;
    }
    let mut segs = url.path_segments()?;
    if segs.next()? != "capture" {
        return None;
    }
    let kind = segs.next()?.to_string();
    // kind 只用来区分事件名，白名单化，别让页面塞任意字符串进来。
    if kind != "capture" && kind != "selection" {
        return None;
    }
    let index: usize = segs.next()?.parse().ok()?;
    let total: usize = segs.next()?.parse().ok()?;
    if total == 0 || total > MAX_CHUNKS || index >= total {
        return None;
    }
    Some((kind, index, total, url.fragment()?.to_string()))
}

/// 收齐分片后解码并发事件。所有失败路径都只沉默返回 —— 输入不可信，
/// 一次畸形导航不值得让整个导航处理器 panic。
fn accept_chunk(app: &AppHandle, label: &str, url: &tauri::Url) {
    let Some((kind, index, total, chunk)) = parse_sentinel(url) else {
        return;
    };
    let key = (label.to_string(), kind.clone());

    let joined = {
        let Ok(mut map) = PENDING_CHUNKS.lock() else {
            return;
        };
        let slots = map
            .entry(key.clone())
            .or_insert_with(|| vec![String::new(); total]);
        // total 变了说明上一轮的残片，丢掉重来。
        if slots.len() != total {
            slots.clear();
            slots.resize(total, String::new());
        }
        slots[index] = chunk;
        if slots.iter().any(|s| s.is_empty()) {
            return; // 还有空洞，没到齐
        }
        map.remove(&key).unwrap_or_default()
    };

    let flattened: String = joined.concat();
    if flattened.len() > MAX_TOTAL_BYTES {
        return;
    }
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(flattened) else {
        return;
    };
    let Ok(payload) = serde_json::from_slice::<CapturePayload>(&bytes) else {
        return;
    };

    let event = if kind == "selection" {
        "browser://selection"
    } else {
        "browser://capture"
    };
    // tabId 用裸 id，和前端 stores/browser.ts 的约定一致。
    let tab_id = label.strip_prefix(LABEL_PREFIX).unwrap_or(label);
    let _ = app.emit(
        event,
        serde_json::json!({ "tabId": tab_id, "payload": payload }),
    );
}

#[tauri::command]
pub async fn browser_create(
    app: AppHandle,
    tab_id: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("bad url: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http/https allowed".into());
    }
    let label = label_for(&tab_id);

    if WEBVIEWS
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&tab_id)
    {
        return Ok(());
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    let app_for_nav = app.clone();
    let label_for_nav = label.clone();

    let webview = window
        .add_child(
            WebviewBuilder::new(label, WebviewUrl::External(parsed))
                .initialization_script(CAPTURE_SCRIPT)
                // 一个处理器干两件事：回传 + 放行白名单。
                //   哨兵域名  → 收片，返回 false 取消导航（页面不跳转，登录态不丢）
                //   http/https → 放行
                //   其他一切   → 取消
                .on_navigation(move |u| {
                    if u.host_str() == Some(SENTINEL_HOST) {
                        accept_chunk(&app_for_nav, &label_for_nav, u);
                        return false;
                    }
                    matches!(u.scheme(), "http" | "https")
                }),
            LogicalPosition::new(x, y),
            LogicalSize::new(w, h),
        )
        .map_err(|e| format!("add_child failed: {e}"))?;

    WEBVIEWS
        .lock()
        .map_err(|e| e.to_string())?
        .insert(tab_id, webview);
    Ok(())
}

#[tauri::command]
pub async fn browser_set_bounds(
    tab_id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let map = WEBVIEWS.lock().map_err(|e| e.to_string())?;
    let Some(wv) = map.get(&tab_id) else {
        return Ok(());
    };
    wv.set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    wv.set_size(LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn browser_show(tab_id: String) -> Result<(), String> {
    let map = WEBVIEWS.lock().map_err(|e| e.to_string())?;
    if let Some(wv) = map.get(&tab_id) {
        wv.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_hide(tab_id: String) -> Result<(), String> {
    let map = WEBVIEWS.lock().map_err(|e| e.to_string())?;
    if let Some(wv) = map.get(&tab_id) {
        wv.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_navigate(tab_id: String, url: String) -> Result<(), String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("bad url: {e}"))?;
    // 这里独立重复一次 scheme 校验，不依赖 on_navigation —— 否则前端传
    // 什么就导航什么，把这个 webview 变成能加载本地协议的东西。
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http/https allowed".into());
    }
    let map = WEBVIEWS.lock().map_err(|e| e.to_string())?;
    let Some(wv) = map.get(&tab_id) else {
        return Ok(());
    };
    wv.navigate(parsed).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn browser_destroy(tab_id: String) -> Result<(), String> {
    let webview = WEBVIEWS
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&tab_id);
    if let Some(wv) = webview {
        let _ = wv.close();
    }
    // 顺手清掉这个 webview 的残片，避免关掉 tab 后缓冲泄漏。
    if let Ok(mut map) = PENDING_CHUNKS.lock() {
        map.retain(|(label, _), _| label != &label_for(&tab_id));
    }
    Ok(())
}

/// 让子 webview 执行页面内的采集函数。只由本地主窗口调用。
#[tauri::command]
pub async fn browser_request_capture(tab_id: String) -> Result<(), String> {
    let map = WEBVIEWS.lock().map_err(|e| e.to_string())?;
    let Some(wv) = map.get(&tab_id) else {
        return Err("no such browser tab".into());
    };
    wv.eval("window.__solomd && window.__solomd.capture();")
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 让子 webview 取当前选中文本。只由本地主窗口调用。
#[tauri::command]
pub async fn browser_request_selection(tab_id: String) -> Result<(), String> {
    let map = WEBVIEWS.lock().map_err(|e| e.to_string())?;
    let Some(wv) = map.get(&tab_id) else {
        return Err("no such browser tab".into());
    };
    wv.eval("window.__solomd && window.__solomd.selection();")
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 内嵌浏览器在本机是否可用。
///
/// Wayland 上 wry 的 `build_as_child` 会报
/// "the window handle kind is not supported"，所以直接不给入口 ——
/// 前端分不出 X11 和 Wayland（`navigator.userAgentData.platform` 两次
/// 都只报 `Linux`），必须由 Rust 这边看环境变量。
#[tauri::command]
pub fn browser_platform_supported() -> bool {
    if cfg!(target_os = "linux") {
        // 有 WAYLAND_DISPLAY 且没有 DISPLAY 才是纯 Wayland 会话；
        // 两者都有时走 XWayland，子 webview 能用。
        return std::env::var("WAYLAND_DISPLAY").is_err() || std::env::var("DISPLAY").is_ok();
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> tauri::Url {
        tauri::Url::parse(s).expect("test url")
    }

    #[test]
    fn parses_a_well_formed_sentinel() {
        let got = parse_sentinel(&u("https://solomd.invalid/capture/capture/0/2#AAAA"));
        assert_eq!(got, Some(("capture".into(), 0, 2, "AAAA".into())));
    }

    #[test]
    fn parses_selection_kind() {
        let got = parse_sentinel(&u("https://solomd.invalid/capture/selection/0/1#BB"));
        assert_eq!(got, Some(("selection".into(), 0, 1, "BB".into())));
    }

    #[test]
    fn rejects_a_different_host() {
        assert_eq!(parse_sentinel(&u("https://example.com/capture/capture/0/1#AA")), None);
    }

    /// 页面能往哨兵路径里塞任意 kind，不认识的一律丢弃 ——
    /// 否则它能凭空造出一个前端没监听的事件名。
    #[test]
    fn rejects_an_unknown_kind() {
        assert_eq!(parse_sentinel(&u("https://solomd.invalid/capture/evil/0/1#AA")), None);
    }

    #[test]
    fn rejects_a_non_capture_path() {
        assert_eq!(parse_sentinel(&u("https://solomd.invalid/other/capture/0/1#AA")), None);
    }

    /// 没有 fragment 就没有 payload。
    #[test]
    fn rejects_a_missing_fragment() {
        assert_eq!(parse_sentinel(&u("https://solomd.invalid/capture/capture/0/1")), None);
    }

    #[test]
    fn rejects_an_out_of_range_index() {
        assert_eq!(parse_sentinel(&u("https://solomd.invalid/capture/capture/3/2#AA")), None);
    }

    /// total=0 会让重组逻辑分配一个永远填不满的缓冲。
    #[test]
    fn rejects_zero_total() {
        assert_eq!(parse_sentinel(&u("https://solomd.invalid/capture/capture/0/0#AA")), None);
    }

    /// 页面可以声称一万片，逼我们分配一大块内存。
    #[test]
    fn rejects_an_absurd_total() {
        let big = MAX_CHUNKS + 1;
        let s = format!("https://solomd.invalid/capture/capture/0/{big}#AA");
        assert_eq!(parse_sentinel(&u(&s)), None);
    }

    #[test]
    fn rejects_non_numeric_segments() {
        assert_eq!(parse_sentinel(&u("https://solomd.invalid/capture/capture/x/1#AA")), None);
        assert_eq!(parse_sentinel(&u("https://solomd.invalid/capture/capture/0/y#AA")), None);
    }

    /// 中文和 %、+、/、= 经过 base64 后必须逐字节还原。
    #[test]
    fn base64_round_trips_cjk_and_url_punctuation() {
        let original = "中文 %2F + / = 😀 \n\t\"quoted\"";
        let payload = serde_json::json!({ "text": original }).to_string();
        let encoded = base64::engine::general_purpose::STANDARD.encode(payload.as_bytes());
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&encoded)
            .expect("decode");
        let back: serde_json::Value = serde_json::from_slice(&decoded).expect("json");
        assert_eq!(back["text"], original);
    }

    /// 分片拼接的顺序必须是 index 序，不是到达序。
    #[test]
    fn chunks_concatenate_in_index_order() {
        let mut slots: Vec<String> = vec![String::new(); 3];
        slots[2] = "CC".into();
        slots[0] = "AA".into();
        slots[1] = "BB".into();
        assert_eq!(slots.concat(), "AABBCC");
    }
}
