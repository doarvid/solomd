# 目录右键 Agent（Claude CLI）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在文件树目录右键菜单加 `🤖 Agent`，打开右侧 Agent 面板，用本机 Claude Code CLI 在该目录下多轮对话并流式显示。

**Architecture:** 新增 Rust 模块 `claude_cli.rs`，用 `tokio::process::Command` 跑 `claude -p --output-format stream-json`，把 stdout 的 JSON 行转成 Tauri 事件；前端复用现有 Agent 面板，增加 `API / Claude CLI` 来源切换，CLI 模式走新命令。

**Tech Stack:** Rust + Tauri 2（tokio process）、Vue 3 + Pinia、现有 i18n 字典。

**Spec:** `docs/superpowers/specs/2026-10-23-folder-agent-cli-design.md`

## Global Constraints

- 只支持 Claude CLI；不做 ACP、不加其它 CLI。
- 菜单只在桌面端且非 App Store 构建出现（`!isMobile() && !IS_APP_STORE_BUILD`）。
- prompt 必须走 stdin，不能放 argv。
- 不传 `--no-session-persistence`、不传 `--model`。
- 默认只读：`--allowedTools Read Grep Glob`；`settings.agentAllowWrite` 为 true 时才加 `--permission-mode acceptEdits`。
- 错误一律通过 `solomd://claude-error` 事件上报，`error === "cancelled"` 时前端不弹错误。
- 新 i18n key 只加 `en.ts` / `zh.ts`，其它语言走英文回退。

## Review Focus

- **GUI 启动的应用找不到 claude**（macOS Finder 启动的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`）：解析器必须覆盖常见安装路径，失败时给出可操作的中文报错。
- **prompt 以 `-` 开头或很长**：必须走 stdin，否则 claude 会把 prompt 当 flag。
- **`--resume` 的会话文件不存在**：CLI 报错必须在面板可见，用户能清空重开。
- **停止按钮**：杀进程后必须结束流式状态，不能再冒出 "exited unexpectedly"。
- **非 JSON / hook 输出行**：解析器必须跳过，不能让整轮对话崩掉。

---

### Task 1: Rust 解析器（TDD）

**Files:**
- Create: `app/src-tauri/src/claude_cli.rs`
- Modify: `app/src-tauri/src/lib.rs`（模块声明）
- Test: `app/src-tauri/src/claude_cli.rs` 内 `#[cfg(test)]`

**Interfaces:**
- Produces: `pub enum CliEvent { Chunk(String), ToolStatus(String), Error(String), Done }`
- Produces: `pub fn parse_stream_line(line: &str) -> Vec<CliEvent>`

- [ ] **Step 1: 建模块并写失败测试**

在 `app/src-tauri/src/lib.rs` 的模块列表里（`pub mod agent_tools;` 之后）加：

```rust
pub mod claude_cli;
```

创建 `app/src-tauri/src/claude_cli.rs`，先只放类型、空实现和测试：

```rust
//! Claude Code CLI (headless) runner for the folder Agent panel.
//!
//! The panel spawns `claude -p --output-format stream-json` inside the
//! right-clicked folder and streams stdout through Tauri events. This
//! module owns process spawning, output parsing and cancellation.

/// One meaningful line from the CLI's stream-json output.
#[derive(Debug, PartialEq)]
pub enum CliEvent {
    Chunk(String),
    ToolStatus(String),
    Error(String),
    Done,
}

pub fn parse_stream_line(_line: &str) -> Vec<CliEvent> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_text_delta() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}}"#;
        assert_eq!(parse_stream_line(line), vec![CliEvent::Chunk("你好".into())]);
    }

    #[test]
    fn parses_tool_use_from_assistant_message() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"notes/a.md"}}]}}"#;
        assert_eq!(
            parse_stream_line(line),
            vec![CliEvent::ToolStatus("Read notes/a.md".into())]
        );
    }

    #[test]
    fn parses_result_error() {
        let line = r#"{"type":"result","is_error":true,"result":"boom"}"#;
        assert_eq!(parse_stream_line(line), vec![CliEvent::Error("boom".into())]);
    }

    #[test]
    fn parses_result_success_as_done() {
        let line = r#"{"type":"result","is_error":false,"result":"ok"}"#;
        assert_eq!(parse_stream_line(line), vec![CliEvent::Done]);
    }

    #[test]
    fn ignores_system_and_garbage() {
        assert!(parse_stream_line(r#"{"type":"system","subtype":"init"}"#).is_empty());
        assert!(parse_stream_line("not json").is_empty());
        assert!(parse_stream_line("").is_empty());
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml claude_cli`

Expected: FAIL（5 个断言失败，实际返回空 Vec）。

- [ ] **Step 3: 实现解析器**

把 `parse_stream_line` 换成：

```rust
use serde_json::Value;

pub fn parse_stream_line(line: &str) -> Vec<CliEvent> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    match v.get("type").and_then(Value::as_str) {
        Some("stream_event") => {
            let event = v.get("event");
            if event.and_then(|e| e.get("type")).and_then(Value::as_str)
                == Some("content_block_delta")
            {
                let delta = event.and_then(|e| e.get("delta"));
                if delta.and_then(|d| d.get("type")).and_then(Value::as_str)
                    == Some("text_delta")
                {
                    if let Some(text) = delta.and_then(|d| d.get("text")).and_then(Value::as_str) {
                        if !text.is_empty() {
                            out.push(CliEvent::Chunk(text.to_string()));
                        }
                    }
                }
            }
        }
        Some("assistant") => {
            if let Some(items) = v.pointer("/message/content").and_then(Value::as_array) {
                for item in items {
                    if item.get("type").and_then(Value::as_str) != Some("tool_use") {
                        continue;
                    }
                    let name = item.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let detail = item.get("input").and_then(|input| {
                        ["file_path", "path", "pattern", "command", "query"]
                            .iter()
                            .find_map(|key| input.get(*key).and_then(Value::as_str))
                    });
                    let label = match detail {
                        Some(d) => {
                            let d: String = d.chars().take(100).collect();
                            format!("{name} {d}")
                        }
                        None => name.to_string(),
                    };
                    out.push(CliEvent::ToolStatus(label));
                }
            }
        }
        Some("result") => {
            if v.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
                let msg = v
                    .get("result")
                    .and_then(Value::as_str)
                    .unwrap_or("Claude CLI failed")
                    .to_string();
                out.push(CliEvent::Error(msg));
            } else {
                out.push(CliEvent::Done);
            }
        }
        _ => {}
    }
    out
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml claude_cli`

Expected: 5 passed。

- [ ] **Step 5: 提交**

```bash
git add app/src-tauri/src/claude_cli.rs app/src-tauri/src/lib.rs
git commit -m "feat(agent): parse claude stream-json events"
```

---

### Task 2: Rust 进程运行器与命令

**Files:**
- Modify: `app/src-tauri/src/claude_cli.rs`
- Modify: `app/src-tauri/Cargo.toml`（tokio `process` feature）
- Modify: `app/src-tauri/src/lib.rs`（注册命令）

**Interfaces:**
- Consumes: `parse_stream_line` / `CliEvent`（Task 1）
- Produces: Tauri 命令 `claude_chat(request: ClaudeChatRequest)`、`claude_cancel(request_id: String)`
- Produces: 事件 `solomd://claude-chunk|claude-status|claude-done|claude-error`

- [ ] **Step 1: 打开 tokio process feature**

`app/src-tauri/Cargo.toml` 中把：

```toml
tokio = { version = "1", features = ["rt-multi-thread", "net", "io-util", "sync", "time", "macros"] }
```

改成：

```toml
tokio = { version = "1", features = ["rt-multi-thread", "net", "io-util", "sync", "time", "macros", "process"] }
```

- [ ] **Step 2: 写运行器代码**

在 `claude_cli.rs` 的 `use serde_json::Value;` 之后补：

```rust
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

const SYSTEM_PROMPT: &str = "You are running inside SoloMD, a local-first Markdown note editor. \
The current working directory is the user's note folder; notes are Markdown files. \
Read files as needed. Answer in the user's language and keep replies concise.";

#[derive(Debug, Deserialize)]
pub struct ClaudeChatRequest {
    pub request_id: String,
    pub prompt: String,
    pub cwd: String,
    pub session_id: String,
    pub resume: bool,
    pub allow_write: bool,
}

#[derive(Clone, Serialize)]
struct ChunkPayload {
    request_id: String,
    chunk: String,
}

#[derive(Clone, Serialize)]
struct StatusPayload {
    request_id: String,
    text: String,
}

#[derive(Clone, Serialize)]
struct DonePayload {
    request_id: String,
}

#[derive(Clone, Serialize)]
struct ErrorPayload {
    request_id: String,
    error: String,
}

type ChildHandle = Arc<tokio::sync::Mutex<tokio::process::Child>>;

fn runs() -> &'static Mutex<HashMap<String, ChildHandle>> {
    static RUNS: OnceLock<Mutex<HashMap<String, ChildHandle>>> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cancelled() -> &'static Mutex<HashSet<String>> {
    static CANCELLED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CANCELLED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn emit_error(app: &AppHandle, request_id: &str, error: &str) {
    let _ = app.emit(
        "solomd://claude-error",
        ErrorPayload {
            request_id: request_id.to_string(),
            error: error.to_string(),
        },
    );
}

/// Locate the `claude` executable. GUI-launched macOS apps get a bare PATH,
/// so we try the usual install locations before asking a login shell.
fn resolve_claude() -> Result<PathBuf, String> {
    static CACHED: OnceLock<PathBuf> = OnceLock::new();
    if let Some(p) = CACHED.get() {
        return Ok(p.clone());
    }

    if let Ok(raw) = std::env::var("SOLOMD_CLAUDE_BIN") {
        let p = PathBuf::from(raw);
        if p.is_file() {
            let _ = CACHED.set(p.clone());
            return Ok(p);
        }
    }

    let mut candidates = Vec::new();
    for var in ["HOME", "USERPROFILE"] {
        if let Some(home) = std::env::var_os(var) {
            let home = PathBuf::from(home);
            candidates.push(home.join(".claude/local/claude"));
            candidates.push(home.join(".local/bin/claude"));
            candidates.push(home.join(".npm-global/bin/claude"));
            candidates.push(home.join(".bun/bin/claude"));
        }
    }
    candidates.push(PathBuf::from("/usr/local/bin/claude"));
    candidates.push(PathBuf::from("/opt/homebrew/bin/claude"));
    for p in candidates {
        if p.is_file() {
            let _ = CACHED.set(p.clone());
            return Ok(p);
        }
    }

    #[cfg(windows)]
    let found = std::process::Command::new("where")
        .arg("claude")
        .output()
        .ok();

    #[cfg(not(windows))]
    let found = std::process::Command::new("sh")
        .args(["-lc", "command -v claude"])
        .output()
        .ok();

    if let Some(output) = found {
        if output.status.success() {
            if let Ok(text) = String::from_utf8(output.stdout) {
                if let Some(first) = text.lines().next() {
                    let p = PathBuf::from(first.trim());
                    if p.is_file() {
                        let _ = CACHED.set(p.clone());
                        return Ok(p);
                    }
                }
            }
        }
    }

    Err("找不到 claude CLI。请安装 Claude Code，或设置环境变量 SOLOMD_CLAUDE_BIN。".to_string())
}

#[tauri::command]
pub async fn claude_chat(app: AppHandle, request: ClaudeChatRequest) -> Result<(), String> {
    let bin = match resolve_claude() {
        Ok(p) => p,
        Err(e) => {
            emit_error(&app, &request.request_id, &e);
            return Ok(());
        }
    };
    if !PathBuf::from(&request.cwd).is_dir() {
        emit_error(
            &app,
            &request.request_id,
            &format!("目录不存在：{}", request.cwd),
        );
        return Ok(());
    }

    let mut cmd = Command::new(bin);
    cmd.current_dir(&request.cwd)
        .arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--include-partial-messages")
        .arg("--verbose")
        .arg("--append-system-prompt")
        .arg(SYSTEM_PROMPT)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if request.resume {
        cmd.arg("--resume").arg(&request.session_id);
    } else {
        cmd.arg("--session-id").arg(&request.session_id);
    }
    if request.allow_write {
        cmd.arg("--permission-mode").arg("acceptEdits");
    }
    cmd.arg("--allowedTools").args(["Read", "Grep", "Glob"]);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            emit_error(
                &app,
                &request.request_id,
                &format!("启动 claude 失败：{e}"),
            );
            return Ok(());
        }
    };

    let mut stdin = child.stdin.take().expect("stdin piped");
    let stdout = child.stdout.take().expect("stdout piped");
    let mut stderr = child.stderr.take().expect("stderr piped");

    let prompt = request.prompt.clone();
    tokio::spawn(async move {
        let _ = stdin.write_all(prompt.as_bytes()).await;
        drop(stdin);
    });

    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf).await;
        buf
    });

    let handle: ChildHandle = Arc::new(tokio::sync::Mutex::new(child));
    if let Ok(mut map) = runs().lock() {
        map.insert(request.request_id.clone(), handle.clone());
    }

    let app_for_run = app.clone();
    tokio::spawn(async move {
        run_stream(app_for_run, request, handle, stdout, stderr_task).await;
    });

    Ok(())
}

async fn run_stream(
    app: AppHandle,
    request: ClaudeChatRequest,
    child: ChildHandle,
    stdout: tokio::process::ChildStdout,
    stderr_task: tokio::task::JoinHandle<String>,
) {
    let rid = request.request_id.clone();
    let mut lines = BufReader::new(stdout).lines();
    let mut saw_done = false;
    let mut saw_error = false;

    while let Ok(Some(line)) = lines.next_line().await {
        for event in parse_stream_line(&line) {
            match event {
                CliEvent::Chunk(chunk) => {
                    let _ = app.emit(
                        "solomd://claude-chunk",
                        ChunkPayload {
                            request_id: rid.clone(),
                            chunk,
                        },
                    );
                }
                CliEvent::ToolStatus(text) => {
                    let _ = app.emit(
                        "solomd://claude-status",
                        StatusPayload {
                            request_id: rid.clone(),
                            text,
                        },
                    );
                }
                CliEvent::Error(error) => {
                    saw_error = true;
                    emit_error(&app, &rid, &error);
                }
                CliEvent::Done => saw_done = true,
            }
        }
    }

    let status = {
        let mut guard = child.lock().await;
        guard.wait().await
    };
    if let Ok(mut map) = runs().lock() {
        map.remove(&rid);
    }
    let stderr_text = stderr_task.await.unwrap_or_default();
    let was_cancelled = cancelled()
        .lock()
        .map(|mut set| set.remove(&rid))
        .unwrap_or(false);

    if was_cancelled {
        emit_error(&app, &rid, "cancelled");
        return;
    }
    if saw_error {
        return;
    }
    if saw_done {
        let _ = app.emit("solomd://claude-done", DonePayload { request_id: rid });
        return;
    }

    let detail = stderr_text
        .lines()
        .rev()
        .take(20)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    let msg = match status {
        Ok(s) if s.success() => "claude 没有返回结果就退出了".to_string(),
        Ok(s) => format!("claude 退出码 {}：{}", s.code().unwrap_or(-1), detail.trim()),
        Err(e) => format!("等待 claude 退出失败：{e}"),
    };
    emit_error(&app, &rid, msg.trim());
}

/// Kill the child process for `request_id`. Idempotent.
#[tauri::command]
pub async fn claude_cancel(request_id: String) -> Result<(), String> {
    if let Ok(mut set) = cancelled().lock() {
        set.insert(request_id.clone());
    }
    let handle = runs()
        .lock()
        .ok()
        .and_then(|map| map.get(&request_id).cloned());
    if let Some(handle) = handle {
        let mut guard = handle.lock().await;
        let _ = guard.start_kill();
    }
    Ok(())
}
```

- [ ] **Step 3: 注册命令**

在 `app/src-tauri/src/lib.rs` 的 `invoke_handler(tauri::generate_handler![` 列表里加两行（放在 `ai_proxy::ai_verify_key,` 附近）：

```rust
claude_cli::claude_chat,
claude_cli::claude_cancel,
```

- [ ] **Step 4: 编译检查**

Run: `cargo check --manifest-path app/src-tauri/Cargo.toml`

Expected: 编译通过，无 warning 级别的未使用导入。

- [ ] **Step 5: 手动冒烟（可选但推荐）**

在终端验证同样的参数能跑通（用一个临时目录，问一句简单的话）：

```bash
cd /tmp && claude -p --output-format stream-json --include-partial-messages --verbose --allowedTools Read Grep Glob "回复 ok" | head -5
```

Expected: 每行一个 JSON，出现 `stream_event` / `assistant` / `result`。若用户本机 claude 配置了第三方网关导致报错，记录报错原文，不做代码改动。

- [ ] **Step 6: 提交**

```bash
git add app/src-tauri/src/claude_cli.rs app/src-tauri/src/lib.rs app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock
git commit -m "feat(agent): run claude CLI and stream events"
```

---

### Task 3: 前端 store

**Files:**
- Modify: `app/src/stores/agentPanel.ts`

**Interfaces:**
- Produces: `source: 'api' | 'claude-cli'`、`cliFolder`、`cliSessionId`、`cliStarted`、`cliStatus`
- Produces: actions `openForFolder(path)`、`setSource(source)`、`clearSession()`

- [ ] **Step 1: 扩展 state**

在 `AgentPanelState` 接口里加：

```ts
  /** Which backend answers this panel. */
  source: 'api' | 'claude-cli';
  /** Folder the CLI runs in; set by the file-tree context menu. */
  cliFolder: string | null;
  /** UUID shared by every turn of one CLI conversation. */
  cliSessionId: string | null;
  /** True once at least one CLI turn finished — switches to `--resume`. */
  cliStarted: boolean;
  /** Human-readable tool activity ("Read notes/a.md"), cleared on done. */
  cliStatus: string | null;
```

在 `state: (): AgentPanelState => ({` 的对象里加：

```ts
    source: 'api',
    cliFolder: null,
    cliSessionId: null,
    cliStarted: false,
    cliStatus: null,
```

- [ ] **Step 2: 加 action 并让 clear() 复位会话**

把现有 `clear()` 替换为：

```ts
    clearSession() {
      this.messages = [];
      this.currentRunId = null;
      this.currentPersistRunId = null;
      this.isStreaming = false;
      this.cliSessionId = null;
      this.cliStarted = false;
      this.cliStatus = null;
    },
    clear() {
      this.clearSession();
    },
    /** File tree → Agent: scope the CLI to a folder and start a new chat. */
    openForFolder(path: string) {
      this.source = 'claude-cli';
      this.cliFolder = path;
      this.clearSession();
    },
    setSource(source: 'api' | 'claude-cli') {
      if (this.source === source) return;
      this.source = source;
      this.clearSession();
    },
```

- [ ] **Step 3: 类型检查**

Run: `cd app && pnpm exec vue-tsc --noEmit`

Expected: 通过（此时还没有组件引用新字段，不应报错）。

- [ ] **Step 4: 提交**

```bash
git add app/src/stores/agentPanel.ts
git commit -m "feat(agent): add claude-cli mode to panel store"
```

---

### Task 4: AgentPanel CLI 模式

**Files:**
- Modify: `app/src/components/AgentPanel.vue`

**Interfaces:**
- Consumes: store 字段（Task 3）、命令 `claude_chat` / `claude_cancel` 与事件（Task 2）

- [ ] **Step 1: 加 computed 和发送分支**

在 `const hasFolder = computed(...)` 附近替换为：

```ts
const isCli = computed(() => agent.source === 'claude-cli');

/** Last path segment, for the header chip. */
const cliFolderLabel = computed(() => {
  const p = agent.cliFolder || '';
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
});

const hasFolder = computed(() =>
  isCli.value ? !!agent.cliFolder : !!workspace.currentFolder,
);
const aiConfigured = computed(() => isCli.value || settings.aiEnabled);
```

在 `send()` 里，`const cfg = providerById(...)` 之前插入：

```ts
  if (isCli.value) {
    await sendCli(prompt);
    return;
  }
```

并在 `send()` 后面加：

```ts
async function sendCli(prompt: string) {
  const cwd = agent.cliFolder;
  if (!cwd) return;
  const requestId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (!agent.cliSessionId) {
    agent.cliSessionId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  agent.currentRunId = requestId;
  agent.isStreaming = true;
  agent.cliStatus = null;
  try {
    await invoke('claude_chat', {
      request: {
        request_id: requestId,
        prompt,
        cwd,
        session_id: agent.cliSessionId,
        resume: agent.cliStarted,
        allow_write: settings.agentAllowWrite,
      },
    });
  } catch (err) {
    agent.isStreaming = false;
    agent.currentRunId = null;
    errorMsg.value = String(err);
    const last = agent.messages[agent.messages.length - 1];
    if (last && last.role === 'assistant' && last.content === '') {
      agent.messages.pop();
    }
  }
}
```

- [ ] **Step 2: 停止按钮分支**

把 `stop()` 函数体替换为：

```ts
async function stop() {
  const id = agent.currentRunId;
  if (!id) return;
  try {
    if (isCli.value) {
      await invoke('claude_cancel', { requestId: id });
    } else {
      await invoke('ai_cancel', { requestId: id });
    }
  } catch {
    /* best-effort */
  }
  agent.isStreaming = false;
  agent.currentRunId = null;
  agent.cliStatus = null;
}
```

- [ ] **Step 3: 监听 CLI 事件**

在 `onMounted` 里现有 `unlistenRunStarted = await listen(...)` 之后加：

```ts
  unlistenClaudeChunk = await listen<{ request_id: string; chunk: string }>(
    'solomd://claude-chunk',
    (e) => {
      if (!agent.currentRunId || e.payload.request_id !== agent.currentRunId) return;
      agent.appendToLastAssistant(e.payload.chunk);
      autoscroll();
    },
  );
  unlistenClaudeStatus = await listen<{ request_id: string; text: string }>(
    'solomd://claude-status',
    (e) => {
      if (!agent.currentRunId || e.payload.request_id !== agent.currentRunId) return;
      agent.cliStatus = e.payload.text;
    },
  );
  unlistenClaudeDone = await listen<{ request_id: string }>(
    'solomd://claude-done',
    (e) => {
      if (!agent.currentRunId || e.payload.request_id !== agent.currentRunId) return;
      const last = agent.messages[agent.messages.length - 1];
      if (last && last.role === 'assistant' && last.content === '') {
        agent.messages.pop();
      }
      agent.isStreaming = false;
      agent.currentRunId = null;
      agent.cliStatus = null;
      agent.cliStarted = true;
    },
  );
  unlistenClaudeError = await listen<{ request_id: string; error: string }>(
    'solomd://claude-error',
    (e) => {
      if (!agent.currentRunId || e.payload.request_id !== agent.currentRunId) return;
      agent.isStreaming = false;
      agent.currentRunId = null;
      agent.cliStatus = null;
      const last = agent.messages[agent.messages.length - 1];
      if (last && last.role === 'assistant' && last.content === '') {
        agent.messages.pop();
      }
      if (e.payload.error !== 'cancelled') {
        errorMsg.value = e.payload.error;
      }
    },
  );
```

在 `let unlistenRunStarted: UnlistenFn | null = null;` 后加：

```ts
let unlistenClaudeChunk: UnlistenFn | null = null;
let unlistenClaudeStatus: UnlistenFn | null = null;
let unlistenClaudeDone: UnlistenFn | null = null;
let unlistenClaudeError: UnlistenFn | null = null;
```

在 `onBeforeUnmount` 里加对应 `?.()` 调用：

```ts
  unlistenClaudeChunk?.();
  unlistenClaudeStatus?.();
  unlistenClaudeDone?.();
  unlistenClaudeError?.();
  unlistenClaudeChunk = unlistenClaudeStatus = unlistenClaudeDone = unlistenClaudeError = null;
```

- [ ] **Step 4: 头部来源切换 + 目录标签**

在 imports 里加：

```ts
import { isMobile } from '../lib/platform';
```

在 `<header class="rp-head agent-panel__head">` 里，`<span class="agent-panel__beta">Beta</span>` 之后加：

```html
      <div class="agent-panel__source">
        <button
          class="rp-chip"
          :class="{ 'is-active agent-panel__chip--on': !isCli }"
          type="button"
          @click="agent.setSource('api')"
        >{{ t('agent.source.api') }}</button>
        <button
          v-if="!isMobile()"
          class="rp-chip"
          :class="{ 'is-active agent-panel__chip--on': isCli }"
          type="button"
          @click="agent.setSource('claude-cli')"
        >{{ t('agent.source.cli') }}</button>
      </div>
      <span
        v-if="isCli && agent.cliFolder"
        class="agent-panel__folder"
        :title="agent.cliFolder"
      >📁 {{ cliFolderLabel }}</span>
```

把"当前笔记"按钮的 `v-if` 从 `v-if="stateKey === 'ready'"` 改成：

```html
        v-if="stateKey === 'ready' && !isCli"
```

- [ ] **Step 5: 状态行**

在 `<div v-if="errorMsg" class="agent-panel__error">{{ errorMsg }}</div>` 之后加：

```html
      <div v-if="isCli && agent.cliStatus" class="agent-panel__status">
        {{ agent.cliStatus }}
      </div>
```

- [ ] **Step 6: 样式**

在 `<style scoped>` 里加：

```css
.agent-panel__source {
  display: inline-flex;
  gap: 4px;
  margin-right: 4px;
}
.agent-panel__folder {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-3);
  font-size: 11px;
}
.agent-panel__status {
  padding: 4px 12px;
  color: var(--text-3);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-top: 1px solid var(--border-1);
}
```

- [ ] **Step 7: 类型检查**

Run: `cd app && pnpm exec vue-tsc --noEmit`

Expected: 通过。

- [ ] **Step 8: 提交**

```bash
git add app/src/components/AgentPanel.vue
git commit -m "feat(agent): claude-cli mode in the agent panel"
```

---

### Task 5: 文件树菜单 + i18n

**Files:**
- Modify: `app/src/components/FileTree.vue`
- Modify: `app/src/i18n/en.ts`
- Modify: `app/src/i18n/zh.ts`

**Interfaces:**
- Consumes: `agentPanel.openForFolder(path)`（Task 3）、`settings.toggleAgentPanel()` / `ensureRightSidebarVisible()`（已存在）

- [ ] **Step 1: 导入与函数**

在 FileTree 的 imports 里加：

```ts
import { useAgentPanelStore } from '../stores/agentPanel';
import { IS_APP_STORE_BUILD } from '../lib/app-build';
```

在 `const browser = useBrowserStore();` 附近加：

```ts
const agentPanel = useAgentPanelStore();
```

在 `openFolderBrowser` 函数之后加：

```ts
/** 右键目录 → Agent：把 CLI 作用域设到该目录并打开右侧面板。 */
function openAgent(node: Node) {
  agentPanel.openForFolder(node.path);
  if (!settings.showAgentPanel) {
    settings.toggleAgentPanel();
  } else {
    settings.ensureRightSidebarVisible();
  }
  closeCtx();
}
```

- [ ] **Step 2: 菜单项**

在 `openFolderBrowser` 对应的 `<button>`（🌐 浏览器搜索）之后、"Only between..." 分隔线之前加：

```html
      <button
        v-if="ctx.node?.is_dir && !isMobile() && !IS_APP_STORE_BUILD"
        class="ftree__ctx-item"
        @click="openAgent(ctx.node)"
      >
        🤖 {{ t('explorer.agent') }}
      </button>
```

- [ ] **Step 3: i18n**

`app/src/i18n/en.ts`：

- `explorer` 对象里，`browserSearch` 后加：`agent: 'Agent',`
- `agent` 对象里，`heading` 后加：

```ts
    source: {
      api: 'API',
      cli: 'Claude CLI',
    },
    cliFolder: 'Folder: {path}',
```

`app/src/i18n/zh.ts`：

- `explorer` 对象里，`browserSearch` 后加：`agent: '智能体',`
- `agent` 对象里，`heading` 后加：

```ts
    source: {
      api: 'API',
      cli: 'Claude CLI',
    },
    cliFolder: '目录：{path}',
```

- [ ] **Step 4: 类型检查**

Run: `cd app && pnpm exec vue-tsc --noEmit`

Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add app/src/components/FileTree.vue app/src/i18n/en.ts app/src/i18n/zh.ts
git commit -m "feat(agent): directory context-menu entry for claude cli"
```

---

### Task 6: 整体验证

**Files:** 无（只跑验证）

- [ ] **Step 1: Rust 测试**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml claude_cli`

Expected: 全绿。

- [ ] **Step 2: 前端测试与类型检查**

Run: `cd app && pnpm test && pnpm exec vue-tsc --noEmit`

Expected: 现有测试全绿，类型检查通过。

- [ ] **Step 3: 手动验收**

`cd app && pnpm tauri dev`，然后：

1. 右键任意目录 → `🤖 Agent` → 右侧面板切到 Claude CLI，头部显示目录名。
2. 输入"这个目录里有哪些笔记？" → 文本流式出现；读文件时输入框上方出现状态行。
3. 追问"总结第一篇的要点" → 能引用上一轮（说明 `--resume` 生效）。
4. 流式中点"停止" → 进程结束、状态行消失、发送按钮恢复，无红色错误。
5. 点清空对话 → 再发一句 → 是全新会话。
6. 切回 API → 旧的面板行为不变。

- [ ] **Step 4: 最终提交（如有零散改动）**

```bash
git status --short
# 若有改动：
git add -A && git commit -m "chore(agent): verify claude cli integration"
```

---

## 已知取舍

- 不渲染工具调用的参数/结果卡片，只显示一行状态（spec 非目标）。
- 不做运行记录落盘；CLI 自己的 session 文件就是历史。
- 找不到 claude 时只报错，不提供设置界面（spec 非目标）。
- `ponytail:` 若后续接入第二个 CLI，再把“启动/流式/取消”抽成 trait；现在只有一个实现，不抽。
