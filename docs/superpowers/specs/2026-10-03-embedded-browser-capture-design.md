# 内嵌浏览器 + 知识采集 — 设计

日期：2026-10-03
状态：待实现
相关：[roadmap.md](../../roadmap.md)

## 目标

在 SoloMD 里提供一个**内嵌浏览器 tab**，默认打开 DeepSeek 作为知识检索入口。用户对话后：

1. 一键采集当前对话 → 在指定目录 D 下生成 `D/<对话标题>/index.md`（对话正文 + 引用来源清单）
2. 引用清单进入右侧栏采集面板，用户勾选后按选定模式逐条抓取 → `D/<对话标题>/refs/<slug>.md`
3. 抓取到的新站点自动学习抽取策略，按域名沉淀，下次复用

## 非目标（明确不做）

- **不做浏览器 chrome 全功能**：不做书签、历史、下载管理、扩展。地址栏只做"输入网址跳转"。
- **不做移动端**：见下方平台矩阵。
- **不做 tile 分屏内的多浏览器实例上限管理**：用户开多少 tab 就是多少个 webview，不设人为上限。
- **不做 URL 结果缓存**：同一链接重复采集会重新抓取。规则库已能省掉重复的 AI 调用。
- **不做热门站点硬编码适配器子系统**：只预置一份种子选择器 JSON（~5 条数据），不是一套代码。
- **不在子 webview 里暴露 Tauri IPC**：见安全一节，这是硬约束。

## 平台矩阵

Tauri 的子 webview（`WebviewBuilder` + `Window::add_child`）**仅桌面可用**。Android/iOS 上 Tauri 无法把第二个 webview 嵌进主 webview 的布局，只能另开全屏 Activity，与本设计冲突。

| 平台 | 内嵌浏览器 tab | 采集面板 | 降级行为 |
|---|---|---|---|
| macOS | ✅ WKWebView | ✅ | — |
| Windows | ✅ WebView2 | ✅ | — |
| Linux | ✅ WebKitGTK | ✅ | — |
| Android | ❌ | ❌ | 目录右键菜单不出现该项；Rust 命令返回错误 |
| iOS | ❌ | ❌ | 同上 |

移动端需在 `isMobile()` 判断和 Rust 命令两侧同时设防，不能只靠前端隐藏。

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
│ browser.rs      子 webview 生命周期 / 注入脚本          │
│ webdoc.rs       URL → 正文 markdown 三级流水线          │
│ extract_rules.rs 域名选择器库（读写 / 命中失效）         │
│ capture_endpoint.rs  + /browser/* 路由（复用现有服务）   │
└───────────────────────────────────────────────────────┘
```

### 关键决策 1：回传通道走 localhost HTTP，不走 Tauri IPC

子 webview 加载的是任意外部网页。若给它 Tauri IPC，一个被 XSS 的页面即可调用 `fs:allow-read-file`（当前 capability 全开）读取用户全部笔记。**这是硬约束，不接受"就一个命令"的妥协。**

回传改为：注入脚本 `fetch('http://127.0.0.1:<port>/browser/capture', {Authorization: Bearer <token>})`。

- https 页面 fetch `http://127.0.0.1` **不受混合内容拦截**（localhost 属 secure context）
- [capture_endpoint.rs](../../../app/src-tauri/src/capture_endpoint.rs) 的 `write_resp` 已经发出 `Access-Control-Allow-Origin: *` + `Access-Control-Allow-Headers: Content-Type, Authorization`，且 `OPTIONS` 已返回 204 — **CORS 零新增工作**
- 沿用同一套手写 HTTP/1.1 + 单 bearer token + 仅 127.0.0.1 的模式

### 关键决策 2：捕获先入内存缓冲，用户确认后才落盘

注入脚本回传的内容进入**按 tabId 索引的内存缓冲**，不直接写文件。用户在右侧栏审阅后才点「写入」。

这样即使 token 被恶意页面窃取（它就在页面上下文里），最坏情况只是污染一个待审列表，无法向用户 vault 写入任意文件。这也顺带满足了"先看再存"的产品需求。

### 关键决策 3：抽取三级流水线，前级命中即停

| 级 | 手段 | 成本 | 命中场景 |
|---|---|---|---|
| 1 | `extract_rules` 里该域名的 CSS 选择器 | ~0 | 复访站点 |
| 2 | `dom_smoothie`（Mozilla Readability 的 Rust 移植） | ~0，离线 | 大多数文章页 |
| 3 | AI 抽取（复用 [ai_proxy.rs](../../../app/src-tauri/src/ai_proxy.rs) 的 DeepSeek） | 1 次调用 | 兜底 |

第 3 级成功时**同一轮要求 AI 额外输出一个 CSS 选择器**，写入规则库，下次该域名直接走第 1 级。

## 数据模型

### Tab（前端）

`types.ts` 的 `Tab` 增加两个可选字段，保持向后兼容（缺失即文件 tab）：

```ts
export interface Tab {
  // ...既有字段不变
  kind?: 'file' | 'browser';  // 缺省 'file'
  url?: string;               // 仅 browser tab
}
```

browser tab 的其他字段取安全缺省：`content: ''`、`savedContent: ''`、`language: 'plaintext'`、`hadBom: false`。它**永不 dirty**，Ctrl+S / 自动保存 / 会话恢复的脏检查都必须跳过它。

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

失效规则：命中判定为"选择器匹配到且文本 > 300 字"。当 `misses > 3 && misses > hits` 时标记 stale，下次该域名走第 3 级重学。

预置种子（`source: "seed"`）：知乎、微信公众号、掘金、CSDN、Wikipedia。写错也无妨——第 2/3 级会兜住。

### 笔记布局

右键目录为 D：

```
D/
└── <对话标题>/
    ├── index.md
    └── refs/
        ├── 001-<slug>.md
        └── 002-<slug>.md
```

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
via: selector | readability | ai | stub
---

<正文 markdown>
```

slug 由链接文字或 URL path 生成，CJK 安全，重名加 `-2` 后缀。

## 模块

### Rust

**`src/browser.rs`** — 子 webview 生命周期

```rust
browser_create(tab_id: String, url: String) -> Result<(), String>
browser_set_bounds(tab_id: String, x: f64, y: f64, w: f64, h: f64)  // 逻辑像素
browser_show(tab_id: String) / browser_hide(tab_id: String)
browser_navigate(tab_id: String, url: String)
browser_back(tab_id) / browser_forward(tab_id) / browser_reload(tab_id)
browser_destroy(tab_id: String)
browser_request_capture(tab_id: String)   // 触发页面内已注入的采集函数
browser_request_selection(tab_id: String) // 触发取 window.getSelection()
browser_set_capture_target(dir: String)   // 设置当前落盘目标目录 D
```

向前端发出的事件：`browser://page-loaded {tabId,url,title}`、`browser://capture {tabId,payload}`、`browser://selection {tabId,text,url}`、`browser://error {tabId,message}`。

`initialization_script` 注入一个极小的、全局命名空间化的采集函数（暴露 `window.__solomdCapture()` / `__solomdSelection()`），端口与 token 在 Rust 侧拼进脚本字符串。**不注入 `__TAURI__`。**

### Rust

**`src/extract_rules.rs`** — 规则库

```rust
pub fn load() -> Rules
pub fn lookup(domain: &str) -> Option<Rule>
pub fn record_hit(domain: &str)
pub fn record_miss(domain: &str)
pub fn upsert_learned(domain: &str, rule: Rule, source: RuleSource)
pub fn is_stale(rule: &Rule) -> bool
pub fn extract_with_rule(html: &str, rule: &Rule) -> Option<Extracted>  // 用 scraper
pub fn set_user_rule(domain: &str, rule: Rule)  // 用户在设置里手改
```

### Rust

**`src/webdoc.rs`** — URL → markdown

```rust
pub async fn fetch_html(url: &str) -> Result<String, String>       // reqwest，已有
pub fn extract_main(html: &str, url: &str) -> Extracted            // 第 1、2 级
pub async fn capture_url(url: &str, mode: CaptureMode) -> Result<Captured, String>
```

`CaptureMode`：`Full` / `Summary` / `Stub`。

### 复用，不新建

- **fetch**：`reqwest` 已在依赖里
- **HTML → markdown**：[convert.rs](../../../app/src-tauri/src/convert.rs) 的 `convert_html` + `strip_html_noise` 已有，需重构出接受 `&str` 而非路径的变体
- **AI 调用**：[ai_proxy.rs](../../../app/src-tauri/src/ai_proxy.rs) 的 provider 抽象，DeepSeek 已就绪
- **落盘**：[capture_endpoint.rs](../../../app/src-tauri/src/capture_endpoint.rs) 的路径校验 + `create_dir_all` 逻辑
- **索引**：写入后调 `rag::rag_reindex_file`，自动进知识库

### 新增依赖（2 个）

- `dom_smoothie` — Readability 移植，v0.18，55 万下载
- `scraper` — CSS 选择器，3000 万下载，底层 html5ever 已在树里（htmd 拉的）

### 前端

| 文件 | 职责 |
|---|---|
| `components/BrowserToolbar.vue` | 后退/前进/刷新/地址栏/「采集对话」按钮 |
| `components/BrowserView.vue` | browser tab 的占位锚点 div，供 `useBrowserBounds` 测量 |
| `components/CapturePanel.vue` | 右侧栏 pane：模式选择 + 引用清单 + 逐条状态 + 写入按钮 |
| `composables/useBrowserBridge.ts` | 包裹 `invoke` 与事件监听，暴露给 store |
| `composables/useBrowserBounds.ts` | 元素矩形 → Rust 的同步 |
| `stores/browser.ts` | 每个 tab 的 url/title/loading、待审缓冲、每条引用的采集状态 |

[PaneContent.vue](../../../app/src/components/PaneContent.vue) 在 `Editor`/`Preview` 分支**之前**先判断 `tab.kind === 'browser'`，渲染 `BrowserView`。这个判断必须最先，否则 browser tab 会掉进编辑器分支。

右侧栏：在 `App.vue` 的 `visibleRsPanes` 注册表加第 12 个 pane id `capture`，并在 `settings.ts` 加 `showCapturePanel` 开关，沿用现有的 pane 顺序/拖拽/分隔条机制。

### 边界同步（前端的主要工作量）

`useBrowserBounds(tabId, elRef)` 在 `elRef` 上挂 `ResizeObserver`，并监听窗口 resize / 全屏切换，把 `getBoundingClientRect()` 的 CSS 像素值发给 `browser_set_bounds`。触发源清单：

- 窗口 resize / 最大化 / 全屏
- 左右侧栏开关
- tile 分隔条拖拽（拖拽期间 `browser_hide`，松手后 `browser_show` + 重设 bounds，避免原生控件跟不上的撕裂感）
- tab 切换（切走 `hide`，切回 `show` + 重设 bounds）
- 面板折叠/展开

Rust 侧用 `LogicalPosition` / `LogicalSize`。

## 错误处理与降级

| 情况 | 行为 |
|---|---|
| 页面加载失败 / 超时 | webview 显示原生错误页；`browser://error` 让面板标红，可重试 |
| 抓取 HTTP 403/404/超时 | 该条标「失败 + 原因」，其余条目继续；可重试或改用「选中片段」 |
| 抽取结果 < 300 字 | 视为抽取失败，自动升级到下一级 |
| 第 1 级选择器失效 | `record_miss`，本次降级到第 2/3 级；累计失效后标记 stale |
| AI 无 key / 调用失败 | 降级为「存根」，不阻塞其他条目；面板提示去配置 |
| 目录不存在 / 无写权限 | 顶层面板报错，整批中止（避免半批落盘） |
| 移动端调用 | Rust 命令直接返回错误 |

## 安全

1. **子 webview 不给 Tauri IPC**。不注入 `__TAURI__`，不注册 `remote` capability。这是本设计的核心安全边界。
2. **浏览器专用 token 与 `/capture` 的用户 token 分离**，仅能访问 `/browser/capture`，且每次启动重新生成。
3. **只缓冲，不落盘**。捕获内容必须先经用户审阅，恶意页面无法直接写 vault。
4. **路径穿越校验**沿用 `capture_endpoint.rs` 的既有做法，落盘路径必须约束在目标目录 D 内。
5. **不对页面注入任何能力**：`initialization_script` 只包含采集函数，无文件、无进程、无网络（除那一个 POST）。
6. 子 webview 加载的页面自身 CSP 由远端站点提供，与主窗口的 `"csp": null` 互不影响。

## 测试

- **Rust 单测**（`app/src-tauri/tests/`，沿用现有惯例）
  - `extract_rules`：命中/未命中计数、stale 判定、`upsert_learned` 覆盖 user 规则的优先级
  - slug 生成：CJK、超长、重名去重、非法字符
  - `extract_main`：对固定的 HTML fixture 断言标题与正文，覆盖三级降级路径
  - 路径穿越拒绝
- **前端 vitest**（沿用 `lib/*.test.ts` 惯例）
  - `stores/browser.ts` 的状态机：待审 → 采集中 → 成功/失败/重试
  - `useBrowserBounds` 的矩形换算
- **手动验证矩阵**：macOS + Windows 各跑一遍完整流程；至少覆盖知乎、微信公众号、一个长尾个人博客三个站点

## 分期

| 阶段 | 内容 | 出口条件 |
|---|---|---|
| **P0 风险闸门** | 加 `unstable` feature；`add_child` 一个加载 `chat.deepseek.com` 的 webview；确认坐标空间；在这两个平台上**手动登录并发一条消息** | macOS + Windows 都能登录成功。**不通则本方案作废**，退回 opener + capture endpoint 路线 |
| P1 | browser tab 类型 + `PaneContent` 分支 + 工具栏 + 边界同步 | 能开 tab、正常浏览、resize/切 tab/拖分隔条不撕裂 |
| P2 | localhost `/browser/*` 路由 + 注入脚本 + 内存缓冲 + 审阅面板 | 「采集对话」把对话与引用抓进待审列表 |
| P3 | 写 `index.md` + 引用清单 + 模式选择的 UI | 对话落盘，引用列表可勾选 |
| P4 | `dom_smoothie` + `scraper` + 规则库 + 全文/存根模式 | 三个测试站点抓取成功 |
| P5 | AI 抽取层 + 选择器学习 + 摘要模式 | 长尾站点能抓到，规则库有记录 |
| P6 | 种子规则、设置入口（查看/编辑/删除规则）、i18n、文档、测试补齐 | 全绿 |

## 已知风险

1. **P0 是真实风险，不是形式**。DeepSeek 可能对非标准 webview 做风控拦截（指纹/设备检测），WKWebView 上的登录滑块也可能过不去。这是整个方案的单点。
2. **子 webview 坐标空间未经实测**。`add_child` 的位置在各平台是否相对窗口客户区、是否受窗口装饰影响，需要在 P0 一并确认。
3. **`unstable` feature 的 API 稳定性**。Tauri 官方措辞是"unfinished feature… while we review the API design"，升级 Tauri 主版本时 `browser.rs` 可能要改。把 webview 相关代码集中在单个文件里以缩小影响面。
4. **部分站点抓不到**。知乎/公众号等有反爬或需 JS 渲染，`reqwest` 直取会失败。降级路径是「选中片段」模式（用户在已渲染的 webview 里手动选中）。若失败率过高，后续可加"用子 webview 渲染后再取 DOM"的抓取方式，但那是 P7 之后的事。
5. **DeepSeek 前端改版会让对话结构提取失效**。缓解：对话采集只依赖 `innerText` + `a[href^=http]` 这类结构无关的信息，不依赖具体 class。
