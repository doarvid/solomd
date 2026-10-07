import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setBrowserPageZoom, toLogicalBounds } from './browser-rect.ts';

/** 每个用例都显式设一次，免得测试之间靠执行顺序传递状态。 */
function withZoom<T>(z: number, fn: () => T): T {
  setBrowserPageZoom(z);
  try {
    return fn();
  } finally {
    setBrowserPageZoom(1);
  }
}

test('缩放为 1 时矩形原样转逻辑像素（不减标题栏、不乘 DPR）', () => {
  withZoom(1, () => {
    assert.deepEqual(toLogicalBounds({ left: 300, top: 120, width: 800, height: 600 }), {
      x: 300,
      y: 120,
      w: 800,
      h: 600,
    });
  });
});

test('页面缩小到 0.8 时，位置和尺寸一起乘以 0.8', () => {
  // 实测现场：globalZoom 0.8、窗口逻辑宽 1792 时 innerWidth 是 2240，
  // 即 CSS px × 0.8 才是逻辑 px。漏掉这一步，webview 会离左上角越远偏得
  // 越多，右下角盖住侧栏和 devtools。
  withZoom(0.8, () => {
    assert.deepEqual(toLogicalBounds({ left: 306, top: 119, width: 1498, height: 844 }), {
      x: 244.8,
      y: 95.2,
      w: 1198.4,
      h: 675.2,
    });
  });
});

test('页面放大到 1.25 时同比放大', () => {
  withZoom(1.25, () => {
    assert.deepEqual(toLogicalBounds({ left: 240, top: 80, width: 800, height: 600 }), {
      x: 300,
      y: 100,
      w: 1000,
      h: 750,
    });
  });
});

test('devicePixelRatio 不参与换算', () => {
  // 曾经把这个参数一路传进来。Tauri 的 LogicalPosition 收的就是逻辑像素，
  // 乘一遍 DPR 会在 Retina 上把 webview 放大一倍 —— 函数现在根本不看它。
  withZoom(1, () => {
    assert.deepEqual(toLogicalBounds({ left: 300, top: 120, width: 800, height: 600 }), {
      x: 300,
      y: 120,
      w: 800,
      h: 600,
    });
  });
});

test('零尺寸 → null（调用方应该 hide，而不是设一个 0×0）', () => {
  withZoom(1, () => {
    assert.equal(toLogicalBounds({ left: 0, top: 0, width: 0, height: 0 }), null);
    assert.equal(toLogicalBounds({ left: 10, top: 10, width: 0, height: 100 }), null);
    assert.equal(toLogicalBounds({ left: 10, top: 10, width: 100, height: 0 }), null);
  });
});

test('负数尺寸也当不可见', () => {
  withZoom(1, () => {
    assert.equal(toLogicalBounds({ left: 0, top: 0, width: -5, height: 10 }), null);
    assert.equal(toLogicalBounds({ left: 0, top: 0, width: 10, height: -5 }), null);
  });
});

test('浮点坐标原样保留（亚像素布局很常见）', () => {
  withZoom(1, () => {
    assert.deepEqual(toLogicalBounds({ left: 300.5, top: 120.25, width: 799.5, height: 600.75 }), {
      x: 300.5,
      y: 120.25,
      w: 799.5,
      h: 600.75,
    });
  });
});

test('缩放值非法时退回 1，不把 webview 缩成 0 尺寸', () => {
  withZoom(0, () => {
    assert.deepEqual(toLogicalBounds({ left: 10, top: 10, width: 100, height: 100 }), {
      x: 10,
      y: 10,
      w: 100,
      h: 100,
    });
  });
});
