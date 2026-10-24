//! Persistent ACP (Agent Client Protocol) client for the folder Agent panel.
//!
//! One background connection per panel session owns the local agent process.
//! Commands reach the agent through the connection handle; agent → client
//! requests (permissions, fs, terminals) are answered here and, where the
//! answer needs a human, round-trip to the Vue panel through Tauri events.
//!
//! Supported agents (nothing is bundled):
//! - opencode, via its native `opencode acp`
//! - Claude Code, via a global `claude-agent-acp`, else `npx -y <pinned>`

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use agent_client_protocol::schema::v1::{
    AgentCapabilities, CancelNotification, ClientCapabilities, ContentBlock,
    CreateTerminalRequest, CreateTerminalResponse, FileSystemCapabilities, Implementation,
    InitializeRequest, KillTerminalRequest, KillTerminalResponse, LoadSessionRequest,
    NewSessionRequest, PermissionOptionId, ReadTextFileRequest, ReadTextFileResponse,
    ReleaseTerminalRequest, ReleaseTerminalResponse, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, SelectedPermissionOutcome, SessionId,
    SessionNotification, SessionUpdate, SetSessionModeRequest, TerminalExitStatus, TerminalId,
    TerminalOutputRequest, TerminalOutputResponse, TextContent, WaitForTerminalExitRequest,
    WaitForTerminalExitResponse, WriteTextFileRequest, WriteTextFileResponse,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{
    on_receive_notification, on_receive_request, AcpAgent, AcpAgentConfig, Agent, Client,
    ConnectionTo, Responder,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{oneshot, Mutex as AsyncMutex, Notify};

/// Pinned Claude ACP adapter. Bump deliberately: adapters move fast.
const CLAUDE_ACP_PACKAGE: &str = "@agentclientprotocol/claude-agent-acp@0.94.0";
const MIN_NODE_MAJOR: u32 = 22;
const TERMINAL_OUTPUT_LIMIT: usize = 256 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub available: bool,
    pub reason: Option<String>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub agent_id: String,
    pub cwd: String,
    pub restored: bool,
    pub modes: Option<Value>,
    pub config_options: Option<Value>,
    pub agent_info: Option<Value>,
    pub load_session: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub agent_id: String,
    pub title: String,
    pub updated_at: u64,
}

#[derive(Clone)]
pub struct AcpState {
    rt: Runtime,
}

#[derive(Clone, Default)]
struct Runtime {
    sessions: Arc<Mutex<HashMap<String, SessionHandle>>>,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    terminals: Arc<Mutex<HashMap<String, Arc<TerminalEntry>>>>,
}

struct SessionHandle {
    connection: ConnectionTo<Agent>,
    acp_session_id: SessionId,
    cwd: PathBuf,
    busy: Arc<AtomicBool>,
    stopping: Arc<AtomicBool>,
    shutdown: Option<oneshot::Sender<()>>,
}

struct PendingPermission {
    session_id: String,
    tx: oneshot::Sender<Option<PermissionOptionId>>,
}

struct TerminalEntry {
    output: Arc<AsyncMutex<TerminalOutput>>,
    exit: Arc<AsyncMutex<Option<TerminalExitStatus>>>,
    notify: Arc<Notify>,
    child: Arc<AsyncMutex<Option<tokio::process::Child>>>,
}

#[derive(Default)]
struct TerminalOutput {
    text: String,
    truncated: bool,
}

impl AcpState {
    pub fn new() -> Self {
        Self {
            rt: Runtime::default(),
        }
    }
}

// ---------------------------------------------------------------- detection

/// Locate an executable. GUI-launched macOS apps get a bare PATH, so check the
/// usual install locations and finally ask a login shell.
fn resolve_bin(name: &str) -> Option<PathBuf> {
    let mut dirs = Vec::new();
    for var in ["HOME", "USERPROFILE"] {
        if let Some(home) = std::env::var_os(var) {
            let home = PathBuf::from(home);
            dirs.push(home.join(".local/bin"));
            dirs.push(home.join(".npm-global/bin"));
            dirs.push(home.join(".bun/bin"));
            dirs.push(home.join(".volta/bin"));
            dirs.push(home.join("bin"));
        }
    }
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            dirs.push(dir);
        }
    }
    for dir in dirs {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    #[cfg(windows)]
    let found = std::process::Command::new("where").arg(name).output().ok();
    #[cfg(not(windows))]
    let found = std::process::Command::new("sh")
        .args(["-lc", &format!("command -v {name}")])
        .output()
        .ok();

    let output = found?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let first = text.lines().next()?.trim();
    let path = PathBuf::from(first);
    path.is_file().then_some(path)
}

fn node_major(node: &Path) -> Option<u32> {
    let output = std::process::Command::new(node).arg("-v").output().ok()?;
    let text = String::from_utf8(output.stdout).ok()?;
    let text = text.trim().trim_start_matches('v');
    text.split('.').next()?.parse().ok()
}

/// Describe every supported agent and whether it can run right now.
pub fn detect_agents() -> Vec<AgentInfo> {
    let mut agents = Vec::new();

    match resolve_bin("opencode") {
        Some(path) => agents.push(AgentInfo {
            id: "opencode".into(),
            name: "opencode".into(),
            description: "Native ACP agent".into(),
            available: true,
            reason: None,
            detail: Some(path.display().to_string()),
        }),
        None => agents.push(AgentInfo {
            id: "opencode".into(),
            name: "opencode".into(),
            description: "Native ACP agent".into(),
            available: false,
            reason: Some("opencode is not installed".into()),
            detail: Some("Install opencode and make sure `opencode acp` works.".into()),
        }),
    }

    let global_adapter = resolve_bin("claude-agent-acp");
    let npx = resolve_bin("npx");
    let node = resolve_bin("node");
    let node_ok = node.as_deref().and_then(node_major).unwrap_or(0) >= MIN_NODE_MAJOR;

    let (available, reason, detail) = if let Some(path) = global_adapter {
        (
            true,
            None,
            Some(format!("ACP adapter: {}", path.display())),
        )
    } else if npx.is_some() && node_ok {
        (
            true,
            None,
            Some(format!(
                "ACP adapter via npx (first run downloads {CLAUDE_ACP_PACKAGE})"
            )),
        )
    } else if npx.is_none() {
        (
            false,
            Some("Neither claude-agent-acp nor npx was found".into()),
            Some("Install Node.js 22+ and the Claude ACP adapter.".into()),
        )
    } else {
        (
            false,
            Some(format!("Node.js {MIN_NODE_MAJOR}+ is required for the Claude adapter")),
            node.map(|p| format!("Found: {}", p.display())),
        )
    };

    agents.push(AgentInfo {
        id: "claude".into(),
        name: "Claude Code".into(),
        description: "Claude via the ACP adapter".into(),
        available,
        reason,
        detail,
    });
    agents
}

fn agent_config(agent_id: &str) -> Result<AcpAgentConfig, String> {
    match agent_id {
        "opencode" => {
            let path = resolve_bin("opencode")
                .ok_or_else(|| "opencode is not installed".to_string())?;
            Ok(AcpAgentConfig::new(path).arg("acp"))
        }
        "claude" => {
            if let Some(path) = resolve_bin("claude-agent-acp") {
                Ok(AcpAgentConfig::new(path))
            } else if let Some(npx) = resolve_bin("npx") {
                if resolve_bin("node").and_then(|n| node_major(&n)).unwrap_or(0) < MIN_NODE_MAJOR {
                    return Err(format!(
                        "The Claude ACP adapter needs Node.js {MIN_NODE_MAJOR}+"
                    ));
                }
                Ok(AcpAgentConfig::new(npx).args(["-y", CLAUDE_ACP_PACKAGE]))
            } else {
                Err("Install claude-agent-acp or Node.js 22+, then reopen the panel.".into())
            }
        }
        other => Err(format!("Unknown agent: {other}")),
    }
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub async fn acp_list_agents() -> Result<Vec<AgentInfo>, String> {
    Ok(detect_agents())
}

#[tauri::command]
pub async fn acp_start_session(
    app: AppHandle,
    state: State<'_, AcpState>,
    agent_id: String,
    cwd: String,
) -> Result<SessionInfo, String> {
    start_session(app, state.rt.clone(), agent_id, cwd, None).await
}

#[tauri::command]
pub async fn acp_load_session(
    app: AppHandle,
    state: State<'_, AcpState>,
    agent_id: String,
    session_id: String,
    cwd: String,
) -> Result<SessionInfo, String> {
    start_session(app, state.rt.clone(), agent_id, cwd, Some(session_id)).await
}

#[tauri::command]
pub async fn acp_send(
    app: AppHandle,
    state: State<'_, AcpState>,
    session_id: String,
    prompt: String,
) -> Result<(), String> {
    let (connection, acp_session_id, busy, cwd) = {
        let sessions = state.rt.sessions.lock().unwrap();
        let handle = sessions
            .get(&session_id)
            .ok_or_else(|| "This session is no longer running".to_string())?;
        (
            handle.connection.clone(),
            handle.acp_session_id.clone(),
            handle.busy.clone(),
            handle.cwd.clone(),
        )
    };
    if busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("The agent is still working on the previous message".into());
    }
    // Persist the prompt here: ACP's `UserMessageChunk` is not forwarded by
    // every agent, so the transcript would otherwise only hold replies and
    // the history list would have no title to show.
    append_transcript(
        &cwd,
        &acp_session_id.0.to_string(),
        &json!({ "type": "user", "text": prompt }),
    );

    tokio::spawn(async move {
        let request = agent_client_protocol::schema::v1::PromptRequest::new(
            acp_session_id,
            vec![ContentBlock::Text(TextContent::new(prompt))],
        );
        let result = connection.send_request(request).block_task().await;
        busy.store(false, Ordering::SeqCst);
        match result {
            Ok(response) => {
                let _ = app.emit(
                    "solomd://acp-done",
                    json!({
                        "sessionId": session_id,
                        "stopReason": response.stop_reason,
                    }),
                );
            }
            Err(error) => emit_error(&app, &session_id, &error.to_string()),
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn acp_cancel(state: State<'_, AcpState>, session_id: String) -> Result<(), String> {
    let target = {
        let sessions = state.rt.sessions.lock().unwrap();
        sessions
            .get(&session_id)
            .map(|handle| (handle.connection.clone(), handle.acp_session_id.clone()))
    };
    let Some((connection, acp_session)) = target else {
        return Ok(());
    };
    connection
        .send_notification(CancelNotification::new(acp_session))
        .map_err(|error| error.to_string())?;
    answer_pending_permissions(&state.rt, &session_id, None);
    Ok(())
}

#[tauri::command]
pub async fn acp_stop(state: State<'_, AcpState>, session_id: String) -> Result<(), String> {
    let handle = state.rt.sessions.lock().unwrap().remove(&session_id);
    answer_pending_permissions(&state.rt, &session_id, None);
    if let Some(mut handle) = handle {
        handle.stopping.store(true, Ordering::SeqCst);
        if let Some(shutdown) = handle.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn acp_respond_permission(
    state: State<'_, AcpState>,
    request_id: String,
    option_id: Option<String>,
) -> Result<(), String> {
    let pending = state
        .rt
        .pending_permissions
        .lock()
        .unwrap()
        .remove(&request_id);
    if let Some(pending) = pending {
        let _ = pending
            .tx
            .send(option_id.map(PermissionOptionId::new));
    }
    Ok(())
}

#[tauri::command]
pub async fn acp_set_mode(
    state: State<'_, AcpState>,
    session_id: String,
    mode_id: String,
) -> Result<(), String> {
    let (connection, acp_session_id) = {
        let sessions = state.rt.sessions.lock().unwrap();
        let handle = sessions
            .get(&session_id)
            .ok_or_else(|| "This session is no longer running".to_string())?;
        (handle.connection.clone(), handle.acp_session_id.clone())
    };
    connection
        .send_request(SetSessionModeRequest::new(acp_session_id, mode_id))
        .block_task()
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn acp_list_sessions(cwd: String) -> Result<Vec<SessionSummary>, String> {
    list_sessions(&cwd)
}

#[tauri::command]
pub async fn acp_read_session(cwd: String, session_id: String) -> Result<Vec<Value>, String> {
    read_transcript(&cwd, &session_id)
}

fn answer_pending_permissions(rt: &Runtime, session_id: &str, option: Option<String>) {
    let mut pending = rt.pending_permissions.lock().unwrap();
    let ids: Vec<String> = pending
        .iter()
        .filter(|(_, value)| value.session_id == session_id)
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        if let Some(entry) = pending.remove(&id) {
            let _ = entry
                .tx
                .send(option.as_ref().map(|value| PermissionOptionId::new(value.clone())));
        }
    }
}

fn emit_error(app: &AppHandle, session_id: &str, error: &str) {
    let _ = app.emit(
        "solomd://acp-error",
        json!({ "sessionId": session_id, "error": error }),
    );
}

async fn start_session(
    app: AppHandle,
    rt: Runtime,
    agent_id: String,
    cwd: String,
    load_id: Option<String>,
) -> Result<SessionInfo, String> {
    let cwd_path = PathBuf::from(&cwd);
    if !cwd_path.is_dir() {
        return Err(format!("Folder does not exist: {cwd}"));
    }
    let config = agent_config(&agent_id)?;

    let (info_tx, info_rx) = oneshot::channel::<Result<SessionInfo, String>>();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    let task_rt = rt.clone();
    let task_app = app.clone();
    let task_cwd = cwd_path.clone();
    let task_agent_id = agent_id.clone();
    let info_tx = Arc::new(Mutex::new(Some(info_tx)));
    let info_slot = info_tx.clone();
    tokio::spawn(async move {
        let active = Arc::new(AtomicBool::new(false));
        let stopping = Arc::new(AtomicBool::new(false));
        let sid_slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let capabilities = ClientCapabilities::new()
            .fs(
                FileSystemCapabilities::new()
                    .read_text_file(true)
                    .write_text_file(true),
            )
            .terminal(true);

        let main_active = active.clone();
        let main_sid = sid_slot.clone();
        let main_stopping = stopping.clone();
        let main_rt = task_rt.clone();
        let connect_result = Client
            .builder()
            .name("SoloMD")
            .on_receive_notification(
                {
                    let app = task_app.clone();
                    let cwd = task_cwd.clone();
                    let active = active.clone();
                    async move |notification: SessionNotification, _cx| {
                        handle_session_update(&app, &cwd, &active, notification);
                        Ok(())
                    }
                },
                on_receive_notification!(),
            )
            .on_receive_request(
                {
                    let app = task_app.clone();
                    let pending = task_rt.pending_permissions.clone();
                    async move |request: RequestPermissionRequest, responder, _cx| {
                        handle_permission_request(app.clone(), pending.clone(), request, responder)
                            .await
                    }
                },
                on_receive_request!(),
            )
            .on_receive_request(
                {
                    let cwd = task_cwd.clone();
                    async move |request: ReadTextFileRequest, responder, _cx| {
                        respond_read_file(&cwd, request, responder)
                    }
                },
                on_receive_request!(),
            )
            .on_receive_request(
                {
                    let cwd = task_cwd.clone();
                    async move |request: WriteTextFileRequest, responder, _cx| {
                        respond_write_file(&cwd, request, responder)
                    }
                },
                on_receive_request!(),
            )
            .on_receive_request(
                {
                    let cwd = task_cwd.clone();
                    let terminals = task_rt.terminals.clone();
                    async move |request: CreateTerminalRequest, responder, _cx| {
                        create_terminal(&cwd, &terminals, request, responder).await
                    }
                },
                on_receive_request!(),
            )
            .on_receive_request(
                {
                    let terminals = task_rt.terminals.clone();
                    async move |request: TerminalOutputRequest, responder, _cx| {
                        terminal_output(&terminals, request, responder).await
                    }
                },
                on_receive_request!(),
            )
            .on_receive_request(
                {
                    let terminals = task_rt.terminals.clone();
                    async move |request: WaitForTerminalExitRequest, responder, _cx| {
                        wait_for_terminal(&terminals, request, responder).await
                    }
                },
                on_receive_request!(),
            )
            .on_receive_request(
                {
                    let terminals = task_rt.terminals.clone();
                    async move |request: KillTerminalRequest, responder, _cx| {
                        kill_terminal(&terminals, request, responder).await
                    }
                },
                on_receive_request!(),
            )
            .on_receive_request(
                {
                    let terminals = task_rt.terminals.clone();
                    async move |request: ReleaseTerminalRequest, responder, _cx| {
                        release_terminal(&terminals, request, responder).await
                    }
                },
                on_receive_request!(),
            )
            .connect_with(AcpAgent::new(config), async move |cx| {
                let init = cx
                    .send_request(
                        InitializeRequest::new(ProtocolVersion::V1)
                            .client_capabilities(capabilities)
                            .client_info(Implementation::new("solomd", env!("CARGO_PKG_VERSION"))),
                    )
                    .block_task()
                    .await?;
                let agent_caps: AgentCapabilities = init.agent_capabilities;

                let (session_id, restored, modes, config_options) = match load_id.as_ref() {
                    Some(id) if agent_caps.load_session => {
                        match cx
                            .send_request(LoadSessionRequest::new(id.clone(), task_cwd.clone()))
                            .block_task()
                            .await
                        {
                            Ok(response) => (
                                SessionId::new(id.clone()),
                                true,
                                response.modes,
                                response.config_options,
                            ),
                            Err(_) => {
                                let response = cx
                                    .send_request(NewSessionRequest::new(task_cwd.clone()))
                                    .block_task()
                                    .await?;
                                (
                                    response.session_id,
                                    false,
                                    response.modes,
                                    response.config_options,
                                )
                            }
                        }
                    }
                    _ => {
                        let response = cx
                            .send_request(NewSessionRequest::new(task_cwd.clone()))
                            .block_task()
                            .await?;
                        (
                            response.session_id,
                            false,
                            response.modes,
                            response.config_options,
                        )
                    }
                };

                let session_key = session_id.0.to_string();
                *main_sid.lock().unwrap() = Some(session_key.clone());
                let info = SessionInfo {
                    session_id: session_key.clone(),
                    agent_id: task_agent_id.clone(),
                    cwd: task_cwd.display().to_string(),
                    restored,
                    modes: modes.and_then(|value| serde_json::to_value(value).ok()),
                    config_options: config_options
                        .and_then(|value| serde_json::to_value(value).ok()),
                    agent_info: init
                        .agent_info
                        .as_ref()
                        .and_then(|value| serde_json::to_value(value).ok()),
                    load_session: agent_caps.load_session,
                };
                write_meta_line(&task_cwd, &session_key, &task_agent_id);

                main_rt.sessions.lock().unwrap().insert(
                    session_key.clone(),
                    SessionHandle {
                        connection: cx.clone(),
                        acp_session_id: session_id,
                        cwd: task_cwd.clone(),
                        busy: Arc::new(AtomicBool::new(false)),
                        stopping: main_stopping.clone(),
                        shutdown: Some(shutdown_tx),
                    },
                );
                main_active.store(true, Ordering::SeqCst);
                if let Some(tx) = info_slot.lock().unwrap().take() {
                    let _ = tx.send(Ok(info));
                }

                let close_cx = cx.clone();
                tokio::select! {
                    _ = shutdown_rx => {}
                    _ = close_cx.incoming_closed() => {}
                }
                Ok(())
            })
            .await;

        active.store(false, Ordering::SeqCst);
        let session_key = sid_slot.lock().unwrap().clone();
        if let Some(key) = session_key {
            task_rt.sessions.lock().unwrap().remove(&key);
            if !stopping.load(Ordering::SeqCst) {
                let message = match &connect_result {
                    Ok(()) => "The agent connection closed".to_string(),
                    Err(error) => error.to_string(),
                };
                emit_error(&task_app, &key, &message);
            }
        }
        if let Some(tx) = info_tx.lock().unwrap().take() {
            let _ = tx.send(Err(match &connect_result {
                Ok(()) => "The agent closed before the session started".to_string(),
                Err(error) => error.to_string(),
            }));
        }
    });

    match info_rx.await {
        Ok(Ok(info)) => Ok(info),
        Ok(Err(error)) => Err(error),
        Err(_) => Err("The agent connection closed before the session started".to_string()),
    }
}

// ---------------------------------------------------------------- agent → client

async fn handle_permission_request(
    app: AppHandle,
    pending: Arc<Mutex<HashMap<String, PendingPermission>>>,
    request: RequestPermissionRequest,
    responder: Responder<RequestPermissionResponse>,
) -> Result<(), agent_client_protocol::Error> {
    let request_id = unique_id("perm");
    let session_id = request.session_id.0.to_string();
    let (tx, rx) = oneshot::channel();
    pending.lock().unwrap().insert(
        request_id.clone(),
        PendingPermission {
            session_id: session_id.clone(),
            tx,
        },
    );
    let payload = json!({
        "requestId": request_id,
        "sessionId": session_id,
        "toolCall": request.tool_call,
        "options": request.options,
    });
    let _ = app.emit("solomd://acp-permission", payload);

    let option = rx.await.ok().flatten();
    let outcome = match option {
        Some(id) => RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(id)),
        None => RequestPermissionOutcome::Cancelled,
    };
    responder.respond(RequestPermissionResponse::new(outcome))
}

fn respond_read_file(
    cwd: &Path,
    request: ReadTextFileRequest,
    responder: Responder<ReadTextFileResponse>,
) -> Result<(), agent_client_protocol::Error> {
    let path = match resolve_inside(cwd, &request.path, false) {
        Ok(path) => path,
        Err(error) => return responder.respond_with_internal_error(error),
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) => return responder.respond_with_internal_error(error.to_string()),
    };
    let content = slice_lines(&content, request.line, request.limit);
    responder.respond(ReadTextFileResponse::new(content))
}

fn respond_write_file(
    cwd: &Path,
    request: WriteTextFileRequest,
    responder: Responder<WriteTextFileResponse>,
) -> Result<(), agent_client_protocol::Error> {
    let path = match resolve_inside(cwd, &request.path, true) {
        Ok(path) => path,
        Err(error) => return responder.respond_with_internal_error(error),
    };
    if let Some(parent) = path.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            return responder.respond_with_internal_error(error.to_string());
        }
    }
    if let Err(error) = std::fs::write(&path, request.content.as_bytes()) {
        return responder.respond_with_internal_error(error.to_string());
    }
    let _ = responder.respond(WriteTextFileResponse::new());
    Ok(())
}

async fn create_terminal(
    cwd: &Path,
    terminals: &Arc<Mutex<HashMap<String, Arc<TerminalEntry>>>>,
    request: CreateTerminalRequest,
    responder: Responder<CreateTerminalResponse>,
) -> Result<(), agent_client_protocol::Error> {
    let working_dir = match request.cwd.as_deref() {
        Some(path) => match resolve_inside(cwd, path, true) {
            Ok(path) => path,
            Err(error) => return responder.respond_with_internal_error(error),
        },
        None => cwd.to_path_buf(),
    };
    let mut command = Command::new(&request.command);
    command
        .args(&request.args)
        .current_dir(&working_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    for env in &request.env {
        command.env(&env.name, &env.value);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return responder.respond_with_internal_error(format!(
                "Could not start {}: {error}",
                request.command
            ))
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let output = Arc::new(AsyncMutex::new(TerminalOutput::default()));
    let limit = request
        .output_byte_limit
        .map(|value| value as usize)
        .unwrap_or(TERMINAL_OUTPUT_LIMIT)
        .min(TERMINAL_OUTPUT_LIMIT * 4);
    if let Some(stdout) = stdout {
        spawn_reader(stdout, output.clone(), limit);
    }
    if let Some(stderr) = stderr {
        spawn_reader(stderr, output.clone(), limit);
    }

    let exit = Arc::new(AsyncMutex::new(None::<TerminalExitStatus>));
    let notify = Arc::new(Notify::new());
    let child = Arc::new(AsyncMutex::new(Some(child)));
    {
        let child = child.clone();
        let exit = exit.clone();
        let notify = notify.clone();
        tokio::spawn(async move {
            loop {
                let status = {
                    let mut guard = child.lock().await;
                    match guard.as_mut() {
                        Some(child) => child.try_wait(),
                        None => break,
                    }
                };
                match status {
                    Ok(Some(status)) => {
                        let mut slot = exit.lock().await;
                        *slot = Some(exit_status(status));
                        notify.notify_one();
                        break;
                    }
                    Ok(None) => tokio::time::sleep(Duration::from_millis(60)).await,
                    Err(_) => break,
                }
            }
        });
    }

    // ponytail: 60 ms poll loop instead of a waiter task; fine for agent tools,
    // swap for a Child::wait task if terminal churn ever matters.
    let terminal_id = unique_id("term");
    terminals.lock().unwrap().insert(
        terminal_id.clone(),
        Arc::new(TerminalEntry {
            output,
            exit,
            notify,
            child,
        }),
    );
    responder.respond(CreateTerminalResponse::new(TerminalId::new(terminal_id)))
}

fn spawn_reader<R>(mut reader: R, output: Arc<AsyncMutex<TerminalOutput>>, limit: usize)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let chunk = String::from_utf8_lossy(&buffer[..count]).to_string();
                    let mut output = output.lock().await;
                    output.text.push_str(&chunk);
                    if output.text.len() > limit {
                        output.truncated = true;
                        trim_to_char_boundary(&mut output.text, limit);
                    }
                }
            }
        }
    });
}

async fn terminal_output(
    terminals: &Arc<Mutex<HashMap<String, Arc<TerminalEntry>>>>,
    request: TerminalOutputRequest,
    responder: Responder<TerminalOutputResponse>,
) -> Result<(), agent_client_protocol::Error> {
    let entry = terminal_entry(terminals, &request.terminal_id);
    let Some(entry) = entry else {
        return responder.respond_with_internal_error("Unknown terminal");
    };
    let output = entry.output.lock().await;
    let exit = entry.exit.lock().await.clone();
    responder.respond(
        TerminalOutputResponse::new(output.text.clone(), output.truncated).exit_status(exit),
    )
}

async fn wait_for_terminal(
    terminals: &Arc<Mutex<HashMap<String, Arc<TerminalEntry>>>>,
    request: WaitForTerminalExitRequest,
    responder: Responder<WaitForTerminalExitResponse>,
) -> Result<(), agent_client_protocol::Error> {
    let entry = terminal_entry(terminals, &request.terminal_id);
    let Some(entry) = entry else {
        return responder.respond_with_internal_error("Unknown terminal");
    };
    loop {
        if let Some(status) = entry.exit.lock().await.clone() {
            return responder.respond(WaitForTerminalExitResponse::new(status));
        }
        entry.notify.notified().await;
    }
}

async fn kill_terminal(
    terminals: &Arc<Mutex<HashMap<String, Arc<TerminalEntry>>>>,
    request: KillTerminalRequest,
    responder: Responder<KillTerminalResponse>,
) -> Result<(), agent_client_protocol::Error> {
    if let Some(entry) = terminal_entry(terminals, &request.terminal_id) {
        if let Some(child) = entry.child.lock().await.as_mut() {
            let _ = child.start_kill();
        }
    }
    let _ = responder.respond(KillTerminalResponse::new());
    Ok(())
}

async fn release_terminal(
    terminals: &Arc<Mutex<HashMap<String, Arc<TerminalEntry>>>>,
    request: ReleaseTerminalRequest,
    responder: Responder<ReleaseTerminalResponse>,
) -> Result<(), agent_client_protocol::Error> {
    let entry = terminals
        .lock()
        .unwrap()
        .remove(&request.terminal_id.0.to_string());
    if let Some(entry) = entry {
        if let Some(child) = entry.child.lock().await.as_mut() {
            let _ = child.start_kill();
        }
    }
    let _ = responder.respond(ReleaseTerminalResponse::new());
    Ok(())
}

fn terminal_entry(
    terminals: &Arc<Mutex<HashMap<String, Arc<TerminalEntry>>>>,
    id: &TerminalId,
) -> Option<Arc<TerminalEntry>> {
    terminals.lock().unwrap().get(&id.0.to_string()).cloned()
}

// ---------------------------------------------------------------- updates

fn handle_session_update(
    app: &AppHandle,
    cwd: &Path,
    active: &Arc<AtomicBool>,
    notification: SessionNotification,
) {
    if !active.load(Ordering::SeqCst) {
        return;
    }
    let Some(update) = map_update(&notification.update) else {
        return;
    };
    let session_id = notification.session_id.0.to_string();
    append_transcript(cwd, &session_id, &update);
    let _ = app.emit(
        "solomd://acp-update",
        json!({ "sessionId": session_id, "update": update }),
    );
}

fn map_update(update: &SessionUpdate) -> Option<Value> {
    match update {
        SessionUpdate::AgentMessageChunk(chunk) => {
            content_text(&chunk.content).map(|text| json!({ "type": "text", "text": text }))
        }
        SessionUpdate::AgentThoughtChunk(chunk) => {
            content_text(&chunk.content).map(|text| json!({ "type": "thought", "text": text }))
        }
        SessionUpdate::UserMessageChunk(_) => None,
        SessionUpdate::ToolCall(tool) => {
            Some(json!({ "type": "tool_call", "toolCall": tool }))
        }
        SessionUpdate::ToolCallUpdate(tool) => {
            Some(json!({ "type": "tool_call_update", "toolCallUpdate": tool }))
        }
        SessionUpdate::Plan(plan) => Some(json!({ "type": "plan", "plan": plan })),
        SessionUpdate::AvailableCommandsUpdate(commands) => {
            Some(json!({ "type": "commands", "availableCommands": commands }))
        }
        SessionUpdate::CurrentModeUpdate(mode) => {
            Some(json!({ "type": "mode", "currentModeId": mode.current_mode_id }))
        }
        SessionUpdate::ConfigOptionUpdate(config) => {
            Some(json!({ "type": "config", "configOptions": config }))
        }
        SessionUpdate::SessionInfoUpdate(info) => {
            Some(json!({ "type": "session_info", "info": info }))
        }
        SessionUpdate::UsageUpdate(usage) => {
            Some(json!({ "type": "usage", "usage": usage }))
        }
        SessionUpdate::Notice(notice) => {
            Some(json!({ "type": "notice", "notice": notice }))
        }
        _ => None,
    }
}

fn content_text(content: &ContentBlock) -> Option<String> {
    match content {
        ContentBlock::Text(text) => Some(text.text.clone()),
        _ => None,
    }
}

// ---------------------------------------------------------------- storage

fn sessions_dir(cwd: &Path) -> PathBuf {
    cwd.join(".solomd").join("acp-sessions")
}

fn transcript_path(cwd: &Path, session_id: &str) -> PathBuf {
    sessions_dir(cwd).join(format!("{}.jsonl", safe_id(session_id)))
}

fn safe_id(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "session".into()
    } else {
        cleaned
    }
}

fn write_meta_line(cwd: &Path, session_id: &str, agent_id: &str) {
    let path = transcript_path(cwd, session_id);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let line = json!({
        "type": "meta",
        "sessionId": session_id,
        "agentId": agent_id,
        "cwd": cwd.display().to_string(),
        "createdAt": unix_now(),
    });
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| std::io::Write::write_all(&mut file, format!("{line}\n").as_bytes()));
}

fn append_transcript(cwd: &Path, session_id: &str, update: &Value) {
    let path = transcript_path(cwd, session_id);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| std::io::Write::write_all(&mut file, format!("{update}\n").as_bytes()));
}

fn list_sessions(cwd: &str) -> Result<Vec<SessionSummary>, String> {
    let dir = sessions_dir(Path::new(cwd));
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        let updated_at = std::fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let mut agent_id = String::new();
        let mut session_id = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string();
        let mut title = String::new();
        let mut has_user_title = false;
        for line in text.lines() {
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            match value.get("type").and_then(Value::as_str) {
                Some("meta") => {
                    agent_id = value
                        .get("agentId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    session_id = value
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or(&session_id)
                        .to_string();
                }
                Some(kind @ ("user" | "text")) if title.is_empty() || (kind == "user" && !has_user_title) => {
                    if kind == "user" {
                        has_user_title = true;
                    }
                    title = value
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .chars()
                        .take(80)
                        .collect();
                }
                _ => {}
            }
        }
        if title.trim().is_empty() {
            title = "New session".into();
        }
        out.push(SessionSummary {
            id: session_id,
            agent_id,
            title,
            updated_at,
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out.truncate(50);
    Ok(out)
}

fn read_transcript(cwd: &str, session_id: &str) -> Result<Vec<Value>, String> {
    let path = transcript_path(Path::new(cwd), session_id);
    let text = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    Ok(text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect())
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------- helpers

static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique_id(prefix: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!(
        "{prefix}-{millis}-{}",
        ID_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

/// Resolve `path` under `cwd`, rejecting escapes. Existing files are
/// canonicalised so `..` cannot walk out; writes of new files check the
/// canonical parent instead.
fn resolve_inside(cwd: &Path, path: &Path, for_write: bool) -> Result<PathBuf, String> {
    let base = cwd
        .canonicalize()
        .map_err(|error| format!("Workspace unavailable: {error}"))?;
    let target = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    if !for_write && target.exists() {
        let checked = target
            .canonicalize()
            .map_err(|error| format!("Path is outside the workspace: {error}"))?;
        return checked
            .starts_with(&base)
            .then_some(checked)
            .ok_or_else(|| "Path is outside the workspace".to_string());
    }

    // For a write the file may not exist yet: walk up to the nearest existing
    // ancestor, canonicalise it, and check that. `create_dir_all` later fills
    // in the missing part.
    let mut existing = target
        .parent()
        .ok_or_else(|| "Invalid path".to_string())?
        .to_path_buf();
    while !existing.exists() {
        existing = existing
            .parent()
            .ok_or_else(|| "Invalid path".to_string())?
            .to_path_buf();
    }
    let canonical = existing
        .canonicalize()
        .map_err(|error| format!("Path is outside the workspace: {error}"))?;
    if !canonical.starts_with(&base) {
        return Err("Path is outside the workspace".into());
    }
    Ok(target)
}

fn slice_lines(content: &str, line: Option<u32>, limit: Option<u32>) -> String {
    if line.is_none() && limit.is_none() {
        return content.to_string();
    }
    let start = line.unwrap_or(1).max(1) as usize - 1;
    let take = limit.unwrap_or(u32::MAX) as usize;
    content
        .lines()
        .skip(start)
        .take(take)
        .collect::<Vec<_>>()
        .join("\n")
}

fn trim_to_char_boundary(text: &mut String, limit: usize) {
    let mut cut = text.len().saturating_sub(limit);
    while cut < text.len() && !text.is_char_boundary(cut) {
        cut += 1;
    }
    *text = text[cut..].to_string();
}

fn exit_status(status: std::process::ExitStatus) -> TerminalExitStatus {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return TerminalExitStatus::new()
                .signal(format!("signal {signal}"));
        }
    }
    TerminalExitStatus::new().exit_code(status.code().map(|code| code.max(0) as u32))
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_id_replaces_path_separators() {
        assert_eq!(safe_id("a/b c"), "a_b_c");
        assert_eq!(safe_id(""), "session");
    }

    #[test]
    fn slice_lines_is_one_based() {
        assert_eq!(slice_lines("a\nb\nc", Some(2), Some(1)), "b");
        assert_eq!(slice_lines("a\nb\nc", None, Some(2)), "a\nb");
    }

    #[test]
    fn resolve_inside_rejects_escape() {
        let dir = tempfile::tempdir().unwrap();
        let inside = resolve_inside(dir.path(), Path::new("../nope"), true);
        assert!(inside.is_err());
        let ok = resolve_inside(dir.path(), Path::new("notes.md"), true).unwrap();
        assert_eq!(ok, dir.path().canonicalize().unwrap().join("notes.md"));
    }

    #[test]
    fn trim_keeps_tail_and_char_boundary() {
        let mut text = "abc你好".to_string();
        trim_to_char_boundary(&mut text, 5);
        assert_eq!(text, "好");
    }

    #[test]
    fn detection_reports_two_agents() {
        let agents = detect_agents();
        assert_eq!(agents.len(), 2);
        assert!(agents.iter().any(|agent| agent.id == "opencode"));
        assert!(agents.iter().any(|agent| agent.id == "claude"));
    }

    #[test]
    fn transcript_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path();
        write_meta_line(cwd, "s1", "opencode");
        append_transcript(cwd, "s1", &json!({"type":"text","text":"hi"}));
        let items = read_transcript(&cwd.display().to_string(), "s1").unwrap();
        assert_eq!(items.len(), 2);
        let list = list_sessions(&cwd.display().to_string()).unwrap();
        assert_eq!(list[0].id, "s1");
        assert_eq!(list[0].title, "hi");
        assert_eq!(list[0].agent_id, "opencode");
    }
}
