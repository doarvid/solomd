# 目录右键 Agent（Claude CLI）— 设计

日期：2026-10-23
状态：待实现
相关：[Agent Panel](../../../app/src/components/AgentPanel.vue)、[FileTree](../../../app/src/components/FileTree.vue)

## 目标

在文件树的**目录**右键菜单里增加 `🤖 Agent`，点击后打开右侧 Agent 面板，用本机已安装的 **Claude Code CLI** 在该目录下进行多轮对话：

- 作用域 = 被右键的目录（`cwd`），CLI 自己按需读取目录里的笔记。
- 流式输出到现有 Agent 面板，工具调用显示为一行状态。
- 多轮会话用 Claude CLI 原生 `--session-id` / `--resume` 续接。
- 默认只读（Read / Grep / Glob）；沿用 `settings.agentAllowWrite` 决定是否允许编辑。

## 非目标

- **不做 ACP**。Claude Code 不原生支持 ACP，需要额外适配器；本期直接调 headless CLI。
- **不支持其它 CLI**（codex / gemini）；等第二个工具真正要用时再抽象。
- **不写 `.solomd/agent-runs`**。CLI 自己持久化会话；现有运行记录是 API 通道专用。
- **不做设置项配置 claude 路径**。自动探测，失败时报明确错误。
- **不做移动端 / App Store 构建**。菜单项在这两种构建下隐藏。
- **不解析 CLI 的结构化工具结果**。工具调用只显示状态行，不渲染参数/结果卡片。

## 总体架构

```
FileTree 右键目录
      │ openForFolder(path)
      ▼
agentPanel store (source=claude-cli, cliFolder)
      │
      ▼
AgentPanel ──invoke("claude_chat")──▶ claude_cli.rs ──spawn──▶ `claude -p`
      ▲                                   │
      └── solomd://claude-{chunk,status,done,error} ──emit──┘
```

- 新文件 `app/src-tauri/src/claude_cli.rs`：探测可执行文件、起子进程、解析 stream-json、取消。
- `app/src/stores/agentPanel.ts`：增加 CLI 模式的作用域与会话字段。
- `app/src/components/AgentPanel.vue`：来源切换、CLI 发送/停止、事件监听。
- `app/src/components/FileTree.vue`：目录右键菜单项。

## 1. 后端：`claude_cli.rs`

### 1.1 命令

```rust
#[derive(Deserialize)]
pub struct ClaudeChatRequest {
    pub request_id: String,
    pub prompt: String,
    /// 被右键的目录，子进程 cwd。
    pub cwd: String,
    /// 前端生成的 UUID；首轮与后续轮共用。
    pub session_id: String,
    /// false = 首轮（--session-id），true = 续接（--resume）。
    pub resume: bool,
    pub allow_write: bool,
}

#[tauri::command]
pub async fn claude_chat(app: AppHandle, request: ClaudeChatRequest) -> Result<(), String>;

#[tauri::command]
pub fn claude_cancel(request_id: String) -> Result<(), String>;
```

在 `lib.rs` 注册。Android 上直接返回 `Err("claude CLI is not available on this platform")`。

### 1.2 可执行文件探测

`resolve_claude() -> Result<PathBuf, String>`，按顺序：

1. 环境变量 `SOLOMD_CLAUDE_BIN`（存在且可执行）。
2. 常见路径：`~/.claude/local/claude`、`/usr/local/bin/claude`、`/opt/homebrew/bin/claude`、`~/.local/bin/claude`、`~/.npm-global/bin/claude`、`~/.bun/bin/claude`。
3. Unix：`sh -lc "command -v claude"`；Windows：`where claude`。

成功结果缓存到 `OnceLock<PathBuf>`；失败不缓存，下次重试。全部失败时报错：

> 找不到 claude CLI。请安装 Claude Code，或设置环境变量 SOLOMD_CLAUDE_BIN。

### 1.3 启动参数

```
claude -p
  --output-format stream-json
  --include-partial-messages
  --verbose
  --append-system-prompt "<固定提示>"
  (--session-id <uuid> | --resume <uuid>)
  [--permission-mode acceptEdits]        // allow_write = true
  --allowedTools Read Grep Glob
```

- **prompt 从 stdin 写入**，不放进 argv。
- 不传 `--no-session-persistence`（否则 `--resume` 失效）。
- 不传 `--model`：使用用户自己的 CLI 配置。
- `--append-system-prompt` 固定文本：

  > You are running inside SoloMD, a local-first Markdown note editor. The current working directory is the user's note folder; notes are Markdown files. Read files as needed. Answer in the user's language and keep replies concise.

- `--permission-mode acceptEdits` 只放行文件编辑，不放行 Bash。

### 1.4 输出解析

stdout 按行读取，每行一个 JSON。纯函数：

```rust
pub enum CliEvent {
    Chunk(String),
    ToolStatus(String),
    Error(String),
    Done,
}

pub fn parse_stream_line(line: &str) -> Vec<CliEvent>;
```

返回 `Vec`：一条 assistant 消息可能带多个 `tool_use`，每个都要发一条状态。

规则：

| 输入 | 输出 |
|---|---|
| `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}}` | `Chunk(text)` |
| `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{…}}]}}` | 每个 `tool_use` 一条 `ToolStatus("Read path/to/note.md")` |
| `{"type":"result","is_error":true,"result":"…"}` | `Error(result)` |
| `{"type":"result","is_error":false}` | `Done` |
| 其它（system / hook / init / 非 JSON） | `None` |

- 文本只从 `stream_event` 的 `text_delta` 发，避免和最终 `assistant` 消息重复。
- `ToolStatus` 取 `name` + `input` 里的 `file_path` / `path` / `pattern` / `command` 中第一个字符串，截断到 120 字符；没有参数就只显示 `name`。

### 1.5 事件

| 事件 | payload |
|---|---|
| `solomd://claude-chunk` | `{ request_id, chunk }` |
| `solomd://claude-status` | `{ request_id, text }` |
| `solomd://claude-done` | `{ request_id }` |
| `solomd://claude-error` | `{ request_id, error }` |

### 1.6 取消与退出

- 全局 `Mutex<HashMap<String, Child>>`；spawn 后登记，进程结束移除。
- `claude_cancel` 取到子进程后 `start_kill()`，并 emit `claude-error`，`error = "cancelled"`。
- 子进程非零退出：emit `claude-error`，消息取 stderr 最后 20 行；stderr 为空则用退出码。
- 已经 emit 过 `Error`（`result.is_error`）就不再重复。

## 2. 前端

### 2.1 `stores/agentPanel.ts`

```ts
source: 'api' | 'claude-cli';
cliFolder: string | null;
cliSessionId: string | null;
cliStarted: boolean;       // 已有至少一轮成功完成
cliStatus: string | null;  // 当前工具状态行

openForFolder(path: string): void;  // 设 source='claude-cli', cliFolder=path, 清空会话
setSource(s): void;                 // 切换来源时清空会话
```

`clear()` 一并清空 `cliSessionId / cliStarted / cliStatus`。

### 2.2 `AgentPanel.vue`

- 头部加两个 chip：`API` / `Claude CLI`（仅非 App Store 构建）。CLI 模式显示当前目录（`title` 里给完整路径）。
- `hasFolder`：CLI 模式看 `agent.cliFolder`，API 模式看 `workspace.currentFolder`。
- `stateKey`：CLI 模式不要求 `settings.aiEnabled`；没目录才显示 `no-folder`。
- CLI 模式隐藏"当前笔记"开关。
- `send()`：
  - 仍先 push user + 空的 assistant 占位。
  - `requestId = crypto.randomUUID()`；`agent.currentRunId = requestId`。
  - `agent.cliSessionId ||= crypto.randomUUID()`。
  - `invoke('claude_chat', { request: { request_id, prompt, cwd: agent.cliFolder, session_id, resume: agent.cliStarted, allow_write: settings.agentAllowWrite } })`。
- 监听四个 `solomd://claude-*` 事件，按 `request_id` 过滤：
  - chunk → `appendToLastAssistant`
  - status → `agent.cliStatus = text`
  - done → 清 `isStreaming / currentRunId / cliStatus`，`cliStarted = true`
  - error → 清状态、弹错误（`cancelled` 不弹），删空占位
- `stop()`：CLI 模式调 `claude_cancel`，API 模式仍走 `ai_cancel`。
- 流式期间在输入框上方显示 `cliStatus`。

### 2.3 `FileTree.vue`

```ts
function openAgent(node: Node) {
  agentPanel.openForFolder(node.path);
  if (!settings.showAgentPanel) settings.toggleAgentPanel(); // 内部会确保右侧栏可见并持久化
  else settings.ensureRightSidebarVisible();
  closeCtx();
}
```

菜单项放在"知识检索 / 浏览器搜索"之后：

```html
<button
  v-if="ctx.node?.is_dir && !isMobile() && !IS_APP_STORE_BUILD"
  class="ftree__ctx-item"
  @click="openAgent(ctx.node)"
>🤖 {{ t('explorer.agent') }}</button>
```

### 2.4 i18n

只加 `en` / `zh`，其它语言走现有英文回退：

- `explorer.agent`：`Agent` / `智能体`
- `agent.source.api`：`API` / `API`
- `agent.source.cli`：`Claude CLI`
- `agent.cliFolder`：`Folder: {path}` / `目录：{path}`

## 3. 错误处理

| 情况 | 表现 |
|---|---|
| 找不到 claude | `claude-error` + 面板错误条，提示安装或设置 `SOLOMD_CLAUDE_BIN` |
| 目录已不存在 | spawn 的 `current_dir` 失败 → 同上错误条 |
| CLI 非零退出 | 错误条带 stderr 末 20 行 |
| `result.is_error` | 错误条带 `result.result` |
| `--resume` 的会话丢失 | 用户看到 CLI 报错；点"清空对话"重开 |
| 用户点停止 | 杀进程，不弹错误 |

## 4. 测试

- Rust 单测 `parse_stream_line`：
  - text delta → `Chunk`
  - assistant + tool_use → `ToolStatus`（含参数截断）
  - `result.is_error` → `Error`
  - `result` 成功 → `Done`
  - system 行 / 非法 JSON → `None`
- 手动验收：
  1. 右键目录 → Agent → 面板切到 Claude CLI 并显示目录。
  2. 问"这个目录里有哪些笔记？" → 文本流式出现，读文件时出现状态行。
  3. 第二轮追问 → 能引用上一轮内容（`--resume` 生效）。
  4. 点停止 → 进程结束、按钮恢复。
  5. 清空对话 → 下一轮是全新会话。
- `cargo test claude_cli`、`vue-tsc --noEmit`。
