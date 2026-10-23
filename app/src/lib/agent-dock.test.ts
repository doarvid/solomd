import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  clampStoredDockHeight,
  dockHeightCap,
  resizeOriginHeight,
  nextDockHeight,
  sidebarDropSide,
} = await import('./agent-dock.ts');

test('stored heights are finite, rounded and clamped', () => {
  assert.equal(clampStoredDockHeight(50), 160);
  assert.equal(clampStoredDockHeight(99999), 2000);
  assert.equal(clampStoredDockHeight(420.6), 421);
  assert.equal(clampStoredDockHeight('oops'), 320);
  assert.equal(clampStoredDockHeight(null), 320);
});

test('the viewport cap is 70% and never below the minimum', () => {
  assert.equal(dockHeightCap(1000), 700);
  assert.equal(dockHeightCap(100), 160);
});

test('a resize starts from the rendered height, not the stored one', () => {
  // Stored on a tall monitor, window now short: the handle must still shrink.
  assert.equal(resizeOriginHeight(900, 500), 350);
  assert.equal(resizeOriginHeight(300, 1000), 300);
});

test('dragging up grows, dragging down shrinks, both clamped', () => {
  assert.equal(nextDockHeight(350, 100, 500), 250);
  assert.equal(nextDockHeight(350, -100, 500), 350);
  assert.equal(nextDockHeight(200, 1000, 500), 160);
  assert.equal(nextDockHeight(160, -1000, 500), 350);
});

test('the sidebar drop zone follows the configured sidebar side', () => {
  assert.equal(sidebarDropSide('left'), 'left');
  assert.equal(sidebarDropSide('right'), 'right');
});
