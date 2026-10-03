# 内嵌浏览器 + 知识采集 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 SoloMD 里加一个内嵌浏览器 tab（默认 DeepSeek），能把对话和它引用的网页采集成本地 markdown 笔记。

**Architecture:** Tauri 2 的 `Window::add_child` 在主窗口里叠一个原生子 webview；tab/pane 系统驱动它的位置和生命周期；采集回传走一个**只对浏览器 webview 生效的窄来源 capability**，内容先进内存待审缓冲，用户确认后才落盘。

**Tech Stack:** Tauri 2.10.3（需开 `unstable` feature）、Vue 3 + Pinia、Rust、`reqwest`、`dom_smoothie`、`scraper`、`htmd`。

**Spec:** [docs/superpowers/specs/2026-10-03-embedded-browser-capture-design.md](../specs/2026-10-03-embedded-browser-capture-design.md)

---

## 先读这段

**这是一份分批计划，不是一次做完的清单。** P0 是一个风险闸门：如果子 webview 在 macOS/Windows 上加载不了 DeepSeek 或者登录不过去，**后面全部作废**。P4 是第二个闸门：如果 `dom_smoothie` 在三个测试站点上够用，P5 的 AI 抽取层就不做。

因此：**P0–P2 写成可逐步执行的完整任务。P3–P6 只给任务级描述和接口契约**，等 P0、P4 的闸门过了再展开成同样粒度的计划。为还没验证过的阶段写 2000 行代码是浪费。

**测试工具约定（别引入新框架）：**
- Rust：`cd app/src-tauri && cargo test`
- 前端：`cd app && node --test src/lib/foo.test.ts`（Node 内置 runner + `node:assert/strict` + `node:test`，import 时带 `.ts` 后缀。**项目里没有 vitest，不要装**）
- 行为自测：`app/test-self.mjs` 风格的 `npx tsx` 脚本

**提交频率：** 每个 task 结束时提交一次，不要攒。

---

# P0 — 风险闸门（必须全过，否则停）

这一阶段不产出可用功能。它的唯一目的是回答两个问题：**子 webview 能不能用**、**用了安不安全**。

### Task 1: 打开 `unstable` feature 并确认三平台都能编译

**Files:**
- Modify: `app/src-tauri/Cargo.toml`（`tauri` 依赖行）

- [ ] **Step 1: 改 tauri 依赖**

```toml
tauri = { version = "2", features = ["protocol-asset", "image-png", "unstable"] }
```

- [ ] **Step 2: macOS 编译**

Run: `cd app/src-tauri && cargo build 2>&1 | tail -20`
Expected: 编译通过。若 `unstable` feature 不存在，说明 Tauri 版本不对，**停下来报告**。

- [ ] **Step 3: 确认移动端仍然能编译**

Run: `cd app/src-tauri && cargo check --target aarch64-linux-android 2>&1 | tail -20`
Expected: 通过（此时还没写任何 browser 代码，只是确认 `unstable` feature 本身没有把移动端弄坏）。如果失败，说明 `unstable` 会传染移动端，**停下来报告** —— 需要换方案，比如给 tauri 依赖做 target 分支。

- [ ] **Step 4: 提交**

```bash
git add app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock
git commit -m "build: enable tauri unstable feature for multiwebview"
```

---

### Task 2: `browser.rs` 骨架 + 移动端 stub

**Files:**
- Create: `app/src-tauri/src/browser.rs`
- Create: `app/src-tauri/src/browser_mobile.rs`
- Modify: `app/src-tauri/src/lib.rs`

- [ ] **Step 1: 写桌面实现骨架**

创建 `app/src-tauri/src/browser.rs`：

```rust
//! 内嵌浏览器子 webview。
//!
//! 只支持桌面：Tauri 无法在 Android/iOS 上把第二个 webview 嵌进主 webview
//! 的布局，只能另开全屏 Activity。移动端走 browser_mobile.rs 的 stub。
//!
//! 安全边界（详见 spec）：子 webview 加载任意远程页面，因此
//!   1. on_navigation 只放行 http/https，挡住 CVE-2026-42184 里
//!      `http://asset.evil.com/` 被误判成本地来源的路径；
//!   2. 只有 browser_capture / browser_selection 两个命令对远程来源开放，
//!      且都只写内存缓冲，不碰文件系统。

use std::collections::HashMap;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::{
    webview::WebviewBuilder, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager,
    WebviewUrl,
};

/// 活着的子 webview，按前端 tab id 索引。
static WEBVIEWS: Lazy<Mutex<HashMap<String, tauri::Webview>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// 子 webview 的 label 前缀。capabilities/browser.json 的 `webviews` glob
/// 必须和这里保持一致。
const LABEL_PREFIX: &str = "browser-";

fn label_for(tab_id: &str) -> String {
    format!("{LABEL_PREFIX}{tab_id}")
}

/// 该 webview 里注入的采集入口。只调用两个已被 capability 放行的命令，
/// 不引入任何新能力。
const CAPTURE_SCRIPT: &str = r#"
(function () {
  if (window.__solomd) return;
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);

  window.__solomd = {
    capture: () => {
      const links = [];
      const seen = new Set();
      // 只取助手消息子树里的链接。取不到就退回整页（DeepSeek 改版时不至于全废）。
      const scope = document.querySelector('[class*="ds-markdown"]') || document.body;
      for (const a of scope.querySelectorAll('a[href]')) {
        const href = a.href;
        if (!href || !/^https?:/i.test(href)) continue;
        try { if (new URL(href).origin === location.origin) continue; } catch { continue; }
        if (href === location.href || seen.has(href)) continue;
        seen.add(href);
        links.push({ href, text: (a.innerText || '').trim() });
      }
      invoke('browser_capture', {
        payload: {
          tabId: window.__TAURI_INTERNALS__.metadata.currentWebview.label,
          url: location.href,
          title: document.title,
          text: scope.innerText || '',
          links,
        },
      });
    },
    selection: () => {
      invoke('browser_selection', {
        payload: {
          tabId: window.__TAURI_INTERNALS__.metadata.currentWebview.label,
          url: location.href,
          title: document.title,
          text: String(window.getSelection() || ''),
        },
      });
    },
  };
})();
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureLink {
    pub href: String,
    #[serde(default)]
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturePayload {
    pub tab_id: String,
    pub url: String,
    #[serde(default)]
    pub title: String,
    pub text: String,
    #[serde(default)]
    pub links: Vec<CaptureLink>,
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
    let label = label_for(&tab_id);

    if WEBVIEWS.lock().map_err(|e| e.to_string())?.contains_key(&tab_id) {
        return Ok(());
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    let webview = window
        .add_child(
            WebviewBuilder::new(label, WebviewUrl::External(parsed))
                .initialization_script(CAPTURE_SCRIPT)
                .on_navigation(|u| matches!(u.scheme(), "http" | "https")),
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
    let Some(wv) = map.get(&tab_id) else { return Ok(()) };
    wv.set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    wv.set_size(LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
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
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http/https allowed".into());
    }
    let map = WEBVIEWS.lock().map_err(|e| e.to_string())?;
    let Some(wv) = map.get(&tab_id) else { return Ok(()) };
    wv.navigate(parsed).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn browser_destroy(tab_id: String) -> Result<(), String> {
    let mut map = WEBVIEWS.lock().map_err(|e| e.to_string())?;
    if let Some(wv) = map.remove(&tab_id) {
        let _ = wv.close();
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

/// 由远程页面调用。只把内容塞进待审缓冲 —— **绝不落盘**。
#[tauri::command]
pub async fn browser_capture(app: AppHandle, payload: CapturePayload) -> Result<(), String> {
    app.emit("browser://capture", payload)
        .map_err(|e| e.to_string())
}

/// 由远程页面调用。同上。
#[tauri::command]
pub async fn browser_selection(app: AppHandle, payload: CapturePayload) -> Result<(), String> {
    app.emit("browser://selection", payload)
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 2: 写移动端 stub**

创建 `app/src-tauri/src/browser_mobile.rs`。**函数签名必须与桌面版完全一致**，这样 lib.rs 的 handler 列表不用分叉：

```rust
//! 移动端的 browser 命令 stub。
//!
//! Tauri 无法在 Android/iOS 上嵌套子 webview，所以这些命令只返回错误。
//! 保留同名同签名的原因是让 lib.rs 的 generate_handler! 列表不必条件编译，
//! 少一处 cfg 就少一处漏改的机会。

use crate::browser::CapturePayload;

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

#[tauri::command]
pub async fn browser_capture(_payload: CapturePayload) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn browser_selection(_payload: CapturePayload) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}
```

**注意**：`CapturePayload` 定义在 `browser.rs` 里，而 `browser.rs` 是桌面条件编译的。所以要把这两个结构体抽到一个**无条件编译**的小模块。在 `browser.rs` 顶部改成从共享模块引入：

创建 `app/src-tauri/src/browser_types.rs`，把 `CaptureLink` / `CapturePayload` 搬进去；`browser.rs` 和 `browser_mobile.rs` 都 `use crate::browser_types::*;`。

- [ ] **Step 3: 在 lib.rs 里声明模块并注册命令**

`app/src-tauri/src/lib.rs`，在模块声明区加：

```rust
// 内嵌浏览器。桌面走真实实现，移动端走返回错误的 stub —— 
// Tauri 无法在 Android/iOS 上嵌套子 webview。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod browser;
#[cfg(any(target_os = "android", target_os = "ios"))]
#[path = "browser_mobile.rs"]
mod browser;
mod browser_types;
```

Handler 列表加（放在 `capture_endpoint::capture_set_workspace,` 之后）：

```rust
            browser::browser_create,
            browser::browser_set_bounds,
            browser::browser_show,
            browser::browser_hide,
            browser::browser_navigate,
            browser::browser_destroy,
            browser::browser_request_capture,
            browser::browser_request_selection,
            browser::browser_capture,
            browser::browser_selection,
```

- [ ] **Step 4: 编译**

Run: `cd app/src-tauri && cargo build 2>&1 | tail -30`
Expected: 通过。若 `add_child` / `on_navigation` / `set_position` 签名对不上，按编译器的提示调整（`unstable` API 未定稿，签名与文档可能不符）。**把实际签名记录到 spec 的修订记录里**。

Run: `cd app/src-tauri && cargo check --target aarch64-linux-android 2>&1 | tail -20`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add app/src-tauri/src/browser.rs app/src-tauri/src/browser_mobile.rs app/src-tauri/src/browser_types.rs app/src-tauri/src/lib.rs
git commit -m "feat(browser): child webview skeleton with desktop/mobile split"
```

---

### Task 3: capability 隔离

**Files:**
- Create: `app/src-tauri/capabilities/browser.json`
- Read (不改): `app/src-tauri/capabilities/default.json`

- [ ] **Step 1: 建 capability 文件**

创建 `app/src-tauri/capabilities/browser.json`：

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "browser-capture",
  "description": "嵌入式浏览器 webview 的只写采集通道。绝不包含 fs / dialog / opener 或任何既有命令。",
  "local": false,
  "remote": {
    "urls": ["https://*", "http://*"]
  },
  "webviews": ["browser-*"],
  "platforms": ["macOS", "windows", "linux"],
  "permissions": ["browser:allow-capture", "browser:allow-selection"]
}
```

- [ ] **Step 2: 确认 `default.json` 没有 `remote` 字段**

Run: `grep -c '"remote"' app/src-tauri/capabilities/default.json`
Expected: `0`。**不是 0 就停下来** —— 那意味着 `fs:allow-read-file` 等能力对远程来源开放了。

- [ ] **Step 3: 编译并确认 capability 被接受**

Run: `cd app/src-tauri && cargo build 2>&1 | tail -30`
Expected: 通过。若报未知 permission（`browser:allow-capture`），说明自定义命令的 permission 标识符不对 —— 查 `app/src-tauri/gen/schemas/` 下生成的 schema 里这两个命令的实际标识符，改对为止。

- [ ] **Step 4: 提交**

```bash
git add app/src-tauri/capabilities/browser.json
git commit -m "feat(browser): narrow remote-scoped capability for capture channel"
```

---

### Task 4: P0 人工验证 —— 这是整个方案的单点

**Files:** 无代码改动。需要一个临时的调试入口。

- [ ] **Step 1: 加临时调试入口**

在 `app/src/App.vue` 的 `onMounted` 里临时加（P1 会换成正式入口）：

```ts
// TEMP P0 debug entry — replaced in P1 by the browser tab type.
if (import.meta.env.DEV) {
  (window as any).__p0OpenBrowser = async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('browser_create', {
      tabId: 'p0',
      url: 'https://chat.deepseek.com/',
      x: 300, y: 120, w: 800, h: 600,
    });
  };
  (window as any).__p0Destroy = async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('browser_destroy', { tabId: 'p0' });
  };
}
```

- [ ] **Step 2: 起应用并在 devtools 里调用**

Run: `cd app && pnpm tauri dev`
然后在 devtools 控制台执行 `__p0OpenBrowser()`。

Expected: DeepSeek 页面出现在窗口中，且**位置与传入的 x/y/w/h 一致**。

- [ ] **Step 3: 确认坐标空间**

把窗口最大化、全屏、拖动，各观察一次子 webview 的位置。

Expected: 位置相对窗口**客户区**左上角，不随窗口移动而漂移。**把实际观察结果记进 spec**（这决定 P1 的 `useBrowserBounds` 要不要减标题栏高度）。

- [ ] **Step 4: 登录并发一条消息**

在子 webview 里完成 DeepSeek 登录，发一条消息，确认能收到回复。

**这是本方案最大的单点风险。** DeepSeek 可能对非标准 webview 做风控拦截，WKWebView 上的登录滑块也可能过不去。

- [ ] 不通 → **停止整个计划**，回到 opener + capture endpoint 路线，向用户报告。
- [ ] 通了 → 继续，并在 Windows 上重跑 Step 2–4。

- [ ] **Step 5: 关闭并提交调试入口**

保留 `__p0OpenBrowser`（P1 会删），提交：

```bash
git add app/src/App.vue
git commit -m "chore(browser): temporary P0 debug entry"
```

---

### Task 5: P0 安全验证（5 项断言，全过才算过）

这一节不做完，**不许进 P1**。子 webview 会在一个 capability 里有 `fs:allow-read-file` 的窗口下加载不可信页面。

**Files:** 无代码改动（除非断言失败）。

- [ ] **Step 1: 确认 Tauri 版本含 GHSA-7gmj-67g7-phm9 的修复**

Run: `grep -A2 'name = "tauri"' app/src-tauri/Cargo.lock | head -4`
Expected: `version = "2.10.3"` 或更高。

advisory（CVE-2026-42184）标注 fixed in 2.10.3，但 affected 范围写的是 2.0–2.11.0，两者矛盾。**去 GitHub advisory 页面确认 2.10.3 确实包含该修复**；不确定就把 tauri 升到最新 2.x。修复内容是 `is_local_url()` 必须断言完整域名等于 `<protocol>.localhost`，而不是只比第一段。

- [ ] **Step 2: 准备恶意测试页**

在本地起一个静态服务器，让页面能响应 `http://asset.evil.com/` 这个主机名（改 `/etc/hosts` 把 `asset.evil.com` 指到 127.0.0.1，服务器监听 80）。

页面内容：

```html
<!doctype html>
<meta charset="utf-8">
<title>probe</title>
<pre id="out">running…</pre>
<script>
(async () => {
  const out = document.getElementById('out');
  const log = (m) => { out.textContent += '\n' + m; };
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) { log('NO IPC at all (good)'); return; }
  const probes = [
    ['read_file',  { path: '/etc/hosts' }],
    ['list_dir',   { path: '/' }],
    ['browser_capture', { payload: { tabId: 'p0', url: location.href, title: 'x', text: 'probe', links: [] } }],
  ];
  for (const [cmd, args] of probes) {
    try { const r = await invoke(cmd, args); log(cmd + ' => ALLOWED ' + JSON.stringify(r).slice(0, 80)); }
    catch (e) { log(cmd + ' => denied: ' + String(e).slice(0, 120)); }
  }
})();
</script>
```

- [ ] **Step 3: 跑断言 —— 在浏览器 tab 里导航到 `http://asset.evil.com/`**

用 `__p0OpenBrowser()` 打开，然后在 devtools 里 `invoke('browser_navigate', { tabId: 'p0', url: 'http://asset.evil.com/' })`。

Expected（这是**失败**的表现，说明有漏洞）：
- `read_file => ALLOWED` 或 `list_dir => ALLOWED`

Expected（**通过**）：
- `read_file => denied`
- `list_dir => denied`
- `browser_capture => ALLOWED`（返回 null，无报错）

**任何一条 read_file/list_dir 是 ALLOWED，立刻停止，向用户报告 —— 这是能读走整个 vault 的漏洞。**

- [ ] **Step 4: 断言 `on_navigation` 拦住了本地 scheme**

Run（devtools）：
```js
await invoke('browser_navigate', { tabId: 'p0', url: 'tauri://localhost/' })
```
Expected: 子 webview **不跳转**，仍停在原页面。

```js
await invoke('browser_navigate', { tabId: 'p0', url: 'asset://localhost/' })
```
Expected: 同上，不跳转。

- [ ] **Step 5: 断言 capability 隔离是双向的**

Run（**主窗口**的 devtools，不是子 webview）：
```js
await invoke('browser_capture', { payload: { tabId: 'x', url: '', title: '', text: '', links: [] } })
```
Expected: **被拒**（`local: false` 意味着这个 capability 不适用于 app 自身来源）。若这里成功了，说明 capability 的 `local` 字段没生效，需要修正。

- [ ] **Step 6: 记录结果并提交**

把 5 项断言的实测结果追加到 spec 的"安全"一节，然后：

```bash
git add docs/superpowers/specs/2026-10-03-embedded-browser-capture-design.md
git commit -m "docs: record P0 security probe results"
```

---

# P1 — Tab 集成（无需 P0 之外的新技术验证）

### Task 6: `Tab.kind` + tabs store 支持浏览器 tab

**Files:**
- Modify: `app/src/types.ts`（`Tab` 接口，~21-40 行）
- Modify: `app/src/stores/tabs.ts`（`newTab` 之后加 `newBrowserTab`）
- Test: `app/src/lib/tab-kind.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

创建 `app/src/lib/tab-kind.test.ts`：

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isBrowserTab, isFileTab } from './tab-kind.ts';

test('kind 缺省视为文件 tab（向后兼容持久化数据）', () => {
  assert.equal(isBrowserTab({}), false);
  assert.equal(isFileTab({}), true);
});

test('kind: browser 被识别', () => {
  assert.equal(isBrowserTab({ kind: 'browser' }), true);
  assert.equal(isFileTab({ kind: 'browser' }), false);
});

test('kind: file 显式声明也被识别', () => {
  assert.equal(isBrowserTab({ kind: 'file' }), false);
  assert.equal(isFileTab({ kind: 'file' }), true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd app && node --test src/lib/tab-kind.test.ts`
Expected: FAIL —— `Cannot find module './tab-kind.ts'`

- [ ] **Step 3: 实现**

创建 `app/src/lib/tab-kind.ts`：

```ts
/**
 * 浏览器 tab 与文件 tab 的判别。
 *
 * `kind` 是可选的：老版本持久化下来的 tab 没有这个字段，必须当作文件 tab，
 * 否则升级后用户的每个标签页都会变成一片空白的浏览器面板。
 *
 * 抽成独立模块而不是内联判断，是为了让判别逻辑可单测 —— 这个函数在
 * 保存、关闭、工作区切换、会话恢复四个地方都要用，写错一处就是数据丢失。
 */
import type { Tab } from '../types';

type KindCarrier = Pick<Tab, 'kind'> | { kind?: 'file' | 'browser' };

export function isBrowserTab(tab: KindCarrier): boolean {
  return tab.kind === 'browser';
}

export function isFileTab(tab: KindCarrier): boolean {
  return tab.kind !== 'browser';
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd app && node --test src/lib/tab-kind.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 扩 `Tab` 接口**

`app/src/types.ts`，在 `showOutline?: boolean;` 之后加：

```ts
  /** 缺省（undefined）即文件 tab。浏览器 tab 永不 dirty、永不落盘。 */
  kind?: 'file' | 'browser';
  /** 仅浏览器 tab：当前地址。 */
  url?: string;
  /** 仅浏览器 tab：采集产物的目标目录，绝对路径。 */
  captureDir?: string;
```

- [ ] **Step 6: 加 `newBrowserTab` action**

`app/src/stores/tabs.ts`，在 `newTab` action 之后加：

```ts
    /**
     * 开一个内嵌浏览器 tab。与 newTab 的区别：永不 dirty、无 filePath、
     * 内容为空，原生子 webview 由 stores/browser.ts 按 tabs 的 diff 创建。
     */
    newBrowserTab(opts: { url: string; captureDir: string; title?: string }) {
      const tab: Tab = {
        id: newId(),
        kind: 'browser',
        url: opts.url,
        captureDir: opts.captureDir,
        fileName: opts.title ?? 'DeepSeek',
        content: '',
        savedContent: '',
        encoding: 'UTF-8',
        language: 'plaintext',
        hadBom: false,
      };
      this.tabs.push(tab);
      this.activeId = tab.id;
      return tab;
    },
```

- [ ] **Step 7: 跑测试 + 编译**

Run: `cd app && node --test src/lib/tab-kind.test.ts && npx vue-tsc --noEmit 2>&1 | tail -20`
Expected: 测试 PASS，类型检查无新错误。

- [ ] **Step 8: 提交**

```bash
git add app/src/types.ts app/src/stores/tabs.ts app/src/lib/tab-kind.ts app/src/lib/tab-kind.test.ts
git commit -m "feat(tabs): browser tab kind"
```

---

### Task 7: 保存 / 关闭 / 工作区切换的 guard

**Files:**
- Modify: `app/src/composables/useFiles.ts`（`saveActive`、`saveTab`、`closeTabSafe`）
- Modify: `app/src/stores/tabs.ts`（`onWorkspaceSwitched`，~433 行）
- Test: `app/src/lib/browser-tab-guards.test.ts`（新建）

不做这一步的后果：Ctrl+S 弹另存为对话框、关闭 tab 时原生 webview 泄漏并继续绘制、切换工作区静默丢掉所有浏览器 tab。

- [ ] **Step 1: 写失败测试**

创建 `app/src/lib/browser-tab-guards.test.ts`。把三个判定抽成纯函数再测：

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldSaveTab, shouldPromptOnClose, shouldCarryAcrossWorkspace } from './browser-tab-guards.ts';

test('浏览器 tab 不参与保存', () => {
  assert.equal(shouldSaveTab({ kind: 'browser', content: 'x', savedContent: '' }), false);
  assert.equal(shouldSaveTab({ kind: 'file', content: 'x', savedContent: '' }), true);
  assert.equal(shouldSaveTab({ content: 'x', savedContent: '' }), true);
});

test('浏览器 tab 关闭时不弹脏数据确认', () => {
  assert.equal(shouldPromptOnClose({ kind: 'browser', content: 'x', savedContent: '' }), false);
  assert.equal(shouldPromptOnClose({ content: 'x', savedContent: '' }), true);
  assert.equal(shouldPromptOnClose({ content: 'x', savedContent: 'x' }), false);
});

test('浏览器 tab 跨工作区保留', () => {
  assert.equal(shouldCarryAcrossWorkspace({ kind: 'browser', content: '', savedContent: '' }), true);
  assert.equal(shouldCarryAcrossWorkspace({ content: 'x', savedContent: '' }), true);   // dirty 文件
  assert.equal(shouldCarryAcrossWorkspace({ content: 'x', savedContent: 'x' }), false); // 干净文件
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd app && node --test src/lib/browser-tab-guards.test.ts`
Expected: FAIL —— `Cannot find module`

- [ ] **Step 3: 实现**

创建 `app/src/lib/browser-tab-guards.ts`：

```ts
/**
 * 浏览器 tab 在三条容易漏的路径上的行为。
 *
 * 每一条漏掉都对应一个具体故障：
 *   - shouldSaveTab:          Ctrl+S 在浏览器 tab 上弹"另存为"对话框
 *   - shouldPromptOnClose:    关闭时不弹脏确认 → 原生 webview 泄漏且继续绘制
 *   - shouldCarryAcrossWorkspace: 切换工作区把它当"干净文件"丢掉
 *
 * 浏览器 tab 永不 dirty（content 与 savedContent 都是空串），所以靠 dirty
 * 判断的既有逻辑**恰好**不误伤，但也**恰好**漏掉后两条。
 */
import { isBrowserTab } from './tab-kind.ts';

type Guardable = { kind?: 'file' | 'browser'; content: string; savedContent: string };

/** 浏览器 tab 没有可保存的内容，任何保存路径都必须短路。 */
export function shouldSaveTab(tab: Guardable): boolean {
  return !isBrowserTab(tab);
}

/** 关闭前是否需要弹脏数据确认。浏览器 tab 没有未保存内容，不该被打断。 */
export function shouldPromptOnClose(tab: Guardable): boolean {
  if (isBrowserTab(tab)) return false;
  return tab.content !== tab.savedContent;
}

/**
 * 切工作区时是否保留。浏览器 tab 与工作区无关（captureDir 存的是绝对路径，
 * 跨工作区仍然有效），必须显式保留，否则会被当成"无 filePath 的干净 tab"丢掉。
 */
export function shouldCarryAcrossWorkspace(tab: Guardable): boolean {
  if (isBrowserTab(tab)) return true;
  return tab.content !== tab.savedContent;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd app && node --test src/lib/browser-tab-guards.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 接到真实调用点**

`app/src/composables/useFiles.ts`：

- `saveActive()` 开头：`if (tab && !shouldSaveTab(tab)) return;`
- `saveTab()` 开头：`if (!shouldSaveTab(tab)) return;`
- `closeTabSafe()` 里原本判断 dirty 的地方，换成 `shouldPromptOnClose(tab)`

`app/src/stores/tabs.ts` 的 `onWorkspaceSwitched`（~433 行）：把 `tabs.filter(isDirty)` 换成 `tabs.filter(shouldCarryAcrossWorkspace)`。

命令面板里的 `file.save` / `file.saveAs` 走的是同一批函数，Step 5 的改动自动覆盖。

- [ ] **Step 6: 编译并手动验证**

Run: `cd app && npx vue-tsc --noEmit 2>&1 | tail -20`
Expected: 无新错误。

Run: `cd app && pnpm tauri dev`
手动验证：开一个浏览器 tab（可用 `__p0OpenBrowser` 的正式替代，见 Task 9），按 Ctrl+S —— Expected: 什么都不发生，无对话框。

- [ ] **Step 7: 提交**

```bash
git add app/src/lib/browser-tab-guards.ts app/src/lib/browser-tab-guards.test.ts app/src/composables/useFiles.ts app/src/stores/tabs.ts
git commit -m "fix(tabs): browser tabs must not hit save, dirty-prompt, or workspace-switch paths"
```

---

### Task 8: `stores/browser.ts` —— 生命周期与边界同步的归属

**Files:**
- Create: `app/src/stores/browser.ts`
- Test: `app/src/lib/browser-lifecycle.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

把"tab 列表 diff → 该创建哪些、该销毁哪些"抽成纯函数：

创建 `app/src/lib/browser-lifecycle.test.ts`：

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diffBrowserTabs } from './browser-lifecycle.ts';

const b = (id: string) => ({ id, kind: 'browser' as const });
const f = (id: string) => ({ id, kind: 'file' as const });

test('新增浏览器 tab → create', () => {
  assert.deepEqual(diffBrowserTabs([], [b('a')]), { create: ['a'], destroy: [] });
});

test('关闭浏览器 tab → destroy', () => {
  assert.deepEqual(diffBrowserTabs([b('a')], []), { create: [], destroy: ['a'] });
});

test('文件 tab 的增减不触发任何 webview 动作', () => {
  assert.deepEqual(diffBrowserTabs([f('x')], [f('y')]), { create: [], destroy: [] });
});

test('kind 缺省的文件 tab 不会被误判成浏览器 tab', () => {
  assert.deepEqual(diffBrowserTabs([], [{ id: 'z' }]), { create: [], destroy: [] });
});

test('混合场景', () => {
  assert.deepEqual(diffBrowserTabs([b('a'), f('x')], [b('b'), f('y')]), {
    create: ['b'],
    destroy: ['a'],
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd app && node --test src/lib/browser-lifecycle.test.ts`
Expected: FAIL —— `Cannot find module`

- [ ] **Step 3: 实现**

创建 `app/src/lib/browser-lifecycle.ts`：

```ts
/**
 * tabs 列表前后两帧的差异 → 原生子 webview 该创建谁、该销毁谁。
 *
 * 之所以用 diff 而不是在 closeTab / newBrowserTab 里直接调命令：tab 列表
 * 有九条改动路径（新建、关闭、会话恢复、工作区切换、批量关闭、窗口关闭…），
 * 每一处都手写一次 invoke 必然漏。盯 diff 是唯一能覆盖全路径的位置。
 *
 * 会话恢复也走这里 —— 从 localStorage 恢复出 kind==='browser' 的 tab 时，
 * 第一帧 diff 就会为它 create，不需要额外的恢复分支。
 */
import { isBrowserTab } from './tab-kind.ts';

type IdLike = { id: string; kind?: 'file' | 'browser' };

export function diffBrowserTabs(
  prev: readonly IdLike[],
  next: readonly IdLike[],
): { create: string[]; destroy: string[] } {
  const prevIds = new Set(prev.filter(isBrowserTab).map((t) => t.id));
  const nextIds = new Set(next.filter(isBrowserTab).map((t) => t.id));

  const create: string[] = [];
  const destroy: string[] = [];
  for (const id of nextIds) if (!prevIds.has(id)) create.push(id);
  for (const id of prevIds) if (!nextIds.has(id)) destroy.push(id);
  return { create, destroy };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd app && node --test src/lib/browser-lifecycle.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 写 store**

创建 `app/src/stores/browser.ts`：

```ts
/**
 * 内嵌浏览器的前端状态与原生 webview 生命周期。
 *
 * 这个 store 是 tabs 列表的唯一观察者 —— 所有 webview 的创建/销毁都从
 * 这里的 diff 触发，别处不要直接调 browser_create / browser_destroy。
 */
import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { useTabsStore } from './tabs';
import { diffBrowserTabs } from '../lib/browser-lifecycle.ts';

export interface CaptureLink {
  href: string;
  text: string;
}

export interface CapturePayload {
  tabId: string;   // 这是 webview label，形如 browser-<tabId>
  url: string;
  title: string;
  text: string;
  links: CaptureLink[];
}

interface BrowserState {
  /** 每个 tab 的页面标题与加载态，用于 tab 栏显示。 */
  meta: Record<string, { title?: string; url?: string; loading: boolean }>;
  /** 待用户审阅的采集结果。key 是 tabId。 */
  pending: Record<string, CapturePayload | null>;
  /** 选中片段模式的结果。 */
  selection: Record<string, string>;
}

let unlisten: UnlistenFn[] = [];
let stopWatch: (() => void) | null = null;

export const useBrowserStore = defineStore('browser', {
  state: (): BrowserState => ({ meta: {}, pending: {}, selection: {} }),

  actions: {
    /** 从 App.vue 的 setup 调一次。幂等。 */
    async start() {
      if (stopWatch) return;
      const tabs = useTabsStore();

      stopWatch = tabs.$subscribe((_m, state) => {
        void this.syncWebviews(state.tabs);
      }).__stop ?? null;

      unlisten.push(
        await listen<CapturePayload>('browser://capture', (e) => {
          const tabId = e.payload.tabId.replace(/^browser-/, '');
          this.pending = { ...this.pending, [tabId]: e.payload };
        }),
        await listen<CapturePayload>('browser://selection', (e) => {
          const tabId = e.payload.tabId.replace(/^browser-/, '');
          this.selection = { ...this.selection, [tabId]: e.payload.text };
        }),
      );
    },

    stop() {
      if (stopWatch) stopWatch();
      stopWatch = null;
      for (const fn of unlisten) fn();
      unlisten = [];
    },

    async syncWebviews(nextTabs: { id: string; kind?: 'file' | 'browser'; url?: string }[]) {
      const prev = this._seen ?? [];
      const { create, destroy } = diffBrowserTabs(prev, nextTabs);

      for (const id of destroy) {
        await invoke('browser_destroy', { tabId: id }).catch(() => {});
        const { [id]: _p, ...restPending } = this.pending;
        const { [id]: _s, ...restSel } = this.selection;
        this.pending = restPending;
        this.selection = restSel;
      }
      for (const id of create) {
        const tab = nextTabs.find((t) => t.id === id);
        if (!tab?.url) continue;
        // 尺寸先给 0，Task 10 的 useBrowserBounds 挂载后会立刻纠正。
        await invoke('browser_create', {
          tabId: id, url: tab.url, x: 0, y: 0, w: 0, h: 0,
        }).catch(() => {});
      }
      this._seen = nextTabs.map((t) => ({ id: t.id, kind: t.kind }));
    },

    /** 由 useBrowserBounds 调用。 */
    async setBounds(tabId: string, x: number, y: number, w: number, h: number) {
      await invoke('browser_set_bounds', { tabId, x, y, w, h }).catch(() => {});
    },

    async show(tabId: string) { await invoke('browser_show', { tabId }).catch(() => {}); },
    async hide(tabId: string) { await invoke('browser_hide', { tabId }).catch(() => {}); },
    async navigate(tabId: string, url: string) { await invoke('browser_navigate', { tabId, url }); },
    async requestCapture(tabId: string) { await invoke('browser_request_capture', { tabId }); },
    async requestSelection(tabId: string) { await invoke('browser_request_selection', { tabId }); },
    clearPending(tabId: string) { this.pending = { ...this.pending, [tabId]: null }; },
  },

  /** 上一帧的 tab 形状。放最后避免被当成 state 初始化。 */
  _seen: [] as { id: string; kind?: 'file' | 'browser' }[],
});
```

- [ ] **Step 6: 编译并手动验证会话恢复**

Run: `cd app && npx vue-tsc --noEmit 2>&1 | tail -20`
Expected: 无新错误。

手动：开一个浏览器 tab → 退出应用 → 重开。Expected: 浏览器 tab 恢复，且 webview 被重新创建（不是一片空白）。

- [ ] **Step 7: 提交**

```bash
git add app/src/stores/browser.ts app/src/lib/browser-lifecycle.ts app/src/lib/browser-lifecycle.test.ts
git commit -m "feat(browser): store owning webview lifecycle via tab diff"
```

---

### Task 9: `PaneContent` 分支 + 工具栏 + 文件树入口

**Files:**
- Modify: `app/src/components/PaneContent.vue`
- Create: `app/src/components/BrowserToolbar.vue`
- Modify: `app/src/components/FileTree.vue`（ctx menu，~2011 行）

- [ ] **Step 1: `PaneContent` 最先判断 browser tab**

`app/src/components/PaneContent.vue`：

在 `<script setup>` 里加：

```ts
import BrowserToolbar from './BrowserToolbar.vue';
import { isBrowserTab } from '../lib/tab-kind.ts';
import { useBrowserStore } from '../stores/browser';

const browser = useBrowserStore();
const isBrowser = computed(() => !!props.tab && isBrowserTab(props.tab));
```

**关键**：`showEditor` / `showPreview` 两个 computed 都要加 `!isBrowser.value &&` 作为第一个条件。模板里的编辑器/预览分支外面包 `<template v-if="!isBrowser">`，另加：

```vue
<template v-else>
  <BrowserToolbar :tab="tab!" />
  <!-- 原生子 webview 覆盖在这个 div 上。
       这个 div 必须始终存在且可见：它是 useBrowserBounds 的测量锚点，
       一旦被 v-if 摘掉，webview 就失去位置来源。 -->
  <div class="pane__browser-anchor" ref="browserAnchor" />
</template>
```

- [ ] **Step 2: 写工具栏**

创建 `app/src/components/BrowserToolbar.vue`。最小实现——**不做书签/历史/下载**：

```vue
<script setup lang="ts">
import { ref, watch } from 'vue';
import type { Tab } from '../types';
import { useBrowserStore } from '../stores/browser';

const props = defineProps<{ tab: Tab }>();
const browser = useBrowserStore();

const address = ref(props.tab.url ?? '');
watch(() => props.tab.url, (u) => { if (u) address.value = u; });

function go() {
  const raw = address.value.trim();
  if (!raw) return;
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  void browser.navigate(props.tab.id, url);
}
function capture() { void browser.requestCapture(props.tab.id); }
</script>

<template>
  <div class="browser-toolbar">
    <input
      v-model="address"
      class="browser-toolbar__addr"
      spellcheck="false"
      @keydown.enter.prevent="go"
    />
    <button class="browser-toolbar__btn" @click="capture">
      {{ $t('browser.capture') || '采集对话' }}
    </button>
  </div>
</template>
```

- [ ] **Step 3: 文件树右键入口**

`app/src/components/FileTree.vue`，在 ctx menu 模板里，`<template v-if="!ctx.node || ctx.node.is_dir">` 那一块**之后**加（只在目录上出现，且桌面才显示 —— Wayland 和移动端不支持）：

```vue
<button
  v-if="ctx.node?.is_dir && browserSupported()"
  class="ftree__ctx-item"
  @click="openKnowledgeBrowser(ctx.node)"
>
  🔎 {{ t('explorer.knowledgeSearch') || '知识检索' }}
</button>
```

在 `<script setup>` 里加：

```ts
import { useTabsStore } from '../stores/tabs';
import { browserSupported } from '../lib/platform';
import { invoke } from '@tauri-apps/api/core';

const tabs = useTabsStore();

async function openKnowledgeBrowser(node: Node) {
  // 目录节点的绝对路径 —— captureDir 要绝对路径，跨工作区切换才仍然有效。
  const abs = await invoke<string>('fs_join_workspace', { path: node.path }).catch(() => '');
  tabs.newBrowserTab({
    url: 'https://chat.deepseek.com/',
    captureDir: abs,
    title: 'DeepSeek',
  });
  ctx.value = null;
}
```

若 `fs_join_workspace` 不存在，用 `root.path` 拼 `node.path`（`FileTree` 已有 `root` ref）。

- [ ] **Step 4: `browserSupported()` 平台判断**

`app/src/lib/platform.ts` 加：

```ts
/**
 * 内嵌浏览器是否可用。
 *
 * 三处不支持：
 *   - 移动端：Tauri 无法嵌套子 webview（browser.rs 在那边是返回错误的 stub）
 *   - Linux/Wayland：wry 的 build_as_child 仅支持 X11，Wayland 上报
 *     "the window handle kind is not supported"
 *   - App Store 构建：见 spec 的 App Store 一节，整个入口可能要隐藏
 */
export function browserSupported(): boolean {
  if (isMobile()) return false;
  if (isLinux() && isWayland()) return false;
  return true;
}
```

`isLinux()` / `isWayland()` 按现有 platform.ts 的风格实现（Wayland 判断用 `!!(navigator as any).userAgentData?.platform` 不可靠，实际要用 Tauri 侧探测 `WAYLAND_DISPLAY` 环境变量并通过一个命令暴露；**先用一个 `browser_platform_supported()` 命令返回布尔值，前端只管调用**）。

- [ ] **Step 5: 删掉 P0 的临时入口**

从 `app/src/App.vue` 移除 `__p0OpenBrowser` / `__p0Destroy`。

- [ ] **Step 6: 手动验证**

Run: `cd app && pnpm tauri dev`
逐项验证：
- 右键目录 → 「知识检索」→ 出现浏览器 tab，DeepSeek 加载
- 切到别的 tab 再切回来 → webview 正确隐藏/显示
- 拖动窗口 / 最大化 → webview 跟随
- 打开左右侧栏 → webview 跟随

- [ ] **Step 7: 提交**

```bash
git add app/src/components/PaneContent.vue app/src/components/BrowserToolbar.vue app/src/components/FileTree.vue app/src/lib/platform.ts app/src/App.vue
git commit -m "feat(browser): browser tab in the pane host with file-tree entry"
```

---

### Task 10: `useBrowserBounds` + overlay 遮挡处理

**Files:**
- Create: `app/src/composables/useBrowserBounds.ts`
- Modify: `app/src/App.vue`（overlay 状态监听）

**原生子 webview 永远绘制在主 webview 的 HTML 之上。** 命令面板、设置弹窗、右键菜单、下拉框、Toast 只要打开就会被压在 webview 底下。这不是打磨项，是功能损坏。

- [ ] **Step 1: 写矩形换算的测试**

创建 `app/src/lib/browser-rect.test.ts`：

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toLogicalBounds } from './browser-rect.ts';

// 窗口内容区的原点：rect 是相对视口的，不需要再减标题栏
test('视口矩形直接转逻辑像素', () => {
  assert.deepEqual(
    toLogicalBounds({ left: 300, top: 120, width: 800, height: 600 }, 1),
    { x: 300, y: 120, w: 800, h: 600 },
  );
});

test('devicePixelRatio > 1 时仍然按 CSS 像素传（Tauri 侧用 Logical*）', () => {
  assert.deepEqual(
    toLogicalBounds({ left: 300, top: 120, width: 800, height: 600 }, 2),
    { x: 300, y: 120, w: 800, h: 600 },
  );
});

test('零尺寸（面板折叠）被识别为不可见', () => {
  assert.equal(toLogicalBounds({ left: 0, top: 0, width: 0, height: 0 }, 1), null);
});

test('负数尺寸不会传下去', () => {
  assert.equal(toLogicalBounds({ left: 0, top: 0, width: -5, height: 10 }, 1), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd app && node --test src/lib/browser-rect.test.ts`
Expected: FAIL —— `Cannot find module`

- [ ] **Step 3: 实现换算**

创建 `app/src/lib/browser-rect.ts`：

```ts
/**
 * 视口矩形 → 传给 browser_set_bounds 的逻辑像素。
 *
 * 刻意不做 devicePixelRatio 换算：Tauri 的 LogicalPosition / LogicalSize
 * 接受的就是 CSS 像素，自己再乘一遍 DPR 会在 Retina 上把 webview 放大一倍。
 * P0 的坐标空间实测结论记录在 spec 里，若实测发现需要减标题栏高度，
 * 只改这一个函数。
 */
export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function toLogicalBounds(
  rect: ViewportRect,
  _devicePixelRatio: number,
): { x: number; y: number; w: number; h: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd app && node --test src/lib/browser-rect.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 写 composable**

创建 `app/src/composables/useBrowserBounds.ts`：

```ts
/**
 * 把锚点元素的每帧矩形同步给原生子 webview。
 *
 * 触发源清单（漏一个就有一种"位置不对"的 bug）：
 *   窗口 resize / 最大化 / 全屏、左右侧栏开关、tile 分隔条拖拽、
 *   tab 切换、采集面板折叠
 *
 * 统一用 ResizeObserver + rAF 轮询而不是逐个事件挂监听：前者的覆盖更全，
 * 后者要枚举的事件会随 UI 演化不断漏。
 */
import { onBeforeUnmount, onMounted, type Ref } from 'vue';

export function useBrowserBounds(tabId: string, el: Ref<HTMLElement | null>, active: Ref<boolean>) {
  let raf = 0;
  let ro: ResizeObserver | null = null;
  let lastKey = '';

  function tick() {
    raf = requestAnimationFrame(tick);
    const node = el.value;
    if (!node) return;

    if (!active.value) {
      if (lastKey !== 'hidden') {
        lastKey = 'hidden';
        void import('../stores/browser').then(({ useBrowserStore }) =>
          useBrowserStore().hide(tabId),
        );
      }
      return;
    }

    const r = node.getBoundingClientRect();
    const key = `${r.left}|${r.top}|${r.width}|${r.height}`;
    if (key === lastKey) return;
    lastKey = key;

    void import('../lib/browser-rect.ts').then(async ({ toLogicalBounds }) => {
      const b = toLogicalBounds(r, window.devicePixelRatio);
      const { useBrowserStore } = await import('../stores/browser');
      const store = useBrowserStore();
      if (!b) { await store.hide(tabId); return; }
      await store.setBounds(tabId, b.x, b.y, b.w, b.h);
      await store.show(tabId);
    });
  }

  onMounted(() => {
    ro = new ResizeObserver(() => {});
    if (el.value) ro.observe(el.value);
    window.addEventListener('resize', onWinResize);
    raf = requestAnimationFrame(tick);
  });

  function onWinResize() { lastKey = ''; }

  onBeforeUnmount(() => {
    cancelAnimationFrame(raf);
    ro?.disconnect();
    window.removeEventListener('resize', onWinResize);
  });
}
```

在 `PaneContent.vue` 里：`useBrowserBounds(props.tab.id, browserAnchor, computed(() => isBrowser.value && isFocused.value))`

- [ ] **Step 6: overlay 遮挡处理**

在 `app/src/App.vue` 里，把"是否有浮层打开"归到一个 computed，并在其上 watch：

```ts
/**
 * 原生子 webview 永远盖在 HTML 之上，所以任何浮层打开时都必须把它藏起来，
 * 否则命令面板 / 设置 / 右键菜单 / Toast 都会被压在底下看不见。
 */
const anyOverlayOpen = computed(() =>
  commandPaletteOpen.value ||
  settingsOpen.value ||
  sidebarCtx.value !== null ||
  /* 其余模态：逐一列出，不要用 "有没有 .modal 元素" 这种启发式 */
  false,
);

watch(anyOverlayOpen, (open, wasOpen) => {
  if (open === wasOpen) return;
  for (const tab of tabs.tabs.filter(isBrowserTab)) {
    if (open) void browser.hide(tab.id);
    else void browser.show(tab.id);
  }
});
```

**注意**：右键菜单（`FileTree` 的 `ctx`、编辑器菜单等）是分散在各组件里的局部状态，App.vue 看不到。稳妥做法是给这类浮层统一加一个 `<body>` 上的 `data-solomd-overlay` 计数属性，`anyOverlayOpen` 改成观察它。**先实现为 App.vue 里已知的模态列表，把右键菜单造成的遮挡作为已知缺口记录在 spec 的"已知风险"里**，P2 再统一。

- [ ] **Step 7: 手动验证**

Run: `cd app && pnpm tauri dev`
- 打开命令面板（⌘K）→ webview 隐藏，面板可见
- 关闭 → webview 回来
- 拖 tile 分隔条 → 松手后 webview 位置正确
- 折叠侧栏 → webview 跟随变宽

- [ ] **Step 8: 提交**

```bash
git add app/src/composables/useBrowserBounds.ts app/src/lib/browser-rect.ts app/src/lib/browser-rect.test.ts app/src/components/PaneContent.vue app/src/App.vue
git commit -m "feat(browser): bounds sync and overlay occlusion handling"
```

---

# P2 — 采集通道（任务级，P0 通过后展开为完整步骤）

### Task 11: 右侧栏 Capture 面板骨架

**Files:** `app/src/components/CapturePanel.vue`（新建）、`app/src/stores/settings.ts`、`app/src/App.vue`

**契约：** 显示当前 tab 的 `pending` 采集结果（对话标题、正文预览、引用链接列表带 checkbox）；每行显示采集状态：`idle | running | ok | failed(reason)`；底部「写入」按钮。

**必须改的 8 个注册点（漏一个侧栏持久化就静默失效）：**
- `App.vue`：`visibleRsPanes` 的 `all` 记录 + `known` 数组 + 返回类型联合（~1744–1772）；`rightSidebarHasRenderablePane`（~1685）；`ctxToggle` 的 `noPanesVisible`（~258）；`rsPaneSnapshot`（~239）
- `settings.ts`：defaults（~633）、merge（~790）、save 白名单（~1022）、load 白名单（~1068）、toggle-with-ensure（~1205）

**测试：** 加一个 `capture-panel-state.test.ts`，覆盖「待审为空 / 有待审 / 采集中 / 部分失败」四种状态到 UI 文案的映射。

### Task 12: 对话与引用提取的契约实现

**Files:** `app/src/lib/deepseek-capture.ts`（新建）、测试同目录

**契约**（spec 的"对话与引用的提取契约"一节）：
- 正文：只依赖 `innerText`，不依赖 class
- 引用：仅助手消息子树、丢同源、按 href 去重、丢等于当前 URL 的
- 标题：`document.title` 去掉 ` - DeepSeek` → 首条用户消息前 30 字 → 时间戳

**测试：** 用固定的 HTML fixture 断言同源过滤、去重、标题兜底三级。

### Task 13: 落盘（`index.md` + `refs/`）

**Files:** `app/src-tauri/src/browser_capture.rs`（新建）、`app/src/stores/browser.ts`

**契约：**
- 路径：`<captureDir>/<对话标题>/index.md`、`<captureDir>/<对话标题>/refs/<序号>-<slug>.md`
- 路径穿越校验沿用 `capture_endpoint.rs::resolve_safe_workspace_path` 的做法
- 目录不存在或无写权限 → **整批中止**，不半批落盘
- 写入后调 `rag::rag_reindex_file`
- slug 生成：CJK 安全、重名加 `-2`、非法字符替换

**测试（Rust）：** slug 生成（CJK / 超长 / 重名 / 非法字符）、路径穿越拒绝、整批中止。

---

# P3 — 抓取流水线（任务级）

### Task 14: `extract-rules` 规则库

**Files:** `app/src-tauri/src/extract_rules.rs`（新建）

**契约：**
- 落盘 `extract-rules.json`，`Lazy<Mutex<..>>` 串行化读改写，临时文件 + rename 保证原子
- 命中：选择器匹配到 **且** 文本 > 300 字
- 失效：每次未命中 **`hits` 减半**；`misses >= 3 && misses > hits` → stale
- 重学成功后 `misses` 归零
- 种子：知乎、微信公众号、掘金、CSDN、Wikipedia（`source: "seed"`）

**测试（Rust）：** 命中/未命中计数、hits 减半、stale 判定、并发 `record_hit/miss` 不丢更新（用多线程跑 1000 次断言总数）。

### Task 15: `webdoc.rs` 抽取三级流水线

**Files:** `app/src-tauri/src/webdoc.rs`（新建）、`app/src-tauri/Cargo.toml`（加 `dom_smoothie`、`scraper`）、`app/src-tauri/src/convert.rs`（抽出接受 `&str` 的变体）

**契约：** 级 1 选择器 → 级 2 `dom_smoothie` → 级 3 AI（P5）；结果 < 300 字视为该级失败

**测试（Rust）：** 对固定 HTML fixture 断言标题与正文，覆盖三级降级路径。

### Task 16: 全文 / 存根两种采集模式 + 逐条状态

**Files:** `app/src/components/CapturePanel.vue`、`app/src-tauri/src/browser_capture.rs`

**测试（Rust）：** 单条失败不阻塞其余条目；失败原因回传。

---

## ⛔ P4 决策闸门

**做完 Task 16 后停下来，不要直接进 P5。**

在三个测试站点（知乎、微信公众号、一个长尾个人博客）上各采集一次，统计：
- `dom_smoothie` 独立成功的比例
- 需要人工「选中片段」兜底的比例

**若 readability 成功率 ≥ 80% → P5 的 AI 抽取层不做。** 规则库只保留种子和「选中片段」，省掉 `ai_complete_once`、选择器学习、AI 成本门控三块工作。

**若 < 80% → 继续 P5。**

把实测数字写进 spec 再决定。

---

# P5 — AI 抽取层（条件执行）

### Task 17: `ai_complete_once`

**Files:** `app/src-tauri/src/ai_proxy.rs`

**契约：** 复用现有 provider 抽象 + `get_api_key` + base_url 解析，但走**非流式**分支（现有 `run_chat_*` 全是 `"stream": true`，没有"调一次返回字符串"的 helper）。

**输入：** 不是整页 HTML —— 先 `strip_html_noise` + 去 `<svg>/<iframe>` + 去 `img` 属性，200 KB 截断，仍超限则改送正文候选文本。

**输出：** 严格 JSON `{ "title_selector", "content_selector", "remove": [] }`。解析失败 = 该级失败。选择器写入规则库前必须 `scraper::Selector::parse` 通过且在当前页匹配 > 300 字。

**测试：** mock provider 返回畸形 JSON → 降级；返回有效 JSON 但选择器匹配不到 → 不落盘。

### Task 18: 选中片段模式

**Files:** `app/src/components/BrowserToolbar.vue`、`app/src-tauri/src/browser_capture.rs`

**契约：** `browser_request_selection` → `browser://selection` 事件 → 面板显示选中文本 → 存为 `via: "selection"`。

---

# P6 — 收尾（任务级）

- Task 19: i18n（所有新字符串走 `t()`，中英双语 —— roadmap 要求每个 minor 版本都双语）
- Task 20: 文档 + Help 对话框条目
- Task 21: 种子规则校对（五个域名各实测一次）
- Task 22: 测试补齐 + `scripts/v4-self-test.sh` 加一个 browser 段
- Task 23: **App Store 策略确认** —— 内嵌通用浏览器 + 采集面板可能触发 Apple 3.1.1 审查；商店版隐藏整个入口是最省事的做法。上架前必须确认。

---

## 已知缺口（明确记录，不在本计划内解决）

1. **子 webview 的坐标空间**以 P0 Task 4 Step 3 的实测为准。若需要减标题栏高度，只改 `browser-rect.ts` 一个函数。
2. **右键菜单遮挡**：`FileTree` / 编辑器的右键菜单是各组件局部状态，App.vue 的 overlay 监听看不到。P2 统一给浮层加 `data-solomd-overlay` 计数后再接。在此之前这是已知的视觉缺陷。
3. **`__TAURI_INTERNALS__` 是内部 API**：注入脚本依赖它调命令。它随 Tauri 主版本可能变 —— 与 `unstable` webview API 是同一类风险，集中在 `CAPTURE_SCRIPT` 一个常量里便于修。
4. **Windows 未验证**：P0 的 Task 4/5 必须在 macOS 和 Windows 上各跑一遍。本计划的所有手动验证步骤都以 macOS 为例。
