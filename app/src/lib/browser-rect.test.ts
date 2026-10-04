import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toLogicalBounds } from './browser-rect.ts';

test('视口矩形直接转逻辑像素（不减标题栏、不乘 DPR）', () => {
  assert.deepEqual(toLogicalBounds({ left: 300, top: 120, width: 800, height: 600 }, 1), {
    x: 300,
    y: 120,
    w: 800,
    h: 600,
  });
});

test('devicePixelRatio > 1 时仍然按 CSS 像素传', () => {
  // Tauri 的 LogicalPosition 收的就是 CSS 像素；乘一遍 DPR 会在 Retina 上
  // 把 webview 放大一倍。
  assert.deepEqual(toLogicalBounds({ left: 300, top: 120, width: 800, height: 600 }, 2), {
    x: 300,
    y: 120,
    w: 800,
    h: 600,
  });
});

test('零尺寸 → null（调用方应该 hide，而不是设一个 0×0）', () => {
  assert.equal(toLogicalBounds({ left: 0, top: 0, width: 0, height: 0 }, 1), null);
  assert.equal(toLogicalBounds({ left: 10, top: 10, width: 0, height: 100 }, 1), null);
  assert.equal(toLogicalBounds({ left: 10, top: 10, width: 100, height: 0 }, 1), null);
});

test('负数尺寸也当不可见', () => {
  assert.equal(toLogicalBounds({ left: 0, top: 0, width: -5, height: 10 }, 1), null);
  assert.equal(toLogicalBounds({ left: 0, top: 0, width: 10, height: -5 }, 1), null);
});

test('浮点坐标原样保留（亚像素布局很常见）', () => {
  assert.deepEqual(toLogicalBounds({ left: 300.5, top: 120.25, width: 799.5, height: 600.75 }, 2), {
    x: 300.5,
    y: 120.25,
    w: 799.5,
    h: 600.75,
  });
});
