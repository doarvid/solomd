# 收藏源接入（一期：GitHub Star）— 设计

日期：2026-10-25
状态：设计已定，待实现
相关：[浏览器书签双向同步](./2026-10-19-browser-bookmark-sync-design.md)、[内嵌浏览器 + 知识采集](./2026-10-03-embedded-browser-capture-design.md)

## 目标

SoloMD 能对接外部账号的“收藏”，把尚未导入的条目汇集到收件箱：

1. **GitHub Star**（一期）：读取当前 GitHub 账号收藏的仓库，显示在收件箱的「待导入收藏」区。
2. **今日头条收藏**（二期）：在内嵌浏览器里登录一次，读取“我的收藏”列表。
3. 打开应用/打开收件箱即可看到未导入条目，支持单条与批量导入成笔记。
4. “收藏源”是一个可扩展的概念：一期只有 GitHub，二期加今日头条，后续可加 B 站、小红书等，不需要重写刷新、去重、导入和 UI。

## 非目标

- **不做双向同步**：不会因为笔记被删除而取消 Star，也不会把笔记回写成收藏。
- **不传播取消操作**：源里取消收藏不会删除已导入的笔记。
- **一期不做今日头条**：登录、列表采集、无头渲染回退放到二期。
- **不做自定义源插件体系**：两个源用固定枚举 + 适配函数即可，不引入 trait 注册表。
- **不做移动端**：与浏览器书签同步一致，一期仅桌面端。移动端隐藏入口，命令返回空。
- **不做导入到指定文件夹的设置**：复用现有 capture 的收件箱目录。

## 术语

- **收藏源（source）**：一个外部账号的收藏集合。一期为 `github`。
- **待导入条目（pending item）**：源返回、尚未导入成笔记的收藏。
- **导入**：把一条待导入条目抓成一篇文章笔记，落到工作区收件箱文件夹。
- **已采集 URL**：某篇笔记 frontmatter 的 `url:`，或正文里已经出现过的链接。用于去重。

## 总体架构

```
GitHub /user/starred ──▶ collections_refresh_github ──▶ .solomd/collections.json
                                                            │
workspace_index（captured_url / links / 标题）──┐            │
                                                ▼            ▼
                                     stores/collections.ts（过滤、调度、进度）
                                                │
                                                ▼
                                  收件箱 InboxView「待导入收藏」区
                                                │ 导入
                                                ▼
                        collections_import ──▶ capture_fetch_page
                                                │
                                                ▼
                                   inbox/*.md（inbox: true）
```

- `collections.rs`：源数据模型、缓存读写、GitHub 刷新、导入编排。纯 Rust。
- `stores/collections.ts`：刷新时机、去重过滤、批量导入进度。
- `InboxView.vue`：展示与操作入口。
- `CollectionSourcesSettings.vue`：设置 → 集成里的源开关与状态。
- 复用：`capture_fetch_page`（含 GitHub 仓库 README 特判）、`capture_endpoint::current_target()`、`bookmark-dedupe.ts` 的 `shouldCapture`、`github_sync` 的 keyring token 与 API helper。

## 1. 数据模型与存储

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingItem {
    /// 稳定 id："github:<owner/repo>" / 二期的 "toutiao:<normalized-url>"。
    pub id: String,
    /// "github"（二期 "toutiao"）。
    pub source: String,
    pub title: String,
    /// 原始页面地址（仓库 html_url）。
    pub url: String,
    /// 源里的收藏时间（GitHub 为 starred_at），RFC3339。
    #[serde(default)]
    pub saved_at: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub stars: Option<u32>,
    #[serde(default)]
    pub topics: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionsState {
    /// 当前为 1；文件缺失或字段缺失时按 1 初始化。
    pub version: u32,
    /// 源返回的全部条目，按 id upsert。UI 只显示过滤后的子集。
    pub items: Vec<PendingItem>,
    /// 用户点过“忽略”的 id，永久保留，直到用户清空记录。
    pub dismissed: Vec<String>,
    /// 已成功导入的 id → 笔记路径（用于清空记录和调试）。
    pub imported: BTreeMap<String, String>,
    /// 每个源的最近一次成功刷新时间（毫秒时间戳）。
    pub last_refresh: BTreeMap<String, i64>,
}
```

存储位置：`<workspace>/.solomd/collections.json`。

- 原子写：先写同目录临时文件，再 rename。
- 文件缺失 → 空状态。
- 解析失败 → 先把原文件重命名为 `collections.json.bak-<时间戳>`，再以空状态继续，绝不让损坏缓存阻塞收件箱。
- 读改写命令在同一把进程级 `Mutex` 下完成，避免并发刷新/导入互相覆盖。

**不持久化“是否已采集”**：那属于工作区内容，随时会变。前端每次用 workspace index 实时过滤。

## 2. Rust 命令（`collections.rs`）

全部注册到 `lib.rs` 和 `runner.rs`（遵循项目的双注册约定）。桌面端外返回空/`None`，不报错。

```rust
collections_load(workspace: String) -> CollectionsState
```

读取缓存；不触碰网络。

```rust
collections_refresh_github(workspace: String) -> RefreshOutcome
```

- 复用 `github_sync::read_token()`；无 token 返回 `Err("no GitHub token set")`，前端据此显示“未连接”而不是错误 toast。
- 分页 `GET /user/starred?sort=created&direction=desc&per_page=100&page=N`，请求头 `Accept: application/vnd.github.star+json`（响应形如 `{ starred_at, repo }`）。
- 最多 10 页（1000 条）；达到上限时 `truncated = true`，前端提示“仅显示最近 1000 条”。
- 按 `id` upsert 到 `items`，更新 `last_refresh.github`。
- 失败时**不修改缓存**，把错误返回给前端。

```rust
struct RefreshOutcome {
    /// 本次新增的条目数（已存在的 id 不算）。
    added: u32,
    /// 缓存里当前的条目总数。
    total: u32,
    /// 是否因为 1000 条上限而没有拉全。
    truncated: bool,
}
```

```rust
collections_dismiss(workspace: String, id: String) -> CollectionsState
```

把 id 加入 `dismissed` 并保存。

```rust
collections_clear_history(workspace: String) -> CollectionsState
```

清空 `dismissed` 与 `imported`（用户“忽略错了”或想重新导入时的自救入口）。

```rust
collections_import(workspace: String, id: String) -> ImportOutcome
```

1. 从缓存找到条目；找不到返回错误。
2. 目标目录：`capture_endpoint::current_target()` 的 `workspace/inbox_folder`；拿不到时回退 `workspace/inbox`。
3. 调用 `capture_store::capture_fetch_page(dir, url, title, None)`。
   - GitHub 仓库 URL 已被该函数特判为“读 README”，无需另写抓取逻辑。
4. 抓取成功（`error == None`）：
   - 给笔记补 frontmatter：`inbox: true`、`stars`、`language`、`topics`、`starred`；已有同名键不重复写。
   - 记入 `imported[id] = path`，保存缓存。
   - 返回 `{ path, warning: null, error: null }`。
   - frontmatter 补写失败不算导入失败：文件已经存在，返回 `warning`，仍记入 `imported`，避免下次产生 `-2` 副本。
5. 抓取失败（`error != None`，即已落下存根）：
   - 删除刚生成的存根文件（仅限本次返回的 path），不产生重复文件。
   - **不**记入 `imported`，条目保留在待导入列表；返回 `{ path: null, warning: null, error }`。
   - 用户可择机重试，或点“忽略”。

```rust
struct ImportOutcome {
    path: Option<String>,
    /// 导入成功但有非致命问题（例如 frontmatter 补写失败）。
    warning: Option<String>,
    /// 导入失败原因；Some 时条目仍待导入。
    error: Option<String>,
}
```

### JSON 映射

`starred_at` 缺失时 `savedAt = None`；`topics` 缺失按空数组；`description`/`language` 缺失按 `None`。单个仓库字段异常不影响整批刷新。

## 3. 前端过滤与调度（`stores/collections.ts`）

### 3.1 状态

```ts
interface CollectionsStore {
  state: CollectionsState | null;
  loading: boolean;
  refreshing: boolean;
  importingIds: Set<string>;
  lastError: string | null;
}
```

### 3.2 可见条目

```
visibleItems =
  state.items
    没有出现在 dismissed
    没有出现在 imported
    shouldCapture({ title, normalized_url: url }, dedupeIndex) === true
```

- `dedupeIndex` 按 `bookmarkSync` 的现有方式从 workspace index 构建：`capturedUrls`（`captured_url`）、`noteLinkedUrls`（所有正文链接的 `normalized_url`）、`capturedTitles`。
- GitHub 的导入文件名是 `owner__repo.md`，与条目标题 `owner/repo` 不同，因此**以 URL 去重为准**，不依赖标题匹配。
- URL 归一化复用 `capture_normalize_url` 命令的结果（后端权威实现），刷新后一次性算好并缓存；不要在前端另写一份归一化规则。
- 展示顺序：按 `savedAt` 倒序；缺失时间或无法解析的排在最后，再按标题稳定排序。

### 3.3 刷新时机

- 应用启动、workspace index ready 之后调用一次 `maybeRefresh()`。
- 每次打开收件箱时调用 `maybeRefresh()`。
- 设置卡片里的“立即刷新”调用 `refresh(true)`。
- `maybeRefresh` 条件：源已启用、有 token、非移动端、有工作区、未在刷新中、距 `last_refresh` 超过 `collectionRefreshMinutes`（默认 30）。
- 刷新期间保留旧列表；成功后原地替换，失败只记 `lastError`，绝不清空。

### 3.4 导入

- 单条：`collections_import`，期间把 id 放进 `importingIds`，行内显示进度。
- 批量：对当前 `visibleItems` 串行执行（避免一次打开几十个抓取），显示 `done / total`；成功的 id 从列表移除，失败的保留并汇总。
- 全部完成后发一条 toast：成功 N 条、失败 M 条；失败详情写进区块内的错误行。

## 4. UI

### 4.1 收件箱（`InboxView.vue`）

在现有标题栏下方、笔记列表/空状态之上新增区块，**仅在可见条目 N > 0 时出现**，不折叠（满足“打开就能看到”）：

```
┌ 待导入收藏 (12)          [刷新] [全部导入] ┐
│ owner/repo  描述…        Rust · ★1.2k  3天前  [导入] [忽略] │
│ …                                                          │
└ 刷新失败：GitHub API 403 …（有错误时才显示）               ┘
```

- 行：标题、单行省略描述、语言/star 数 chip、收藏时间（复用收件箱的相对时间格式化）。
- 操作：`导入`、`忽略`；批量导入时行内显示“导入中…”。
- 区块与现有笔记列表的周期筛选、⌘E 流程互不影响；收件箱笔记为空但存在待导入条目时，区块照常显示。
- 不做行点击直接导入（避免误触），导入必须点按钮。

### 4.2 设置 → 集成（`CollectionSourcesSettings.vue`）

在 `IntegrationsSettings` 之后渲染，含两张卡片：

- **GitHub Star**
  - 连接状态：复用 `github_has_token`；
  - 未连接：提示“先在设置 → 同步 → GitHub 里连接”，并提供跳转按钮。实现方式：在 `SettingsPanel.vue` 增加一个 `solomd:settings-section` 事件监听（切换 `activeCategory`，复用现有 `VALID_CATEGORIES` 校验），按钮派发 `{ section: 'sync' }`；这样设置面板已经打开时也能切过去；
  - 已连接：启用开关、立即刷新、最近刷新时间、最近错误、待导入数量；
  - “清空已忽略/已导入记录”按钮（调用 `collections_clear_history`）。
- **今日头条**：占位卡片，标注“二期支持”，不发命令。

新增设置项（`settings.ts`，localStorage 持久化）：

```ts
collectionGithubEnabled: boolean;   // 默认 false
collectionRefreshMinutes: number;   // 默认 30
```

### 4.3 i18n

所有新增文案进 `app/src/i18n/en.ts` 与 `zh.ts`，键前缀：

- `settings.collectionSources.*`
- `inbox.pendingImport.*`

不硬编码中文/英文。

## 5. 错误与边界

| 场景 | 行为 |
|---|---|
| 无工作区 / 移动端 | 功能隐藏，命令返回空状态，不抛错 |
| 无 GitHub token | 设置卡片显示“未连接”，刷新静默跳过，不弹错误 |
| GitHub 限流 / 网络失败 | 保留缓存，区块显示上次错误；不清空待导入列表 |
| 缓存损坏 | 备份后重建空状态 |
| 单条抓取失败 | 删除存根、条目保留、行内标红“导入失败”，可重试或忽略 |
| 已导入后用户删了笔记 | `imported` 仍记录该 id，不再出现；用“清空记录”恢复 |
| 单条 JSON 字段异常 | 跳过字段默认值，不让整批刷新失败 |

## 6. 测试

### Rust（`collections.rs` 内 `#[cfg(test)]`）

- 缓存写→读往返，字段完整。
- 损坏文件被备份、返回空状态。
- upsert：同 id 刷新只保留一条；`dismissed` / `imported` 不受刷新影响。
- 分页响应映射：`{starred_at, repo}` → `PendingItem`，缺失字段用默认值。
- frontmatter 补写：`inbox: true` 只写一次；`topics` 按 YAML 列表；已有键不重复。
- 导入失败路径：返回的存根被删除、条目不记入 `imported`。

### TypeScript（`app/src/lib/collections-filter.test.ts`）

- `visibleItems` 过滤：dismissed、imported、已采集 URL、正文已链接 URL 各自被排除。
- 归一化 URL 比较走同一 key。
- 排序：按 `savedAt` 倒序，缺失时间排最后。

沿用现有 `node --test --experimental-strip-types` 方式（`app/scripts/run-tests.sh`）。

### 手动验收

1. 设置 → 集成启用 GitHub Star，刷新 → 收件箱出现未导入条目。
2. 导入一条 → `inbox/` 下生成笔记，含 `inbox: true`、`stars`、`language`、`topics`；收件箱笔记计数 +1；该条目从待导入区消失。
3. 断网后点刷新 → 列表不清空，显示错误。
4. 忽略一条后重启应用 → 仍不出现。
5. 删掉刚导入的笔记 → 该条目仍不出现；点“清空记录” → 重新出现。

## 7. 二期预告（不在本期实现）

- `source = "toutiao"`：内嵌浏览器登录一次，注入脚本自动滚动并采集 `/article/`、`/w/`、`/video/`、`/i/` 链接；新增哨兵 kind `collect`。
- 通用「隐藏 webview 无头渲染」采集回退：静态抓取失败时，隐藏 webview 加载页面（带登录态、执行 JS），把渲染后的 HTML 交回现有 `webdoc` 抽取器。该能力同时提升今日头条文章和所有站点的采集成功率。
- 数据模型已按 `source` 字段与 `PendingItem` 的通用字段预留，二期不改一期缓存结构。
