/**
 * Bookmark → note dedupe must survive workspace reorganizations.
 * Regression: renaming/moving note folders made already-captured bookmarks
 * look new, because the fallback key was "current note folder + title".
 * Real examples from the 2026-10-22 restructure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldCapture, noteTitleKey, type DedupeIndex } from './bookmark-dedupe';

function index(overrides: Partial<DedupeIndex> = {}): DedupeIndex {
  return {
    capturedUrls: new Set(),
    noteLinkedUrls: new Set(),
    capturedTitles: new Set(),
    ...overrides,
  };
}

test('exact captured URL is skipped', () => {
  const i = index({ capturedUrls: new Set(['https://example.com/page']) });
  assert.equal(
    shouldCapture({ title: 'Something', normalized_url: 'https://example.com/page' }, i),
    false,
  );
});

test('URL linked from a note body is skipped', () => {
  const i = index({ noteLinkedUrls: new Set(['https://example.com/linked']) });
  assert.equal(
    shouldCapture({ title: 'Something', normalized_url: 'https://example.com/linked' }, i),
    false,
  );
});

test('a moved note is still recognized by title (folder no longer matters)', () => {
  // Note now lives in 01.股票交易/04.量化开发/02.数据接口/baostock.com.md,
  // bookmark is still in the old 10.软件开发/量化 folder and the URL drifted
  // from https://www.baostock.com/... to http://baostock.com/....
  const i = index({ capturedTitles: new Set([noteTitleKey('baostock.com')]) });
  assert.equal(
    shouldCapture(
      { title: 'baostock.com · baostock.com', normalized_url: 'http://baostock.com/baostock/index.php/%E9%A6%96%E9%A1%B5' },
      i,
    ),
    false,
  );
});

test('mirror titles of the form "note · host" match the note stem', () => {
  const i = index({ capturedTitles: new Set([noteTitleKey('opencode')]) });
  assert.equal(
    shouldCapture({ title: 'opencode · opencode.ai', normalized_url: 'https://opencode.ai/workspace/x/go' }, i),
    false,
  );
});

test('titles with an embedded separator keep the full form too', () => {
  const i = index({ capturedTitles: new Set([noteTitleKey('Linux量化交易方案 · qmt-api - qmt-api')]) });
  assert.equal(
    shouldCapture({ title: 'Linux量化交易方案 · qmt-api - qmt-api · pypi.org', normalized_url: 'https://pypi.org/project/qmt-api' }, i),
    false,
  );
});

test('a genuinely new bookmark is still captured', () => {
  const i = index({ capturedTitles: new Set([noteTitleKey('baostock.com')]) });
  assert.equal(
    shouldCapture({ title: 'A brand new page', normalized_url: 'https://example.com/new' }, i),
    true,
  );
});

test('note title keys ignore capture suffixes', () => {
  assert.equal(noteTitleKey('产品简介-2'), noteTitleKey('产品简介'));
});
