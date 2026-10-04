import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diffBrowserTabs } from './browser-lifecycle.ts';

const b = (id: string) => ({ id, kind: 'browser' as const });
const f = (id: string) => ({ id, kind: 'file' as const });

test('新增浏览器 tab → create', () => {
  assert.deepEqual(diffBrowserTabs([], [b('a')]), { create: ['a'], destroy: [] });
});

test('关闭浏览器 tab → destroy', () => {
  assert.deepEqual(diffBrowserTabs([b('a')], []), { create: [], destroy: ['a'] });
});

test('文件 tab 的增减不触发任何 webview 动作', () => {
  assert.deepEqual(diffBrowserTabs([f('x')], [f('y')]), { create: [], destroy: [] });
});

test('kind 缺省的文件 tab 不会被误判成浏览器 tab', () => {
  assert.deepEqual(diffBrowserTabs([], [{ id: 'z' }]), { create: [], destroy: [] });
  assert.deepEqual(diffBrowserTabs([{ id: 'z' }], []), { create: [], destroy: [] });
});

test('混合场景：只关心浏览器 tab 的增删', () => {
  assert.deepEqual(diffBrowserTabs([b('a'), f('x')], [b('b'), f('y')]), {
    create: ['b'],
    destroy: ['a'],
  });
});

test('内容不变时无动作', () => {
  assert.deepEqual(diffBrowserTabs([b('a'), f('x')], [b('a'), f('x')]), {
    create: [],
    destroy: [],
  });
});

test('会话恢复：空 prev + 恢复出的浏览器 tab → 全量 create', () => {
  // 这条是整个 diff 方案存在的理由 —— 恢复路径不经过任何 action，
  // 只有 diff 能覆盖它。
  assert.deepEqual(diffBrowserTabs([], [b('r1'), b('r2'), f('x')]), {
    create: ['r1', 'r2'],
    destroy: [],
  });
});
