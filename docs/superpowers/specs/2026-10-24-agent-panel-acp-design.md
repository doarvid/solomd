# Agent Panel over ACP — Design

Date: 2026-10-24
Status: approved in conversation (user asleep, autonomous implementation authorized)

## Goal

Replace the one-shot `claude -p` integration in the folder Agent panel with a
persistent ACP (Agent Client Protocol) client, so the panel supports streaming,
live tool cards, per-tool permission prompts, cancellation and session restore
with a Zed-like interaction model.

The feature is gated on locally installed agents. Nothing is bundled.

## Decisions

- **Supported agents in v1**
  - `opencode` — native, `opencode acp`.
  - Claude — via the ACP adapter: use a globally installed
    `claude-agent-acp` when present; otherwise fall back to
    `npx -y @agentclientprotocol/claude-agent-acp@0.94.0`.
- **No sidecar bundling.** If neither agent is found the panel shows setup
  instructions and stays disabled.
- **Client capabilities**: advertise `fs.read_text_file`, `fs.write_text_file`
  and `terminal: true`. Do not advertise unstable capabilities.
- **Session scope**: one live ACP session per panel. Switching agent starts a
  new session. History is persisted per workspace and listed in the panel.
- **Existing `api` source stays.** ACP replaces only the `claude-cli` source.

## Architecture

```
Vue AgentPanel ──invoke──▶ Tauri commands ──mpsc──▶ ACP connection task
      ▲                         │                        │
      └──── Tauri events ◀──────┘◀──── callbacks ────────┘
                                                     (agent subprocess)
```

- `agent-client-protocol = { version = "3.5", features = ["process"] }`
- New desktop-only module `acp.rs` (mobile gets a stub, mirroring `browser`).
- One background task per session owns the agent process and the
  `ActiveSession`. Commands reach it through an unbounded channel; updates go
  out as Tauri events.
- Inbound agent→client requests (`session/request_permission`, `fs/*`,
  `terminal/*`) are handled in `on_receive_request` callbacks. Permission and
  unsaved-buffer decisions round-trip to the frontend through oneshot channels.

## Frontend event contract

`solomd://acp-update` — payload `{ sessionId, update }`, where `update` is a
tagged union:

| type | fields | UI |
|---|---|---|
| `text` | `text` | append to assistant bubble |
| `thought` | `text` | collapsible reasoning block |
| `tool_call` | `toolCall` | insert tool card |
| `tool_call_update` | `toolCallUpdate` | patch tool card |
| `plan` | `plan` | plan panel |
| `commands` | `availableCommands` | slash menu |
| `mode` | `currentModeId`, `availableModes` | mode chip |
| `usage` | `used`, `size`, `cost` | footer meter |
| `notice` | `content` | inline notice |

`solomd://acp-permission` — `{ requestId, sessionId, toolCall, options }`.
Reply with `acp_respond_permission`.

`solomd://acp-done` — `{ sessionId, stopReason }`
`solomd://acp-error` — `{ sessionId, error }`

## Commands

- `acp_list_agents() -> Vec<AgentInfo>`
- `acp_start_session(agentId, cwd) -> SessionInfo`
- `acp_send(sessionId, prompt)`
- `acp_cancel(sessionId)`
- `acp_stop(sessionId)`
- `acp_respond_permission(requestId, optionId | null)`
- `acp_set_mode(sessionId, modeId)`
- `acp_list_sessions(cwd)` / `acp_load_session(sessionId, cwd)`

`SessionInfo` carries `sessionId`, `modes`, `configOptions`, `plan`,
`availableCommands`, and the agent's capabilities.

## Interaction details

- **Sending**: Enter sends; Shift+Enter newline; IME composition guard kept.
  The composer stays disabled while a turn is streaming.
- **Cancel** sends `session/cancel` and keeps streamed partial text.
- **Permissions** are a modal sheet listing the tool title, raw input and the
  agent-provided options. `allow_always`/`reject_always` are remembered per
  session in the Rust registry; no cross-session persistence in v1.
- **Tool cards** show title, kind icon, live status, raw input (collapsed) and
  output. Diffs in `content` render as unified text.
- **Plan** renders as a checklist; commands as a slash menu filtered from the
  composer.
- **Session history** is a JSONL transcript under
  `<workspace>/.solomd/acp-sessions/<sessionId>.jsonl`, plus the agent-side
  session id. `session/load` is used when the agent advertises `loadSession`;
  otherwise the panel restores the transcript read-only and starts a new agent
  session.

## fs / terminal delegation

- `fs/read_text_file` and `fs/write_text_file` are jailed to the session cwd;
  `line`/`limit` are honoured. A file that is dirty in an open editor is
  flushed to disk by the frontend before the read (best effort).
- `terminal/create|output|wait_for_exit|kill|release` are implemented on top of
  `tokio::process`, keyed by a terminal registry. Output is captured with a
  256 KiB ring buffer. The panel renders terminal tool content as a live
  `<pre>`; no xterm.js in v1.

## Phasing (all implemented autonomously, in order)

1. Rust ACP core: detection, session task, streaming, tool cards, permission,
   cancel, done/error events.
2. Vue: agent picker, streaming, tool cards, permission sheet, stop, new
   session.
3. Plan / commands / modes / usage / notices.
4. Session history and restore.
5. fs + terminal delegation.
6. Tests: Rust unit tests for detection and update mapping; store tests for
   session/turn state; a scripted fake ACP agent for an end-to-end test.

## Non-goals

- Bundling any agent or adapter.
- Unstable ACP v2, subagents, MCP-over-ACP.
- xterm.js / full terminal emulation.
- Multi-session tabs (one session per panel in v1).

## Risks

- The Claude adapter is Node ≥22 and downloads on first `npx` use; detection
  must surface this clearly.
- ACP adapters move fast; pin the adapter version.
- `ActiveSession` requires careful command/stream interleaving: prompts are
  only accepted when idle, cancel goes through the connection handle.
