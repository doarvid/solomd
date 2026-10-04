import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  shouldSaveTab,
  shouldPromptOnClose,
  shouldCarryAcrossWorkspace,
} from './browser-tab-guards.ts';

const browser = { kind: 'browser' as const, content: '', savedContent: '' };
const fileDirty = { kind: 'file' as const, content: 'edited', savedContent: 'original' };
const fileClean = { kind: 'file' as const, content: 'same', savedContent: 'same' };
// 老版本持久化下来的 tab 没有 kind 字段。
const legacy = { content: 'edited', savedContent: 'original' };
const legacyClean = { content: 'same', savedContent: 'same' };

test('浏览器 tab 不参与保存（否则 Ctrl+S 弹另存为）', () => {
  assert.equal(shouldSaveTab(browser), false);
  assert.equal(shouldSaveTab(fileDirty), true);
  assert.equal(shouldSaveTab(legacy), true);
});

test('浏览器 tab 关闭时不弹脏确认', () => {
  assert.equal(shouldPromptOnClose(browser), false);
  assert.equal(shouldPromptOnClose(fileDirty), true);
  assert.equal(shouldPromptOnClose(fileClean), false);
  assert.equal(shouldPromptOnClose(legacy), true);
  assert.equal(shouldPromptOnClose(legacyClean), false);
});

test('浏览器 tab 跨工作区保留（否则被当成干净 tab 丢掉）', () => {
  assert.equal(shouldCarryAcrossWorkspace(browser), true);
  assert.equal(shouldCarryAcrossWorkspace(fileDirty), true);
  // 干净的文件 tab 本来就该被丢掉 —— 这是既有行为，不能改。
  assert.equal(shouldCarryAcrossWorkspace(fileClean), false);
  assert.equal(shouldCarryAcrossWorkspace(legacy), true);
  assert.equal(shouldCarryAcrossWorkspace(legacyClean), false);
});

test('缺省 kind 的老 tab 行为与文件 tab 完全一致', () => {
  for (const t of [fileDirty, fileClean, legacy, legacyClean]) {
    const { kind: _k, ...bare } = t as { kind?: string; content: string; savedContent: string };
    assert.equal(shouldSaveTab(t), shouldSaveTab(bare));
    assert.equal(shouldPromptOnClose(t), shouldPromptOnClose(bare));
    assert.equal(shouldCarryAcrossWorkspace(t), shouldCarryAcrossWorkspace(bare));
  }
});
