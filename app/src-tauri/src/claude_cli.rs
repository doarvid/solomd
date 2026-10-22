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

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
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
            emit_error(&app, &request.request_id, &format!("启动 claude 失败：{e}"));
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
