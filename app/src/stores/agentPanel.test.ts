/**
 * agentPanel store — turn state and transcript shaping for the ACP panel.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';

setActivePinia(createPinia());
const { useAgentPanelStore, toolFromAcp, toolContentText } = await import('./agentPanel.ts');

test('abortTurn ends the turn but keeps the live ACP session', () => {
  const s = useAgentPanelStore();
  s.openForFolder('/vault');
  s.setSession({
    sessionId: 'sid',
    agentId: 'opencode',
    cwd: '/vault',
    restored: false,
  });
  s.currentRunId = 'req';
  s.isStreaming = true;

  s.abortTurn();

  assert.equal(s.currentRunId, null);
  assert.equal(s.isStreaming, false);
  assert.equal(s.acpSessionId, 'sid');
});

test('the composer draft lives in the store so a dock switch keeps it', () => {
  const s = useAgentPanelStore();
  s.openForFolder('/vault');
  s.draft = 'half-typed prompt';
  assert.equal(s.draft, 'half-typed prompt');
  s.openForFolder('/other');
  assert.equal(s.draft, '');
});

test('switching agent starts a new session and clears the transcript', () => {
  const s = useAgentPanelStore();
  s.openForFolder('/vault');
  s.setSession({
    sessionId: 'sid',
    agentId: 'opencode',
    cwd: '/vault',
    restored: false,
  });
  s.addMessage({ role: 'user', content: 'hi' });

  s.selectAgent('claude');

  assert.equal(s.acpSessionId, null);
  assert.equal(s.messages.length, 0);
  assert.equal(s.agentId, 'claude');
});

test('tool_call inserts a card plus an assistant bubble; update patches it', () => {
  const s = useAgentPanelStore();
  s.addMessage({ role: 'user', content: 'edit it' });
  s.upsertToolCall({
    toolCallId: 't1',
    title: 'Write notes/a.md',
    name: 'write',
    kind: 'edit',
    status: 'pending',
    rawInput: { path: 'notes/a.md' },
  });
  s.addMessage({ role: 'assistant', content: '' });
  s.updateToolCall({
    toolCallId: 't1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
  });

  const card = s.messages.find((m) => m.tool?.toolCallId === 't1');
  assert.equal(card.tool.status, 'completed');
  assert.equal(card.tool.result, 'ok');
  assert.deepEqual(card.tool.args, { path: 'notes/a.md' });
  assert.equal(card.tool.kind, 'edit');
});

test('toolContentText renders diffs', () => {
  const text = toolContentText([
    { type: 'diff', path: 'a.md', oldText: 'one', newText: 'two' },
  ]);
  assert.match(text, /a\.md/);
  assert.match(text, /one/);
  assert.match(text, /two/);
});

test('toolFromAcp tolerates a scalar rawInput', () => {
  const tool = toolFromAcp({ toolCallId: 't2', title: 'Shell', rawInput: 'ls' });
  assert.deepEqual(tool.args, { value: 'ls' });
});
