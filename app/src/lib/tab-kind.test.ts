import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isBrowserTab, isFileTab } from './tab-kind.ts';

test('kind 缺省视为文件 tab（向后兼容持久化数据）', () => {
  assert.equal(isBrowserTab({}), false);
  assert.equal(isFileTab({}), true);
});

test('kind: browser 被识别', () => {
  assert.equal(isBrowserTab({ kind: 'browser' }), true);
  assert.equal(isFileTab({ kind: 'browser' }), false);
});

test('kind: file 显式声明也被识别', () => {
  assert.equal(isBrowserTab({ kind: 'file' }), false);
  assert.equal(isFileTab({ kind: 'file' }), true);
});

test('两个判别互为反面', () => {
  for (const t of [{}, { kind: 'file' as const }, { kind: 'browser' as const }]) {
    assert.equal(isBrowserTab(t), !isFileTab(t));
  }
});
