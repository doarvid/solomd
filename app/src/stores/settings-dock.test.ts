/**
 * Agent panel docking — defaults, persistence and load-time normalization.
 * Runs the real store with a fake window / localStorage, same harness as
 * settings-theme.test.ts.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const saved = new Map<string, string>();
const g = globalThis as Record<string, unknown>;
g.localStorage = {
  getItem: (k: string) => saved.get(k) ?? null,
  setItem: (k: string, v: string) => void saved.set(k, v),
  removeItem: (k: string) => void saved.delete(k),
};
g.window = {
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  localStorage: g.localStorage,
};
if (!g.navigator) g.navigator = { userAgent: 'node', language: 'en-US', platform: 'MacIntel' };

const { createPinia, setActivePinia } = await import('pinia');
const { useSettingsStore } = await import('./settings');

const LS_KEY = 'solomd.settings.v1';

beforeEach(() => {
  saved.clear();
});

function fresh() {
  setActivePinia(createPinia());
  return useSettingsStore();
}

test('a new install docks the agent at the bottom', () => {
  const s = fresh();
  assert.equal(s.agentDock, 'bottom');
  assert.equal(s.agentDockHeight, 320);
});

test('setAgentDock persists the choice', () => {
  const s = fresh();
  s.setAgentDock('right');
  assert.equal(s.agentDock, 'right');
  const blob = JSON.parse(saved.get(LS_KEY)!);
  assert.equal(blob.agentDock, 'right');
});

test('setAgentDockHeight clamps and rounds', () => {
  const s = fresh();
  s.setAgentDockHeight(50);
  assert.equal(s.agentDockHeight, 160);
  s.setAgentDockHeight(99999);
  assert.equal(s.agentDockHeight, 2000);
  s.setAgentDockHeight(420.6);
  assert.equal(s.agentDockHeight, 421);
});

test('an invalid stored dock and height are normalized on load', () => {
  saved.set(
    LS_KEY,
    JSON.stringify({ agentDock: 'left', agentDockHeight: 99999 }),
  );
  assert.equal(fresh().agentDock, 'bottom');
  assert.equal(fresh().agentDockHeight, 2000);
});

test('a non-numeric stored height falls back to 320', () => {
  saved.set(LS_KEY, JSON.stringify({ agentDockHeight: 'oops' }));
  assert.equal(fresh().agentDockHeight, 320);
});
