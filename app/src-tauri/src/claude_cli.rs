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
