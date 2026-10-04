# 内嵌浏览器 + 知识采集 — 设计

日期：2026-10-03（v2，v1 的两处关键判断已被证伪，见"修订记录"）
状态：待实现
相关：[roadmap.md](../../roadmap.md)

## 目标

在 SoloMD 里提供一个**内嵌浏览器 tab**，默认打开 DeepSeek 作为知识检索入口。用户对话后：

1. 一键采集当前对话 → 在指定目录 D 下生成 `D/<对话标题>/index.md`（对话正文 + 引用来源清单）
2. 引用清单进入右侧栏采集面板，用户勾选后按选定模式逐条抓取 → `D/<对话标题>/refs/<slug>.md`
3. 抓取到的新站点自动学习抽取策略，按域名沉淀，下次复用

## 非目标（明确不做）

- **不做浏览器 chrome 全功能**：不做书签、历史、下载管理、扩展。地址栏只做"输入网址跳转"。
- **不做移动端**：见平台矩阵。
- **不做人为的并发浏览器实例上限**：开多少 tab 就是多少个 webview。
- **不做 URL 结果缓存**：同一链接重复采集会重新抓取。
- **v1 不做用户可编辑的规则 UI**，也不做"摘要"模式：规则学习的价值要等 P4 证明 readability 不够用之后才成立（见分期）。
- **不做热门站点硬编码适配器子系统**：只预置一份种子选择器 JSON（~5 条数据）。

---

## 修订记录

### v3 —— 安全模型推倒重来（v2 的 ACL 方案在锁定版本上不成立）

读 tauri 2.10.3 源码（`crates/tauri/src/webview/mod.rs:1801`）确认：

```rust
// we only check ACL on plugin commands or if the app defined its ACL manifest
if (plugin_command.is_some() || has_app_acl_manifest)
  && request.cmd != crate::ipc::channel::FETCH_CHANNEL_DATA_COMMAND
  && invoke.acl.is_none()
```

本仓库的 `build.rs` 只调 `tauri_build::build()`，**没有 `AppManifest`**，所以 `has_app_acl_manifest == false`。**结果是：所有 app 自定义命令（含 `read_file`、`write_file`、`list_dir`）完全绕过 ACL，对本地和远程来源一视同仁。**

也就是说 v2 的 `capabilities/browser.json` **拦不住任何东西**：子 webview 里的任意远程页面可以直接调 `read_file` 读走整个 vault。这不是 CVE，是 2.10.3 的设计。

修复出现在 2.12.1（已核对源码）：门条件多了 `|| !is_local`，远程来源强制走 ACL：

```rust
if (plugin_command.is_some() || has_app_acl_manifest || !is_local)
```

**但补 `AppManifest` 是陷阱**：一旦声明，`has_app_acl_manifest` 变真，**本地来源也要过 ACL**，那就得给现有约 150 个 app 命令全部补授权。为了一个尚未验证的功能做全量迁移，代价不成比例。

因此 v3 的结论：
1. **必须把 tauri 升到 ≥2.12.1**（不升就有一个能读走 vault 的洞）。升完不加 `AppManifest`，本地来源行为不变，远程来源被拒。
2. **采集回传不走 IPC**。改为 `WebviewBuilder::on_navigation` 拦截：注入脚本把 payload 塞进一个哨兵 URL 并赋值给 `location.href`，Rust 的导航处理器识别、解析、返回 `false` 取消导航。页面不跳转、登录态不丢。
   - 不用 IPC → 不需要 capability、不需要 ACL、不需要 `AppManifest`、不需要回环 HTTP（也就绕开了 PNA）、没有 CORS、没有 URL 之外的传输限制。
   - 这是唯一一个**在 2.10.3 上就能跑、且升级后依然成立**的方案。
3. `capabilities/browser.json` **从设计中删除**。子 webview 不再需要调用任何命令。

### v2 —— 两处判断错误

v1 有两处判断错误，评审 + 独立验证后已推翻，此处保留以便追溯：

1. **v1 说"回传走 localhost HTTP，因为不能也不该给子 webview 注入 Tauri IPC"。**
   - 前半句错：Tauri **无条件**给每个 `WebviewBuilder` 创建的 webview 注入 `__TAURI_INTERNALS__`（`crates/tauri/src/manager/webview.rs` 的 `all_initialization_scripts`），没有任何公开开关可以关掉。v1 假设存在一个"不注入 IPC"的选项，实现者会白找。
   - 后半句的**保护理由是错的**，真正的边界是来源（origin），见安全一节。
   - 而且 localhost 通道本身在 Windows 上会死：Chrome 142 起默认强制 **Private Network Access / Local Network Access**，公网页面 fetch 回环地址需要 `Access-Control-Allow-Private-Network: true`，且需要浏览器权限提示（依赖 `Private-Network-Access-ID/Name` 响应头），裸子 webview 里弹不出来。v1 里"CORS 零新增工作"只对了一半——CORS 确实是现成的，但 PNA 不是 CORS。
2. **v1 说 Linux "✅ WebKitGTK"。** 错。wry 的 `build_as_child` 在 Linux 上**仅支持 X11**，Wayland 直接报 `the window handle kind is not supported`。而 Wayland 是现代发行版的默认。

---

## 前置条件

**tauri 必须升到 ≥2.12.1**，且**不加 `AppManifest`**。原因见关键决策 1 与安全一节 —— 在 2.10.3 上这个功能会附带一个能让任意网页读走整个 vault 的洞。

升级本身有风险（2.10 → 2.12 跨两个 minor），必须作为一个独立步骤先做完并跑通现有测试，再动浏览器功能。

## 平台矩阵

Tauri 的子 webview（`WebviewBuilder` + `Window::add_child`）**仅桌面可用**。Android/iOS 上 Tauri 无法把第二个 webview 嵌进主 webview 的布局，只能另开全屏 Activity，与本设计冲突。

| 平台 | 内嵌浏览器 tab | 采集面板 | 说明 |
|---|---|---|---|
| macOS | ✅ WKWebView | ✅ | 参考平台 |
| Windows | ✅ WebView2 | ✅ | 需 PNA 无关（已改走 IPC，无回环请求） |
| Linux / X11 | ✅ WebKitGTK | ✅ | |
| Linux / Wayland | ❌ | ❌ | `build_as_child` 不支持。需检测 `WAYLAND_DISPLAY` 并在 UI 隐藏入口 |
| Android / iOS | ❌ | ❌ | 见下 |

移动端需在**前端判断和 Rust 命令两侧同时设防**。`Window::add_child` 在 tauri 2.10.3 里是 `#[cfg(any(test, all(desktop, feature = "unstable")))]`，因此 `browser.rs` 整体必须 `#[cfg(desktop)]`，移动端提供返回错误的 stub 模块——沿用 Cargo.toml 里 window-state / global-shortcut / trash 的既有模式。不做这层门禁，Android/iOS 目标直接编译失败。

---

## 架构

```
┌─ 主窗口 ─────────────────────────────────────────────┐
│  FileTree │  PaneHost (tabs)              │ 右侧栏     │
│           │  ┌─ 普通 tab: Editor/Preview   │ ├ Outline  │
│           │  └─ browser tab:             │ ├ Backlinks│
│           │     ┌──────────────────────┐  │ ├ Capture  │ ← 新增 pane
│           │     │ BrowserToolbar (Vue) │  │ └ ...      │
│           │     ├──────────────────────┤  │            │
│           │     │ 原生子 webview 覆盖区  │  │            │
│           │     └──────────────────────┘  │            │
│           └──────────────────────────────┴────────────┘
└───────────────────────────────────────────────────────┘
        │ invoke                    ▲ event
        ▼                           │
┌─ Rust ────────────────────────────┴───────────────────┐
│ browser.rs      子 webview 生命周期 / 注入脚本 / 导航白名单│
│ webdoc.rs       URL → 正文 markdown 三级流水线          │
│ extract_rules.rs 域名选择器库（读写 / 命中失效）         │
└───────────────────────────────────────────────────────┘
```

### 关键决策 1：回传走 `on_navigation` 拦截，不用 IPC

**不用 IPC**（v2 的 capability 方案在 2.10.3 上拦不住任何东西，见修订记录）。
**不用 localhost HTTP**（Chrome 142+ 的 PNA，见 v2 修订记录）。

注入脚本把 payload 编码进一个哨兵 URL：

```js
const CHUNK = 200_000;
const encoded = encodeURIComponent(JSON.stringify(payload));
for (let i = 0, n = 0; i < encoded.length; i += CHUNK, n++) {
  location.href = `https://solomd.invalid/capture/${n}#${encoded.slice(i, i + CHUNK)}`;
}
```

Rust 侧在 `on_navigation` 里识别 `solomd.invalid`，解码、拼接、发事件给主窗口，**返回 `false` 取消导航**。

为什么是它：

| | IPC + capability | localhost HTTP | **`on_navigation`** |
|---|---|---|---|
| 2.10.3 上可用 | ❌ ACL 不拦 app 命令 | ✅ | ✅ |
| 需要 `AppManifest` | ✅（触发全量迁移） | ❌ | ❌ |
| Windows 可用 | ✅ | ❌ PNA | ✅ |
| 需要新 capability | ✅ | ❌ | ❌ |
| 页面能调到的能力 | 两个命令 | 一个 HTTP 路由 | **无** |

`on_navigation` 是唯一一个**在锁定版本上就能跑、且升级后依然成立**的方案。子 webview 因此不需要调用任何命令，capability 文件从设计中删除。

**已知限制**：payload 走 URL，受导航 URL 长度约束。按 200 KB 分片，普通对话（几十 KB）单片即可。**P0 必须实测单片上限**；若单次导航放不下，分片循环已经写好；若分片之间导航被合并（浏览器可能折叠同一 tick 内的多次 `location.href` 赋值），则在每片之间插入 `await new Promise(r => setTimeout(r, 30))`。

**哨兵 host 必须是不能真正解析的域名**（`solomd.invalid` 是 RFC 2606 保留域名）。若 `on_navigation` 因平台差异没有拦住，页面会去请求一个不存在的域名 —— 表现为一次失败的导航，而不是把 payload 发到互联网上。

### 关键决策 2：捕获先入内存缓冲，用户确认后才落盘

`on_navigation` 收到的哨兵 URL 只解码进**按 tabId 索引的内存缓冲**，不碰文件系统。用户在右侧栏审阅后才点「写入」。

这是第 1 层安全防线：即使某个页面能伪造哨兵 URL，它拿到的最坏结果是"污染一个待审列表"，无法向 vault 写任意文件。这也顺带满足了"先看再存"的产品需求。

### 关键决策 3：`on_navigation` 一个处理器干两件事

`on_navigation` 同时承担回传和放行：

```
url.host == "solomd.invalid"  → 解析采集 payload，发事件，return false   // 回传
url.scheme ∈ {http, https}    → return true                              // 正常浏览
其他一切（tauri:// / asset:// / file:// / 自定义 scheme）→ return false    // 拦截
```

白名单那一半针对 **CVE-2026-42184 / GHSA-7gmj-67g7-phm9**：Windows/Android 上 `Webview::is_local_url()` 只取域名第一段，`http://asset.evil.com/` 会被误判为 Local 来源。SoloMD 开了 `assetProtocol`，`default.json` 又给 `windows: ["main"]` 发了 `fs:allow-read-file`（`**` 范围），而子 webview 正是 `main` 窗口的子 webview。

注意：**`browser_navigate` 命令里也要独立做同样的 scheme 校验**，不能只依赖 `on_navigation` —— 否则前端传什么就导航什么，把浏览器变成一个能加载本地协议的东西。两处都要挡。

### 关键决策 4：抽取三级流水线，前级命中即停

| 级 | 手段 | 成本 | 命中场景 |
|---|---|---|---|
| 1 | `extract_rules` 里该域名的 CSS 选择器 | ~0 | 复访站点 |
| 2 | `dom_smoothie`（Mozilla Readability 的 Rust 移植） | ~0，离线 | 大多数文章页 |
| 3 | AI 抽取（需新建一次性调用helper，见下） | 1 次调用 | 兜底 |

第 3 级成功时同轮要求 AI 额外输出 CSS 选择器，写入规则库，下次该域名走第 1 级。

---

## 数据模型

### Tab（前端）

`types.ts` 的 `Tab` 增加两个可选字段，保持向后兼容（缺失即文件 tab）：

```ts
export interface Tab {
  // ...既有字段不变
  kind?: 'file' | 'browser';  // 缺省 'file'
  url?: string;               // 仅 browser tab
  captureDir?: string;        // 仅 browser tab，绝对路径
}
```

browser tab 的其他字段取安全缺省：`content: ''`、`savedContent: ''`、`language: 'plaintext'`、`hadBom: false`。

**必须显式加 guard 的代码点**（不是"应该"，是"不改就出 bug"）：

| 位置 | 现状 | 症状 |
|---|---|---|
| `saveActive()` / `saveTab()`（useFiles.ts） | 无 `filePath` 时走 `saveTabAs` | Ctrl+S 弹另存为对话框 |
| 命令面板的 `file.save` / `file.saveAs` | 同上 | 同上 |
| `useFiles.ts` 的 `closeTabSafe` | 只在 dirty 时弹窗 | browser tab 永不 dirty，直接关 → **webview 泄漏并继续绘制** |
| `autoSaveDirtyTabs` | 靠 dirty 判断 | 恰好安全，无需改 |

### Tab 生命周期（需要明确归属）

`tabs.ts` 只负责数组增删，**原生 webview 的创建/销毁必须由 `stores/browser.ts` 监听 `tabs.tabs` 的 diff 来驱动**。触发点：

| 事件 | 动作 |
|---|---|
| 新建 browser tab | `browser_create(tabId, url)` |
| 会话恢复（`loadPersisted` 恢复出 `kind === 'browser'` 的 tab） | `browser_create` —— v1 遗漏，恢复出来的 tab 会是个空白锚点 |
| 关闭 tab | `browser_destroy(tabId)` |
| 切换工作区 | 见下 |
| 应用退出 | `browser_destroy` 全部 |

**工作区切换**：`tabs.ts` 的 `onWorkspaceSwitched` 目前只把 dirty tab 带过去（~444 行），browser tab 永不 dirty 且无 `filePath`，会被静默丢弃并泄漏 webview。但它和文件 tab 一样属于"用户开着的东西"，且 `captureDir` 存的是绝对路径，跨工作区仍然有效——**修改为显式保留 `kind === 'browser'` 的 tab**。

### 抽取规则（Rust，落盘）

位置：app data dir 下 `extract-rules.json`。

```jsonc
{
  "version": 1,
  "rules": {
    "zhihu.com": {
      "content": ".Post-RichTextContainer",
      "title": "h1",
      "remove": [".Recommendations", ".CommentsContainer"],
      "source": "seed",          // seed | ai | user
      "hits": 12,
      "misses": 1,
      "updatedAt": 1759459200
    }
  }
}
```

**命中判定**：选择器匹配到 **且** 提取文本 > 300 字。

**失效判定**（v1 的 `misses > 3 && misses > hits` 在 `hits` 单调不归零时几乎不可达——攒了 12 次命中后需要 13 次连续未命中才失效）：改为**每次未命中时 `hits` 减半**，当 `misses >= 3 && misses > hits` 时标记 stale，下次该域名走第 3 级重学；重学成功后 `misses` 归零。

**并发**：多条目并行抽取会对同一个 `extract-rules.json` 做读-改-写。用 `once_cell::sync::Lazy<Mutex<..>>` 串行化（沿用 `capture_endpoint.rs` 的 `STATE` 模式），写入用临时文件 + rename 保证原子性。

预置种子（`source: "seed"`）：知乎、微信公众号、掘金、CSDN、Wikipedia。

### 笔记布局

右键目录 D（绝对路径存进该 tab 的 `captureDir`）：

```
D/
└── <对话标题>/
    ├── index.md
    └── refs/
        ├── 001-<slug>.md
        └── 002-<slug>.md
```

`captureDir` **按 tabId 存**，不是全局单值——两个浏览器 tab 各自属于不同对话、不同目录，全局值会互相覆盖。

`index.md`：

```markdown
---
title: <对话标题>
source: deepseek
url: https://chat.deepseek.com/...
captured: 2026-10-03T12:34:56+08:00
---

<对话正文>

## 引用来源

1. [标题](url)
2. [标题](url)
```

`refs/<slug>.md`：

```markdown
---
title: <页面标题>
url: <原始链接>
domain: zhihu.com
captured: 2026-10-03T12:35:10+08:00
via: selector | readability | ai | selection | stub
---

<正文 markdown>
```

slug 由链接文字或 URL path 生成，CJK 安全，重名加 `-2` 后缀。

### 采集模式

`CaptureMode`：`Full`（全文）/ `Stub`（仅存根）/ `Selection`（选中片段）。

`Summary`（AI 摘要）**移出 v1**——它引入第二次 AI 调用、另一套成本门控，而价值未经验证。

**Selection 模式**对应 `browser_selection` 命令：在子 webview 里 eval `window.getSelection().toString()` 并回传，配 `via: "selection"`。这是反爬站点的兜底路径（知乎/公众号 `reqwest` 直取会失败，但用户在已渲染的 webview 里手动选中总能拿到内容）。

---

## 模块

### Rust：`src/browser.rs`（整体 `#[cfg(desktop)]`）

```rust
browser_create(tab_id: String, url: String, capture_dir: String) -> Result<(), String>
browser_set_bounds(tab_id: String, x: f64, y: f64, w: f64, h: f64)  // 逻辑像素
browser_show(tab_id: String) / browser_hide(tab_id: String)
browser_navigate(tab_id: String, url: String)   // 内部重复 scheme 校验
browser_reload(tab_id: String)
browser_destroy(tab_id: String)
browser_request_capture(tab_id: String)     // eval 页面内已注入的采集函数
browser_request_selection(tab_id: String)   // eval 取 window.getSelection()
```

**没有 `browser_capture` / `browser_selection` 命令** —— 子 webview 不调任何命令（见关键决策 1）。所有命令都只由本地主窗口调用。

不做 `browser_back` / `browser_forward`：初始版本没有历史栈 UI，加这两个命令等于加两个没人调的东西。

事件：`browser://capture {tabId,payload}`、`browser://selection {tabId,text,url}`、`browser://title {tabId,title}`（沿用现有 `solomd://` 命名风格）。

**`on_navigation` 处理器**（唯一同时负责回传与放行的位置）：

```rust
let app_for_nav = app.clone();
.on_navigation(move |url| {
    if url.host_str() == Some("solomd.invalid") {
        // 解析并拼接分片，发 browser://capture 给主窗口
        // 解析失败只记日志，不 panic —— 这是不可信输入
        return false;                      // 取消导航，页面不跳转
    }
    matches!(url.scheme(), "http" | "https")
})
```

`initialization_script` 注入的采集函数只做两件事：拼 payload，赋值 `location.href`。**不调用任何 Tauri API，不读 `__TAURI_INTERNALS__`。**

### Rust：`src/extract_rules.rs`

```rust
pub fn load() -> Rules
pub fn lookup(domain: &str) -> Option<Rule>
pub fn record_hit(domain: &str)
pub fn record_miss(domain: &str)      // 内含 hits 减半
pub fn upsert_learned(domain: &str, rule: Rule)
pub fn is_stale(rule: &Rule) -> bool
pub fn extract_with_rule(html: &str, rule: &Rule) -> Option<Extracted>  // scraper
```

### Rust：`src/webdoc.rs`

```rust
pub async fn fetch_html(url: &str) -> Result<String, String>
pub fn extract_main(html: &str, url: &str) -> Extracted          // 第 1、2 级
pub async fn capture_url(url: &str, mode: CaptureMode) -> Result<Captured, String>
```

### Rust：AI 一次性调用（新写，非复用）

**`ai_proxy.rs` 目前只有流式路径**：所有 `run_chat_*` 都设 `"stream": true` 并通过 `solomd://ai-chunk` 事件按 request id 推给前端，**没有"调一次、返回一个字符串"的 helper**。第 3 级抽取需要新写：

```rust
pub async fn ai_complete_once(provider, model, base_url, system, user) -> Result<String, String>
```

它复用现有的 provider 抽象、`get_api_key` 和 base_url 解析，但走非流式分支。

**输入契约**（不指定就会炸上下文）：送进去的**不是整页 HTML**。先 `strip_html_noise` + 去掉 `<svg>/<iframe>/<img>` 属性，再按 200 KB 截断，仍超限则改成送正文候选文本。

**输出契约**（严格 JSON，解析失败即视为该级失败，降级存根）：

```json
{ "title_selector": "h1", "content_selector": "article .body", "remove": [".ads"] }
```

选择器写入规则库前必须能编译（`scraper::Selector::parse`）并在当前页面上匹配到 > 300 字，否则丢弃不落盘。

### 复用，不新建

- **fetch**：`reqwest` 已在依赖里
- **HTML → markdown**：[convert.rs](../../../app/src-tauri/src/convert.rs) 的 `strip_html_noise` 已接受 `&str`，`convert_html` 才读文件——只需把 htmd 那一步抽成接受 `&str` 的变体，改动很小
- **AI provider/key**：`ai_proxy.rs` 的 `get_api_key` 等已公开可复用
- **路径校验 + `create_dir_all`**：`capture_endpoint.rs` 的 `resolve_safe_workspace_path`。但**注意**：`/capture` 写的是 `workspace/inbox/<timestamp>-<slug>.md`，和本设计的 `D/<title>/index.md` 布局无关，`render_note` 不能复用
- **索引**：写入后调 `rag::rag_reindex_file`

### 新增依赖（2 个）

- `dom_smoothie` — Readability 移植，v0.18，55 万下载
- `scraper` — CSS 选择器，3000 万下载

注意 `Cargo.lock` 里已有两个 `html5ever`（0.29.1、0.38.0，后者来自 htmd 0.5.4），`scraper` 很可能再钉一个自己的版本，多一份二进制体积。P4 时确认。

### 前端

| 文件 | 职责 |
|---|---|
| `components/BrowserToolbar.vue` | 后退/前进/刷新/地址栏/「采集对话」按钮 |
| `components/BrowserView.vue` | browser tab 的占位锚点 div，供 `useBrowserBounds` 测量 |
| `components/CapturePanel.vue` | 右侧栏 pane：模式选择 + 引用清单 + 逐条状态 + 写入按钮 |
| `composables/useBrowserBridge.ts` | 包裹 `invoke` 与事件监听 |
| `composables/useBrowserBounds.ts` | 元素矩形 → Rust 的同步 |
| `stores/browser.ts` | 每个 tab 的 url/title/loading、待审缓冲、采集状态，**以及 webview 生命周期** |

[PaneContent.vue](../../../app/src/components/PaneContent.vue) 的判断必须在 `Editor`/`Preview` 分支**之前**（`showEditor` / `showPreview` 两个 computed 之上），否则 browser tab 会掉进编辑器分支。

**右侧栏 pane 注册点（v1 只写了 1 个，实际有 8 个）**：

- `App.vue`：`visibleRsPanes` 的 `all` 记录 + `known` 数组 + 返回类型联合（~1744–1772）；`rightSidebarHasRenderablePane`（~1685）；`ctxToggle` 的 `noPanesVisible`（~258）；`rsPaneSnapshot`（~239）
- `settings.ts`：defaults（~633）、merge（~790）、save 白名单（~1021）、load 白名单（~1067）、toggle-with-ensure（~1205）

漏任何一个，侧栏的自动隐藏/恢复或持久化就会静默失效。

### 边界同步

`useBrowserBounds(tabId, elRef)` 在 `elRef` 上挂 `ResizeObserver`，把 `getBoundingClientRect()` 的 CSS 像素发给 `browser_set_bounds`。触发源：

- 窗口 resize / 最大化 / 全屏
- 左右侧栏开关
- tile 分隔条拖拽（拖拽期间 `browser_hide`，松手后 `show` + 重设 bounds）
- tab 切换（切走 `hide`，切回 `show` + 重设）
- 采集面板折叠/展开

**原生子 webview 永远绘制在主 webview 的 HTML 之上。** 这不是拖拽撕裂的问题，而是：只要 browser tab 可见，命令面板（⌘K）、设置弹窗、右键菜单、下拉框、Toast 全都会被压在 webview 底下看不见。必须接进应用的 overlay 状态，**任何模态/浮层打开时 `browser_hide()`，关闭时 `browser_show()`**。工具栏自身的地址栏补全下拉也要算进去。

### 对话与引用的提取契约

`a[href^="http"]` 会把导航栏、侧边栏、广告全捞进来。契约：

- **正文**：会话消息容器（若有已知选择器）的 `innerText`；取不到则退回 `document.body.innerText`。只依赖 `innerText`，不依赖 class 名——DeepSeek 改版不会让它全废。
- **引用**：仅在**助手消息子树**内取 `a[href]`，且：
  - 丢弃与 `location.origin` 同源的链接
  - 按 href 去重
  - 丢掉 href 等于当前页面 URL 的
  - 标题取 anchor 的 `innerText.trim()`；为空则用 href 的 host + path 末段兜底
- **对话标题**：`document.title` 去掉 ` - DeepSeek` 后缀；为空则用第一条用户消息前 30 字；再为空则用时间戳。

---

## 错误处理与降级

| 情况 | 行为 |
|---|---|
| 页面加载失败 / 超时 | webview 显示原生错误页；`browser://error` 让面板标红，可重试 |
| 抓取 HTTP 403/404/超时 | 该条标「失败 + 原因」，其余继续；可重试或改用「选中片段」 |
| 抽取结果 < 300 字 | 视为抽取失败，升级到下一级 |
| 选择器失效 | `record_miss`（hits 减半），本次降级；累计 stale 后重学 |
| AI 无 key / 调用失败 / JSON 解析失败 | 降级为「存根」，不阻塞其他条目 |
| 目录不存在 / 无写权限 | 面板报错，**整批中止**（避免半批落盘） |
| 移动端 / Wayland 调用 | Rust 命令返回错误，前端不显示入口 |

**App Store 构建**：`IS_APP_STORE_BUILD` 会剥离整个 AI 面（见 App.vue），因此第 3 级抽取在商店版不可用——规则库学习需要按此降级。另外，内嵌通用浏览器 + 采集面板可能触发 Apple 3.1.1 审查（"app 内提供非 App Store 内容/服务入口"），需要在上架前确认，可能需要商店版隐藏整个入口。

---

## 安全

按重要性排序：

1. **tauri 必须 ≥2.12.1。** 在 2.10.3 上（本仓库当前锁定版本）**所有 app 自定义命令完全绕过 ACL**，远程页面可以直接调 `read_file` 读走整个 vault。这是本设计最严重的前置条件，不是可选项。
2. **不要为了这个功能引入 `AppManifest`。** 它会翻转 `has_app_acl_manifest`，让本地来源也走 ACL，连锁要求给现有约 150 个命令补授权。升级到 2.12.1 且不加 `AppManifest` 时，本地来源行为完全不变，远程来源被 ACL 拒绝 —— 这正是我们要的。
3. **`default.json` 永远不加 `remote` 字段。**
4. **子 webview 不调用任何命令。** 没有 IPC 通道，就没有需要授权的东西。
5. **`on_navigation` 白名单只放行 http/https**，且 `browser_navigate` 命令里独立重复同一校验。拦住 CVE-2026-42184 的误判路径。
6. **只缓冲，不落盘。** 回传内容进内存待审列表，用户确认后才写文件。
7. **平台边界**：不做移动端。
8. 子 webview 加载页面的 CSP 由远端站点提供，与主窗口 `"csp": null` 无关。

**P0 安全验证实测结果（2026-10-04，macOS 14 / tauri 2.12.1）**

在子 webview 里加载 `http://evil.local.test:8099/`（探针页，`/etc/hosts` 指向 127.0.0.1）后的实测输出：

```
__TAURI_INTERNALS__ present : true
read_file     => denied   "read_file not allowed. Plugin not found"
write_file    => denied   "write_file not allowed. Plugin not found"
list_dir      => denied   "list_dir not allowed. Plugin not found"
fs_list_dirs  => denied   "fs_list_dirs not allowed. Plugin not found"
tauri://localhost/  blocked
asset://localhost/  blocked
file:///etc/hosts   blocked
```

结论：远程来源的 origin 级 ACL 在 2.12.1 上生效。`__TAURI_INTERNALS__` 存在（如预期，Tauri 无条件注入），但**没有任何命令可调**。方案成立。

**反向对照（已实测，且这条是结论成立的关键）** —— 同一个命令、同一个二进制，只在**主窗口**（本地来源）调用：

```js
await window.__TAURI_INTERNALS__.invoke('read_file', { path: '/…/README.md' })
// => { content: "# SoloMD\n\n> The editor where agents live.…",
//      encoding: "UTF-8", had_bom: false, language: "markdown" }
```

**成功返回文件内容。** 对照结果：

| 来源 | 同一命令的结果 |
|---|---|
| 主窗口（本地） | 成功，返回文件内容 |
| 子 webview 的探针页（远程） | `read_file not allowed. Plugin not found` |

这排除了「命令根本没编进去所以必然 denied」的假通过 —— 差别只能来自来源。origin 级 ACL 在 2.12.1 上确实生效。

另外，两种拒绝的**错误形状**不同，也可用于日后排查：
- ACL 拒绝 → `not allowed. Plugin not found`（命令未执行）
- 命令执行了但业务失败 → `read failed: No such file or directory`（如路径不对）

`__TAURI__` 全局在本应用**不存在**（未开 `withGlobalTauri`）；探针要用 `window.__TAURI_INTERNALS__.invoke`。

**P0 必须包含的安全验证**（不是形式，任何一条不过就停）：

- [ ] `cargo tree -p tauri` 确认版本 ≥2.12.1；在 `src-tauri/src/webview/mod.rs` 对应的 crate 源码里确认门条件含 `!is_local`
- [ ] 在浏览器 webview 里导航到一个**你自己控制的可疑页面**，页面里跑一段探针：调 `read_file` / `write_file` / `list_dir`，并**打印每条的实际结果到页面上**（不能只看控制台，因为失败可能表现为静默拒绝）。断言三条全部被拒
- [ ] 同一次探针里，断言回传通道本身仍然可用（`on_navigation` 那条路能通到主窗口）
- [ ] 从**页面内部**（`location.href = 'tauri://localhost/'`、`<a href="asset://...">`）触发导航，断言被拦。**不能**用 `browser_navigate` 命令测这条 —— 命令里自己就会先拒掉，测不到 `on_navigation`
- [ ] 断言主窗口（本地前端）调 `read_file` **成功** —— 这是回归检查，确认升级没有把正常功能弄坏

---

## 测试

- **Rust 单测**（`app/src-tauri/tests/`）
  - `extract_rules`：命中/未命中计数、hits 减半、stale 判定、并发 `record_hit/miss` 不丢更新
  - slug 生成：CJK、超长、重名去重、非法字符
  - `extract_main`：对固定 HTML fixture 断言标题与正文，覆盖三级降级路径
  - 引用提取契约：同源过滤、去重、标题兜底
  - 路径穿越拒绝
- **前端**：`node --test src/lib/*.test.ts`（项目用 Node 内置 runner + `node:assert/strict`，import 带 `.ts` 后缀；**没有 vitest，不要引入**）
  - `stores/browser.ts`：状态机（待审 → 采集中 → 成功/失败/重试）+ webview 生命周期（恢复时 create、关闭时 destroy、切工作区保留）
  - `useBrowserBounds` 的矩形换算
  - `saveTab` / `closeTabSafe` 对 browser tab 的短路
- **手动矩阵**：macOS + Windows + Linux(X11) 各跑完整流程；至少覆盖知乎、微信公众号、一个长尾个人博客

---

## P0 实测结果（2026-10-04，macOS 14）

**功能性：全部通过。**

- 子 webview 能创建并渲染在指定坐标上
- `https://chat.deepseek.com/` 正常加载
- **扫码登录通过** —— 该站提供扫码入口，绕开了最担心的滑块验证码路径。这是风险评估里最大的未知，现已排除。
- 对话收发正常
- 注入脚本运行正常

**安全：通过**（见「安全」一节的实测输出）。

**仍未验证：**

- Windows / Linux(X11) —— 本机只有 macOS。`on_web_resource_request` 与 `on_navigation` 在两平台的实现路径不同，**发布前必须各跑一遍上面的探针**。
- Linux/Wayland 的「无子 webview」降级路径（`browser_platform_supported` 返回 false 时前端是否真的隐藏入口）。
- Android/iOS 编译（本机无 NDK）。移动端 stub 只用「临时对调 cfg 让桌面编译 stub」验证过它能与 `generate_handler!` 对齐。
- 单次导航 URL 的 payload 上限（分片已实现，但未实测截断点）。

## 分期

| 阶段 | 内容 | 出口条件 |
|---|---|---|
| **P0 风险闸门** | **先升 tauri 到 ≥2.12.1 并跑通现有测试**；加 `unstable` feature；`browser.rs` 骨架 + `#[cfg(desktop)]` 门禁；`add_child` 一个加载 `chat.deepseek.com` 的 webview；确认坐标空间；**实测 `on_navigation` 单片 payload 上限**；**跑完上面 5 项安全验证** | tauri 升级无回归 + macOS/Windows 都能**手动登录并发一条消息** + 采集能回传 + 5 项安全断言全过。**任一不通则本方案作废** |
| P1 | browser tab 类型 + `PaneContent` 分支 + 全部 save/close/workspace guard + 工具栏 + 边界同步 + overlay 隐藏 | 能开 tab、正常浏览、resize/切 tab/拖分隔条/开命令面板都不出问题 |
| P2 | 采集 capability + 两个命令 + 注入脚本 + 内存缓冲 + 审阅面板 | 「采集对话」把对话与引用抓进待审列表 |
| P3 | 写 `index.md` + 引用清单 + 模式选择 UI（Full/Stub） | 对话落盘，引用列表可勾选 |
| P4 | `dom_smoothie` + `scraper` + 规则库 + 全文抓取 | 三个测试站点抓取成功。**此处评估 readability 失败率，决定 P5 是否继续** |
| P5 | `ai_complete_once` + AI 抽取 + 选择器学习 + Selection 模式 | 长尾站点能抓到，规则库有记录 |
| P6 | 种子规则、i18n、文档、测试补齐、App Store 策略确认 | 全绿 |

---

## 已知风险

1. **P0 是真实风险，不是形式**。DeepSeek 可能对非标准 webview 做风控拦截（指纹/设备检测），WKWebView 上的登录滑块也可能过不去。这是整个方案的单点。
2. **子 webview 坐标空间未经实测**。`add_child` 的位置是否相对窗口客户区、是否受窗口装饰影响，P0 一并确认。
3. **`unstable` feature 的 API 稳定性**。Tauri 官方措辞是 "unfinished feature… while we review the API design"。把 webview 代码集中在 `browser.rs` 以缩小影响面。
4. **ACL 行为随版本变化**。PR #15266（~2.11）收紧了对远程来源的 ACL 强制；GHSA-7gmj-67g7-phm9 的修复也在这个区间。**升级 Tauri 时必须重跑 P0 的 5 项安全断言**，把它作为升级检查项写进 release checklist。
5. **部分站点抓不到**。知乎/公众号等有反爬或需 JS 渲染，`reqwest` 直取会失败。兜底是「选中片段」模式。若失败率过高，后续可加"用子 webview 渲染后再取 DOM"的抓取方式（P7 之后）。
6. **Linux/Wayland 不支持**，需要运行时检测并隐藏入口，否则用户点了没反应。
