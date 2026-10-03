//! 内嵌浏览器的共享类型。
//!
//! 这个模块**无条件编译** —— `browser.rs`（桌面）是 `#[cfg(desktop)]` 的，
//! 但 `lib.rs` 的 `generate_handler!` 和移动端 stub 都可能需要这些类型，
//! 所以它们不能住在条件编译的模块里。

use serde::{Deserialize, Serialize};

/// 对话里提取出的一条引用链接。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureLink {
    pub href: String,
    #[serde(default)]
    pub text: String,
}

/// 页面上采集回来的一批内容。
///
/// 由注入脚本序列化、经哨兵 URL 回传、在 `on_navigation` 里解码得到。
/// **这是不可信输入** —— 它来自任意网页。所有消费方都必须把字段当作
/// 可能为空、可能超长、可能含任意字节来处理。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturePayload {
    pub url: String,
    #[serde(default)]
    pub title: String,
    pub text: String,
    #[serde(default)]
    pub links: Vec<CaptureLink>,
}
