//! Mobile stub for the ACP agent panel.
//!
//! The panel is desktop-only: there is no local agent CLI to spawn on iOS or
//! Android. Every command fails with a clear message instead of the panel
//! silently hanging.

use serde_json::Value;
use tauri::AppHandle;

fn unsupported<T>() -> Result<T, String> {
    Err("The agent panel is only available on desktop".into())
}

#[tauri::command]
pub async fn acp_list_agents() -> Result<Vec<Value>, String> {
    Ok(Vec::new())
}

#[tauri::command]
pub async fn acp_start_session(
    _app: AppHandle,
    _agent_id: String,
    _cwd: String,
) -> Result<Value, String> {
    unsupported()
}

#[tauri::command]
pub async fn acp_load_session(
    _app: AppHandle,
    _agent_id: String,
    _session_id: String,
    _cwd: String,
) -> Result<Value, String> {
    unsupported()
}

#[tauri::command]
pub async fn acp_send(_session_id: String, _prompt: String) -> Result<(), String> {
    unsupported()
}

#[tauri::command]
pub async fn acp_cancel(_session_id: String) -> Result<(), String> {
    unsupported()
}

#[tauri::command]
pub async fn acp_stop(_session_id: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn acp_respond_permission(
    _request_id: String,
    _option_id: Option<String>,
) -> Result<(), String> {
    unsupported()
}

#[tauri::command]
pub async fn acp_set_mode(_session_id: String, _mode_id: String) -> Result<(), String> {
    unsupported()
}

#[tauri::command]
pub async fn acp_list_sessions(_cwd: String) -> Result<Vec<Value>, String> {
    Ok(Vec::new())
}

#[tauri::command]
pub async fn acp_read_session(_cwd: String, _session_id: String) -> Result<Vec<Value>, String> {
    Ok(Vec::new())
}
