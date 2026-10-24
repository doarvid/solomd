import { defineStore } from 'pinia';

/**
 * Inline Agent Panel store.
 *
 * Two backends share one transcript shape:
 * - `api`  — the in-process provider stack (`ai_chat`, read-only vault tools)
 * - `acp`  — a persistent Agent Client Protocol session (Claude Code /
 *            opencode), which streams thoughts, tool cards and plans.
 *
 * The ACP fields hold the live session. Switching the source or the folder
 * clears them; history lives on disk in `<workspace>/.solomd/acp-sessions/`.
 */

export type AgentMessageRole = 'user' | 'assistant' | 'tool' | 'thought' | 'system';

export type AgentSource = 'api' | 'acp';

export interface AgentToolPayload {
  /** Programmatic tool name when the agent provides one. */
  name: string;
  /** Human-readable title from the ACP tool call. */
  title?: string;
  /** ACP tool kind: read / edit / execute / search / … */
  kind?: string;
  /** ACP status: pending / in_progress / completed / failed. */
  status?: string;
  /** Raw input object, rendered as JSON in the expanded card. */
  args: Record<string, unknown>;
  /** Text collected from the tool call's content blocks. */
  result?: string;
  /** Raw result payload from a plain API tool call. */
  error?: string;
  /** UI-only flag — whether the inline card is expanded. Defaults false. */
  expanded?: boolean;
  /** Pairing key — matches tool-call → update. */
  toolCallId: string;
  /** Run id this tool belongs to (API path). */
  runId?: string;
  locations?: Array<{ path: string; line?: number }>;
}

export interface AgentMessage {
  id: string;
  role: AgentMessageRole;
  content: string;
  /** Populated when `role === 'tool'`. */
  tool?: AgentToolPayload;
  createdAt: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
  reason?: string | null;
  detail?: string | null;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface AcpPermission {
  requestId: string;
  sessionId: string;
  toolCall: Record<string, unknown>;
  options: AcpPermissionOption[];
}

export interface AcpPlanEntry {
  content: string;
  priority: string;
  status: string;
}

export interface AcpCommand {
  name: string;
  description: string;
  input?: { hint: string } | null;
}

export interface AcpMode {
  id: string;
  name: string;
  description?: string | null;
}

export interface AcpSessionInfo {
  sessionId: string;
  agentId: string;
  cwd: string;
  restored: boolean;
  modes?: {
    currentModeId?: string;
    availableModes?: AcpMode[];
  } | null;
  configOptions?: unknown;
  agentInfo?: { name?: string; title?: string; version?: string } | null;
  loadSession?: boolean;
}

export interface AcpSessionSummary {
  id: string;
  agentId: string;
  title: string;
  updatedAt: number;
}

interface AgentPanelState {
  messages: AgentMessage[];
  isStreaming: boolean;
  /** request id used for cancellation / event matching (API path). */
  currentRunId: string | null;
  /** Persistence run id minted by the Rust agent_run module. */
  currentPersistRunId: string | null;
  source: AgentSource;
  /** Folder the ACP session runs in; set by the file-tree context menu. */
  acpFolder: string | null;
  /** Detected local agents. */
  agents: AgentInfo[];
  agentsLoaded: boolean;
  agentId: string | null;
  /** Live ACP session returned by the backend. */
  acpSessionId: string | null;
  acpRestored: boolean;
  acpModes: { currentModeId: string; availableModes: AcpMode[] } | null;
  acpCommands: AcpCommand[];
  acpPlan: AcpPlanEntry[] | null;
  acpUsage: Record<string, unknown> | null;
  acpNotice: string | null;
  permission: AcpPermission | null;
  sessions: AcpSessionSummary[];
  /** Composer text; lives here so a dock switch keeps what was typed. */
  draft: string;
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** ACP `rawInput` is JSON and may be a scalar or array; cards want an object. */
export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return value === undefined || value === null ? {} : { value };
}

/** Flatten ACP tool content blocks into displayable text. */
export function toolContentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const item = block as Record<string, unknown>;
    const kind = item.type;
    if (kind === 'content') {
      const inner = item.content as Record<string, unknown> | undefined;
      if (inner?.type === 'text' && typeof inner.text === 'string') {
        parts.push(inner.text);
      } else if (inner) {
        parts.push(JSON.stringify(inner, null, 2));
      }
    } else if (kind === 'diff') {
      const path = typeof item.path === 'string' ? item.path : 'diff';
      parts.push(
        `--- ${path}\n${String(item.oldText ?? '')}\n+++\n${String(item.newText ?? '')}`,
      );
    } else if (kind === 'terminal') {
      const terminalId = item.terminalId ?? item.terminal_id;
      parts.push(`terminal ${String(terminalId ?? '')}`.trim());
    } else {
      parts.push(JSON.stringify(item, null, 2));
    }
  }
  return parts.join('\n\n');
}

export function toolFromAcp(toolCall: Record<string, unknown>): AgentToolPayload {
  return {
    name: String(toolCall.name ?? toolCall.title ?? 'tool'),
    title: toolCall.title ? String(toolCall.title) : undefined,
    kind: toolCall.kind ? String(toolCall.kind) : undefined,
    status: toolCall.status ? String(toolCall.status) : undefined,
    args: asRecord(toolCall.rawInput ?? toolCall.raw_input),
    result: toolContentText(toolCall.content),
    expanded: false,
    toolCallId: String(toolCall.toolCallId ?? toolCall.tool_call_id ?? newId()),
    locations: Array.isArray(toolCall.locations)
      ? (toolCall.locations as Array<Record<string, unknown>>).map((loc) => ({
          path: String(loc.path ?? ''),
          line: typeof loc.line === 'number' ? loc.line : undefined,
        }))
      : undefined,
  };
}

export const useAgentPanelStore = defineStore('agentPanel', {
  state: (): AgentPanelState => ({
    messages: [],
    isStreaming: false,
    currentRunId: null,
    currentPersistRunId: null,
    source: 'api',
    acpFolder: null,
    agents: [],
    agentsLoaded: false,
    agentId: null,
    acpSessionId: null,
    acpRestored: false,
    acpModes: null,
    acpCommands: [],
    acpPlan: null,
    acpUsage: null,
    acpNotice: null,
    permission: null,
    sessions: [],
    draft: '',
  }),
  actions: {
    addMessage(msg: Omit<AgentMessage, 'id' | 'createdAt'>): AgentMessage {
      const full: AgentMessage = {
        ...msg,
        id: newId(),
        createdAt: Date.now(),
      };
      this.messages.push(full);
      return full;
    },
    appendToLastAssistant(chunk: string) {
      const last = this.messages[this.messages.length - 1];
      if (last && last.role === 'assistant') {
        last.content += chunk;
      } else {
        this.addMessage({ role: 'assistant', content: chunk });
      }
    },
    appendThought(chunk: string) {
      const last = this.messages[this.messages.length - 1];
      if (last && last.role === 'thought') {
        last.content += chunk;
      } else {
        this.addMessage({ role: 'thought', content: chunk });
      }
    },
    /** Insert a tool-call placeholder card and a fresh assistant bubble so
     *  post-tool text streams into its own card. */
    insertToolCall(payload: {
      toolCallId: string;
      name: string;
      args: Record<string, unknown>;
      runId?: string;
    }) {
      this.addMessage({
        role: 'tool',
        content: '',
        tool: {
          name: payload.name,
          args: payload.args,
          toolCallId: payload.toolCallId,
          runId: payload.runId,
          expanded: false,
        },
      });
      this.addMessage({ role: 'assistant', content: '' });
    },
    /** ACP `tool_call`: insert a card from the agent-provided payload. */
    upsertToolCall(toolCall: Record<string, unknown>) {
      const tool = toolFromAcp(toolCall);
      const existing = this.messages.find(
        (m) => m.role === 'tool' && m.tool?.toolCallId === tool.toolCallId,
      );
      if (existing?.tool) {
        Object.assign(existing.tool, tool, { expanded: existing.tool.expanded });
        return;
      }
      this.addMessage({ role: 'tool', content: '', tool });
      const last = this.messages[this.messages.length - 1];
      if (!(last.role === 'assistant' && last.content === '')) {
        this.addMessage({ role: 'assistant', content: '' });
      }
    },
    /** ACP `tool_call_update`: patch only the fields the agent sent. */
    updateToolCall(update: Record<string, unknown>) {
      const id = String(update.toolCallId ?? update.tool_call_id ?? '');
      const message = this.messages.find((m) => m.role === 'tool' && m.tool?.toolCallId === id);
      if (!message?.tool) return;
      if (update.status) message.tool.status = String(update.status);
      if (update.title) message.tool.title = String(update.title);
      if (update.kind) message.tool.kind = String(update.kind);
      if (update.name) message.tool.name = String(update.name);
      if (update.rawInput !== undefined) message.tool.args = asRecord(update.rawInput);
      if (update.rawOutput !== undefined) {
        message.tool.result = JSON.stringify(update.rawOutput, null, 2);
      }
      if (update.content !== undefined) {
        const text = toolContentText(update.content);
        if (text) message.tool.result = text;
      }
    },
    /** Match a result event to the matching API tool message. */
    completeToolCall(payload: { toolCallId: string; result?: string; error?: string }) {
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const m = this.messages[i];
        if (m.role === 'tool' && m.tool && m.tool.toolCallId === payload.toolCallId) {
          m.tool.result = payload.result;
          m.tool.error = payload.error;
          m.tool.status = payload.error ? 'failed' : 'completed';
          break;
        }
      }
    },
    toggleToolExpand(toolCallId: string) {
      for (const m of this.messages) {
        if (m.role === 'tool' && m.tool && m.tool.toolCallId === toolCallId) {
          m.tool.expanded = !m.tool.expanded;
          return;
        }
      }
    },
    setAgents(agents: AgentInfo[]) {
      this.agents = agents;
      this.agentsLoaded = true;
      if (!this.agentId) {
        const available = agents.find((a) => a.available);
        if (available) this.agentId = available.id;
      }
    },
    selectAgent(id: string) {
      if (this.agentId === id) return;
      this.agentId = id;
      this.messages = [];
      this.resetAcpSession();
    },
    setSession(info: AcpSessionInfo) {
      this.acpSessionId = info.sessionId;
      this.agentId = info.agentId;
      this.acpFolder = info.cwd;
      this.acpRestored = info.restored;
      this.acpModes = info.modes?.availableModes
        ? {
            currentModeId: info.modes.currentModeId ?? info.modes.availableModes[0]?.id ?? '',
            availableModes: info.modes.availableModes,
          }
        : null;
      this.permission = null;
      this.isStreaming = false;
    },
    setMode(modeId: string) {
      if (this.acpModes) this.acpModes.currentModeId = modeId;
    },
    setPermission(permission: AcpPermission | null) {
      this.permission = permission;
    },
    setPlan(plan: AcpPlanEntry[] | null) {
      this.acpPlan = plan;
    },
    setUsage(usage: Record<string, unknown> | null) {
      this.acpUsage = usage;
    },
    setCommands(commands: AcpCommand[]) {
      this.acpCommands = commands;
    },
    /** Drop the empty assistant placeholder a finished/cancelled turn leaves. */
    dropEmptyAssistant() {
      const last = this.messages[this.messages.length - 1];
      if (last && last.role === 'assistant' && last.content === '') {
        this.messages.pop();
      }
    },
    resetAcpSession() {
      this.acpSessionId = null;
      this.acpRestored = false;
      this.acpModes = null;
      this.acpCommands = [];
      this.acpPlan = null;
      this.acpUsage = null;
      this.acpNotice = null;
      this.permission = null;
    },
    clearSession() {
      this.messages = [];
      this.currentRunId = null;
      this.currentPersistRunId = null;
      this.isStreaming = false;
      this.resetAcpSession();
      this.draft = '';
    },
    clear() {
      // The live ACP session outlives a cleared transcript; send a fresh
      // prompt resumes the same conversation server-side.
      this.clearSession();
    },
    /** File tree → Agent: scope the ACP session to a folder and start fresh. */
    openForFolder(path: string) {
      this.source = 'acp';
      this.acpFolder = path;
      this.clearSession();
    },
    setSource(source: AgentSource) {
      if (this.source === source) return;
      this.source = source;
      this.clearSession();
    },
    abortTurn() {
      this.currentRunId = null;
      this.isStreaming = false;
    },
  },
});
