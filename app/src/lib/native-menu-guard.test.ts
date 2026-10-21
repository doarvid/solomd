import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSuppressNativeMenu } from './native-menu-guard.ts';

function ev(target: unknown, extra: Partial<{ defaultPrevented: boolean; pointerType: string }> = {}) {
  return { target, defaultPrevented: false, pointerType: 'mouse', ...extra } as unknown as MouseEvent;
}
function el(matches: boolean) {
  return { nodeType: 1, closest: () => (matches ? {} : null) };
}

test('chrome right-click: the browser menu is suppressed', () => {
  assert.equal(shouldSuppressNativeMenu(ev(el(false)), ''), true);
});

test('editable targets, images and selections keep the system menu', () => {
  assert.equal(shouldSuppressNativeMenu(ev(el(true)), ''), false);
  assert.equal(shouldSuppressNativeMenu(ev(el(false)), 'copied text'), false);
});

test('handled events and touch presses are left alone', () => {
  assert.equal(shouldSuppressNativeMenu(ev(el(false), { defaultPrevented: true }), ''), false);
  assert.equal(shouldSuppressNativeMenu(ev(el(false), { pointerType: 'touch' }), ''), false);
});

test('a text-node target is resolved to its element', () => {
  const text = { nodeType: 3, parentElement: el(true) };
  assert.equal(shouldSuppressNativeMenu(ev(text), ''), false);
});
