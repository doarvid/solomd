//! 内嵌浏览器的移动端 stub。
//!
//! Tauri 无法在 Android/iOS 上把第二个 webview 嵌进主 webview 的布局
//! （`WebviewBuilder` + `add_child` 在那边根本不存在 —— 它 gate 在
//! `#[cfg(all(desktop, feature = "unstable"))]`），所以这些命令只返回错误。
//!
//! 保留同名函数是为了让 `lib.rs` 的 `generate_handler!` 列表在两个平台
//! 完全一致 —— 少一处条件编译就少一处漏改的机会。前端也会通过
//! `browser_platform_supported` 直接隐藏入口，正常情况下用户碰不到这些错误。
//!
//! 桌面实现在 `browser.rs`，模块名相同（靠 `#[path]` 指向本文件）。

const UNSUPPORTED: &str = "embedded browser is desktop-only";

#[tauri::command]
pub async fn browser_create(
    _tab_id: String,
    _url: String,
    _x: f64,
    _y: f64,
    _w: f64,
    _h: f64,
) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn browser_set_bounds(
    _tab_id: String,
    _x: f64,
    _y: f64,
    _w: f64,
    _h: f64,
) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn browser_show(_tab_id: String) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn browser_hide(_tab_id: String) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn browser_navigate(_tab_id: String, _url: String) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

/// 销毁在移动端是 no-op 而不是错误：它由 `stores/browser.ts` 的 tab
/// diff 驱动，返回错误会在每次关 tab 时刷一条无意义的失败。
#[tauri::command]
pub async fn browser_destroy(_tab_id: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn browser_request_capture(_tab_id: String) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn browser_request_selection(_tab_id: String) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

/// 移动端永远不支持 —— 这个命令不返回错误，直接返回 false，
/// 因为前端在挂载时就会调它来决定要不要显示入口。
#[tauri::command]
pub fn browser_platform_supported() -> bool {
    false
}
