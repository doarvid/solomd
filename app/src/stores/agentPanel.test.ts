/**
 * agentPanel store — turn-abort semantics for the Claude CLI path.
 *
 * Claude creates the session transcript as soon as a run starts, so a failed
 * or cancelled FIRST turn leaves the id unusable: retrying with the same
 * `--session-id` fails with "Session ID is already in use". `abortTurn` must
 * therefore drop the id until a turn has actually completed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';

setActivePinia(createPinia());
const { useAgentPanelStore } = await import('./agentPanel.ts');

test('abortTurn drops the session id after a failed first turn', () => {
  const s = useAgentPanelStore();
  s.openForFolder('/vault');
  s.cliSessionId = 'sid';
  s.cliStarted = false;
  s.currentRunId = 'req';
  s.isStreaming = true;
  s.cliStatus = 'Read a.md';

  s.abortTurn();

  assert.equal(s.cliSessionId, null);
  assert.equal(s.currentRunId, null);
  assert.equal(s.isStreaming, false);
  assert.equal(s.cliStatus, null);
});

test('the composer draft lives in the store so a dock switch keeps it', () => {
  const s = useAgentPanelStore();
  s.openForFolder('/vault');
  s.draft = 'half-typed prompt';
  // A dock switch remounts AgentPanel but never touches the store.
  assert.equal(s.draft, 'half-typed prompt');
  s.openForFolder('/other');
  assert.equal(s.draft, '');
});

test('abortTurn keeps the session id after a successful turn', () => {
  const s = useAgentPanelStore();
  s.openForFolder('/vault');
  s.cliSessionId = 'sid';
  s.cliStarted = true;
  s.isStreaming = true;

  s.abortTurn();

  assert.equal(s.cliSessionId, 'sid');
  assert.equal(s.isStreaming, false);
});
