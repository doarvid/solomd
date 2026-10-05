// The overlay counter decides whether a browser webview is allowed on screen,
// and the webview shows only when the count is EXACTLY zero. So a counter that
// drifts — negative or stuck high — makes the page silently never appear, or
// never go away. Both failures are hard to attribute from the UI.
//
// Regression: `watch(..., { immediate: true })` passes `undefined` as the
// previous value, so a guard of `if (open === wasOpen) return` let a CLOSED
// overlay take the -1 branch. A handful of registrations drove the count
// negative and the webview never showed at all.
//
//   node --test src/lib/overlay-presence.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effectScope, ref } from 'vue';

import { overlayDepth, useOverlayPresence, useOverlayPresenceOf } from './overlay-presence.ts';

/** Run `fn` in a disposable effect scope (mirrors a component's setup). */
function inScope(fn: () => void): () => void {
  const scope = effectScope();
  scope.run(fn);
  return () => scope.stop();
}

test('registering a closed overlay does not change the count', () => {
  const before = overlayDepth.value;
  const dispose = inScope(() => useOverlayPresence(ref(false)));
  assert.equal(overlayDepth.value, before, '关闭状态的登记不该计数');
  dispose();
  assert.equal(overlayDepth.value, before);
});

test('registering an already-open overlay counts once', () => {
  const before = overlayDepth.value;
  const dispose = inScope(() => useOverlayPresence(ref(true)));
  assert.equal(overlayDepth.value, before + 1);
  dispose();
  assert.equal(overlayDepth.value, before, '销毁时必须把那一份还回去');
});

test('open and close are symmetric', () => {
  const open = ref(false);
  const before = overlayDepth.value;
  const dispose = inScope(() => useOverlayPresence(open));

  open.value = true;
  assert.equal(overlayDepth.value, before + 1);
  open.value = true; // 重复置真不该再加
  assert.equal(overlayDepth.value, before + 1);
  open.value = false;
  assert.equal(overlayDepth.value, before);
  open.value = false;
  assert.equal(overlayDepth.value, before);
  dispose();
  assert.equal(overlayDepth.value, before);
});

test('many closed registrations leave the count at zero', () => {
  // 这正是当初出错的场景：一堆关闭状态的浮层各减一次，计数变负，
  // 而 webview 只在计数**恰好为 0** 时显示 —— 于是整页都不出现。
  const before = overlayDepth.value;
  const disposers = Array.from({ length: 8 }, () =>
    inScope(() => useOverlayPresence(ref(false))),
  );
  assert.equal(overlayDepth.value, before, '关闭状态的登记把计数拉走了');
  assert.ok(overlayDepth.value >= 0, '计数不该为负');
  for (const d of disposers) d();
  assert.equal(overlayDepth.value, before);
});

test('a component unmounting while open does not leak', () => {
  const open = ref(false);
  const before = overlayDepth.value;
  const dispose = inScope(() => useOverlayPresence(open));
  open.value = true;
  dispose(); // 开着就卸载
  assert.equal(overlayDepth.value, before, '卸载泄漏了一份计数，webview 将永远不显示');
});

test('useOverlayPresenceOf handles the non-null-means-open shape', () => {
  const ctx = ref<{ x: number } | null>(null);
  const before = overlayDepth.value;
  const dispose = inScope(() => useOverlayPresenceOf(ctx));

  assert.equal(overlayDepth.value, before, 'null 不该计数');
  ctx.value = { x: 1 };
  assert.equal(overlayDepth.value, before + 1);
  ctx.value = null;
  assert.equal(overlayDepth.value, before);
  dispose();
});
