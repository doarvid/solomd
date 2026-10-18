# 浏览器书签双向同步 — 设计

日期：2026-10-19
状态：待实现
相关：[内嵌浏览器 + 知识采集](./2026-10-03-embedded-browser-capture-design.md)

## 目标

在设置里开启后，SoloMD 与 Chromium 系浏览器的书签保持双向同步：

1. **书签 → 笔记**：用户把书签放进浏览器里的 `SoloMD/` 目录，该页面被采集为笔记；`SoloMD/` 下的子目录结构镜像到工作区根。已有笔记永不覆盖。
2. **笔记 → 书签**：工作区笔记里的所有外链写入浏览器 `SoloMD/` 托管目录，目录镜像笔记所在目录。`SoloMD/` 是笔记的投影，**永远和笔记对齐**。
3. 全部自动化：应用启动后同步一次，运行期间按间隔检查；无需用户逐个点击。

## 非目标

- **不做实时同步**：浏览器运行时无法安全写入，写入统一排队到浏览器退出后。
- **不做书签删除的传播到笔记**：从用户自己的书签目录里删掉书签，不会删除已采集的笔记。
- **不改用户自己的书签**：只读 `SoloMD/` 托管子树；写入也只发生在该子树内。
- **不支持 Firefox / Safari**：本期只做 Chromium 系。
- **不做移动端**：设置项在手机/平板隐藏，命令在移动端返回空。
- **不做用户可编辑的同步规则**：目录选择 + 开关 + 间隔，足够。

## 术语

- **来源（source）**：一个 Chromium 系浏览器的某个 Profile，即一个 `Bookmarks` JSON 文件。
- **托管目录**：浏览器书签里的 `SoloMD` 根目录及其子树，由应用完全管理。
- **镜像目录**：工作区里与书签目录同名、同层级的目录。
- **对齐**：`SoloMD/` 的子树与「笔记里的外链集合」逐节点一致，多退少补。

## 总体架构

```
Chromium Bookmarks JSON  ──读──▶  bookmarks_catalog / bookmarks_sync_plan
        ▲                                      │
        │                                      ▼
        └──写── bookmarks_apply        capture_fetch_page ──▶ 工作区笔记
                                               ▲
                                               │
workspace_index（新增 links）──▶ bookmarkSync store ──▶ bookmarks_apply
```

- `bookmarks.rs`：发现、解析、合并、计划、写入。纯 Rust，无网络。
- `workspace_index.rs`：新增 `links` 字段，笔记里的外链随索引增量更新。
- `capture_store.rs`：采集与 URL 归一化复用，不改协议。
- `stores/bookmarkSync.ts`：调度、进度、去重、调用现有采集命令。
- `BookmarkSyncSettings.vue`：配置与状态。

## 1. 全局 URL 索引

`IndexEntry` 增加：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkRef {
    /// 原始 URL（不做归一化，展示用）。
    pub url: String,
    /// 链接文字；裸 URL / autolink 时为空。
    pub text: String,
    /// 1-based 行号，和 WikilinkRef 一致（正文相对）。
    pub line: u32,
}

#[serde(default)]
pub links: Vec<LinkRef>,
```

抽取规则（在 `scan_file` 的正文处理里完成）：

- Markdown 行内链接 `[text](url)`，**排除图片** `![alt](url)`。
- Autolink `<https://…>`。
- 裸 URL `https?://…`（到空白或 `<>"')` 为止）。
- 只收 `http` / `https`。
- 同一文件内按原始 URL 去重，保留首次出现的行号。
- 不解析代码块（与 wikilink 抽取保持一致的朴素程度）。

前端 `workspaceIndex.ts` 的 `IndexEntry` 增加 `links?: LinkRef[]`，兼容旧缓存（缺失按空数组）。

## 2. 书签发现与读取（`bookmarks.rs`）

### 2.1 来源发现

按平台扫描已知目录下的 `<profile>/Bookmarks`：

| 平台 | 根目录 |
|---|---|
| macOS | `~/Library/Application Support/{Google/Chrome, Microsoft Edge, BraveSoftware/Brave-Browser, Arc/User Data, Vivaldi, Chromium}` |
| Windows | `%LOCALAPPDATA%/{Google/Chrome/User Data, Microsoft/Edge/User Data, BraveSoftware/Brave-Browser/User Data, Arc/User Data, Vivaldi/User Data, Chromium/User Data}` |
| Linux | `~/.config/{google-chrome, microsoft-edge, BraveSoftware/Brave-Browser, vivaldi, chromium}` |

- 只认文件名精确为 `Bookmarks` 的文件。
- 跳过 `System Profile`、`Guest Profile` 等非用户 Profile。
- 移动端（`cfg(target_os = "ios"/"android")`）返回空列表。

### 2.2 读取范围

- 只读取每个 Profile 里带 `meta_info.solomd_managed == "1"` 的托管根及其子树。
- 托管子树中带 `meta_info.solomd_mirror == "1"` 的 URL 节点是应用从笔记镜像过来的，**跳过**，避免把每条笔记外链都再采成一篇笔记。
- 其余 URL 节点都是用户放进 `SoloMD/` 的书签，进入采集计划。
- 普通书签目录一律不读。

### 2.3 命令

```rust
bookmarks_catalog() -> BookmarkCatalog
```

```rust
pub struct BookmarkCatalog {
    pub sources: Vec<BookmarkSource>,   // browser/profile/path/mtime/size
    pub fingerprint: String,            // sha256(path + mtime + size)，排序后
}
```

```rust
bookmarks_sync_plan() -> Vec<BookmarkPlanEntry>
```

```rust
pub struct BookmarkPlanEntry {
    /// 相对工作区根的镜像目录（已按平台清洗），相对 `SoloMD/`。
    pub folder: Vec<String>,
    pub title: String,
    pub url: String,
    pub normalized_url: String,
}
```

- 递归托管根，只收**没有** `solomd_mirror` 标记的 `http`/`https` 节点。
- 按 `capture_store::normalize_url` 去重；同一 URL 出现在多个 Profile 时只保留第一个。
- 目录名用 `capture_store::safe_filename` 清洗。

## 3. 笔记 → 书签写入

### 3.1 命令

```rust
bookmarks_apply(entries: Vec<BookmarkWriteEntry>) -> ApplyReport
```

```rust
pub struct BookmarkWriteEntry {
    /// 笔记所在目录相对工作区的分段路径。
    pub folder: Vec<String>,
    /// `笔记名 · 链接文字`（链接文字为空时用主机名）。
    pub title: String,
    pub url: String,
}
```

```rust
pub struct ApplyReport {
    pub written_profiles: Vec<String>,   // "Chrome · Default"
    pub skipped_profiles: Vec<SkippedProfile>, // reason: "running" | "unreadable"
    pub added: usize,
    pub removed: usize,
    pub unchanged: bool,
}
```

### 3.2 对齐算法

对每个检测到的 Profile：

1. 该浏览器的进程在运行 → 跳过，reason = `running`。
2. 读取并解析 `Bookmarks`。解析失败 → 跳过，reason = `unreadable`，绝不写。
3. 原文件复制为 `Bookmarks.solomd.bak`。
4. 在 `bookmark_bar.children` 里定位托管根：
   - 有 `meta_info.solomd_managed == "1"` 的目录 → 用它。
   - 没有 → 新建 `SoloMD`，带标记；若已存在同名但无标记的用户目录，改名 `SoloMD (2)`。
5. 用输入构造期望子树：
   - 目录 = 笔记目录分段（清洗后）。
   - 叶子 = URL 节点，title 按输入，`meta_info.solomd_mirror = "1"`。
   - 全局按归一化 URL 去重。
6. **保留用户添加的书签**：现有托管子树里没有 `solomd_mirror` 标记的 URL 节点，如果其 URL 不在期望集合里，按原相对路径并入期望树（不加标记）；一旦对应页面被采成笔记，URL 进入期望集合，该节点被带标记的镜像节点取代。
7. 比较现有托管子树的规范表示（路径 + URL + 标题 + 镜像标记）。完全一致 → 不写文件。
8. 不一致 → **替换**托管根的 `children`：
   - 新节点生成唯一数字 `id`（全文件最大值 + 1 递增）、UUID v4 形式的 `guid`、WebKit epoch 微秒 `date_added`。
   - 镜像节点删除后不复存在；空目录随之消失。
   - 用户自己的书签节点（托管子树之外）原样保留，不触碰。
9. 序列化前移除 `checksum` 字段（Chromium 启动时会重新计算）。
10. 临时文件 + `rename` 原子替换。

### 3.3 进程检测

- macOS / Linux：`pgrep -x`，匹配 `Google Chrome`、`Microsoft Edge`、`Brave Browser`、`Arc`、`Vivaldi`、`Chromium`。
- Windows：`tasklist /FO CSV`，匹配 `chrome.exe`、`msedge.exe`、`brave.exe`、`Arc.exe`、`vivaldi.exe`、`chromium.exe`。
- 检测失败按「未运行」处理是危险的，反过来按「运行中」处理更安全：命令不可用时跳过该 Profile 并报告。

### 3.4 笔记侧输入

由前端从 `workspace_index` 的 `entries` 构造：

- 每条 `links` + frontmatter 里的 `url:`（如有）。
- `folder` = 笔记绝对路径相对 `workspace.currentFolder` 的目录分段。
- 标题：有链接文字 → `${note_stem} · ${text}`；否则 `${note_stem} · ${hostname}`。
- 工作区根目录下的笔记 `folder` 为空，书签直接落在 `SoloMD/`。
- 归一化去重交给 Rust，避免大量 IPC。

## 4. 调度（`stores/bookmarkSync.ts`）

状态：

```ts
{
  running: boolean;
  phase: 'idle' | 'reading' | 'writing';
  total: number; done: number; captured: number; skipped: number; failed: number;
  currentTitle: string;
  lastRunAt: number | null;
  lastError: string | null;
  writeReport: ApplyReport | null;
}
```

触发：

- `start()` 在 `App.vue` 挂载后调用；`stop()` 在卸载时清理。
- 立即尝试一次；之后每 60 秒 tick，满足「距上次尝试 ≥ 配置间隔」才真正同步。
- 设置页「立即同步」忽略间隔，强制跑一轮。
- 前置条件不满足（未开启 / 无工作区 / SAF 工作区 / 移动端 / 正在跑）→ 直接返回。

一轮流程：

1. `bookmarks_catalog()`。
2. **读方向**：fingerprint 与上次持久化的值不同（或强制）才继续；`bookmarks_sync_plan()` 返回 `SoloMD/` 里用户新增的书签；按 `folder` 分组调用 `capture_captured_urls(dir)` 得到已采集 URL 集合；对未采集项串行 `capture_fetch_page({ dir, url, fallback_title: title, source_title: null })`。
3. **写方向**：从 `workspaceIndex.entries` 构造 `BookmarkWriteEntry[]`；`bookmarks_apply(entries)`。
4. 保存 fingerprint（读方向真的完成时）和 `lastRunAt`。
5. 更新状态；失败的采集不中断后续条目。

串行采集是刻意的：复用现有管线、避免并发抓取给站点压力。`// ponytail:` 标注并发上限，若大目录同步太慢再提到 2–3。

## 5. 设置 UI

`BookmarkSyncSettings.vue`，挂到 `SettingsPanel.vue` 的 `data-cat="integrations"`，`!isPhoneOrTablet` 才渲染。

内容：

1. 总开关（默认关）。
2. 读取来源：检测到的浏览器 × Profile 数量与名称。
3. 写入说明：写入全部检测到的 Profile 的 `SoloMD/`；浏览器运行中会排队。
4. 同步间隔：15 / 30 / 60 分钟（默认 30）。
5. 「立即同步」按钮 + 进度 + 上次结果。
6. 明确文案：
   - 把书签放进浏览器的 `SoloMD/` 即会采成笔记；子目录镜像到工作区根。
   - 已有笔记不会被覆盖。
   - `SoloMD/` 之外的书签不读也不改。
   - 应用镜像的书签有标记，不会被再次采成笔记；用户手动加进 `SoloMD/` 的书签会保留到被采集为止。

设置字段（localStorage，随 settings store 持久化）：

```ts
bookmarkSyncEnabled: boolean;            // default false
bookmarkSyncIntervalMinutes: number;     // default 30
bookmarkSyncFingerprint: string;         // default ''
```

> 旧版本保存的 `bookmarkSyncFolders` 在 `load()` 时丢弃。

## 6. 错误处理与边界

| 情况 | 行为 |
|---|---|
| 没有工作区 / SAF 工作区 | 不同步 |
| 没有检测到 Chromium 书签 | 设置页显示提示；同步空跑 |
| Bookmarks JSON 解析失败 | 跳过该 Profile，报告 `unreadable`，不写 |
| 浏览器进程检测不可用 | 保守跳过该 Profile，报告 `running` |
| 采集失败 | 沿用现有行为：写存根笔记（含 `url` frontmatter），下次视为已采集 |
| 同名笔记 | `write_note` 现有的 `-2` 去重 |
| 非法目录名 | `safe_filename` 清洗 |
| 笔记文件在同步中被编辑 | 本轮使用索引快照；下一轮自然对齐 |
| Chrome Sync | 可能在其他设备恢复已删书签；应用按 URL 去重，不保证浏览器 UI 无重复 |
| 用户手动改 `SoloMD/` | 下一轮被整体纠正 |
| 写入中途崩溃 | 临时文件 + rename，原文件与 `.solomd.bak` 至少保留一份 |

## 7. 测试

Rust 单测：

- `workspace_index`：行内链接、图片排除、autolink、裸 URL、同文件去重、行号。
- `bookmarks`：
  - 解析 fixture JSON，三根合并。
  - 多 Profile 合并、目录选择、子目录递归。
  - URL 归一化去重、非 http(s) 过滤。
  - 托管根识别（有/无标记、重名回退 `SoloMD (2)`）。
  - 对齐：新增、删除、空目录清理、标题变化、顺序稳定。
  - 用户书签节点字节级保持不变。
  - 无变化时不写文件。
  - checksum 被移除、ID 唯一、guid 格式、date_added 为数字字符串。
  - 原子写入 + 备份存在。
  - 进程「运行中」跳过。
- `cargo test` 全绿。

手动验证：

1. 真实 Chrome 测试 Profile 上开启同步，选一个书签目录，确认笔记目录/内容生成。
2. 二次同步零新增、零写入。
3. 浏览器关闭后笔记新增链接 → 打开 Chrome，`SoloMD/` 出现对应书签，无「书签文件损坏」提示。
4. 删除笔记里的一条链接 → 再同步，对应书签消失。
5. 用户自己的书签全程不变。

## 8. 平台矩阵

| 平台 | 读取 | 写入 |
|---|---|---|
| macOS | ✅ | ✅ |
| Windows | ✅ | ✅ |
| Linux | ✅ | ✅ |
| iOS / Android | ❌ | ❌ |

## 9. 改动清单

- `app/src-tauri/src/bookmarks.rs`（新增）
- `app/src-tauri/src/lib.rs`（注册模块与命令）
- `app/src-tauri/src/workspace_index.rs`（`LinkRef` + 抽取 + 测试）
- `app/src/stores/workspaceIndex.ts`（`links` 类型）
- `app/src/stores/bookmarkSync.ts`（新增）
- `app/src/components/BookmarkSyncSettings.vue`（新增）
- `app/src/components/SettingsPanel.vue`（挂载）
- `app/src/stores/settings.ts`（字段 + 默认值 + 持久化）
- `app/src/App.vue`（start/stop）
- `app/src/i18n/*.ts`（文案）
- `app/src/types.ts`（如需要，同步相关共享类型）
