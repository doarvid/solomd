import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveWindowsEditorEngine, shouldUsePlainWindowsEditor } from './platform.ts';

test('Windows standard mode uses the IME-safe textarea when the WebView2 version is unknown', () => {
  assert.equal(shouldUsePlainWindowsEditor(true, false, 'auto', null), true);
});

test('Windows Vim mode uses CodeMirror', () => {
  assert.equal(shouldUsePlainWindowsEditor(true, true), false);
});

test('non-Windows platforms keep CodeMirror', () => {
  assert.equal(shouldUsePlainWindowsEditor(false, false), false);
});

test('Windows with the CodeMirror engine uses CodeMirror without Vim (#328)', () => {
  assert.equal(shouldUsePlainWindowsEditor(true, false, 'codemirror'), false);
});

test('Windows with the native engine keeps the textarea', () => {
  assert.equal(shouldUsePlainWindowsEditor(true, false, 'native'), true);
});

test('Vim still forces CodeMirror whatever the engine setting', () => {
  assert.equal(shouldUsePlainWindowsEditor(true, true, 'native'), false);
});

test('the engine setting is ignored off Windows', () => {
  assert.equal(shouldUsePlainWindowsEditor(false, false, 'native'), false);
});

test('auto picks CodeMirror on WebView2 154 and later', () => {
  assert.equal(resolveWindowsEditorEngine('auto', '154.0.4258.48'), 'codemirror');
  assert.equal(resolveWindowsEditorEngine('auto', '160.0.1.2'), 'codemirror');
  assert.equal(shouldUsePlainWindowsEditor(true, false, 'auto', '154.0.4258.48'), false);
});

test('auto keeps the textarea on older or unreadable WebView2', () => {
  assert.equal(resolveWindowsEditorEngine('auto', '153.0.3000.1'), 'native');
  assert.equal(resolveWindowsEditorEngine('auto', ''), 'native');
  assert.equal(resolveWindowsEditorEngine('auto', null), 'native');
  assert.equal(resolveWindowsEditorEngine('auto', 'garbage'), 'native');
});

test('an explicit engine wins over the WebView2 version', () => {
  assert.equal(resolveWindowsEditorEngine('native', '160.0.0.0'), 'native');
  assert.equal(resolveWindowsEditorEngine('codemirror', '120.0.0.0'), 'codemirror');
});
