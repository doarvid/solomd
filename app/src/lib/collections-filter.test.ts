import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleItems, type CollectionsState, type PendingItem } from './collections-filter.ts';
import type { DedupeIndex } from './bookmark-dedupe.ts';

function item(id: string, savedAt: string | null): PendingItem {
  return {
    id,
    source: 'github',
    title: id.replace('github:', ''),
    url: `https://github.com/${id.replace('github:', '')}`,
    savedAt,
    description: null,
    language: null,
    stars: null,
    topics: [],
  };
}

function state(items: PendingItem[], dismissed: string[] = [], imported: string[] = []): CollectionsState {
  return {
    version: 1,
    items,
    dismissed,
    imported: Object.fromEntries(imported.map((id) => [id, '/vault/inbox/x.md'])),
    lastRefresh: {},
  };
}

function emptyDedupe(): DedupeIndex {
  return { capturedUrls: new Set(), noteLinkedUrls: new Set(), capturedTitles: new Set() };
}

function normalized(pairs: [string, string][]): Map<string, string> {
  return new Map(pairs);
}

test('dismissed and imported items are hidden', () => {
  const s = state(
    [item('github:a/one', '2026-10-01T00:00:00Z'), item('github:a/two', '2026-10-02T00:00:00Z')],
    ['github:a/one'],
    ['github:a/two'],
  );
  const out = visibleItems(
    s,
    emptyDedupe(),
    normalized([
      ['github:a/one', 'https://github.com/a/one'],
      ['github:a/two', 'https://github.com/a/two'],
    ]),
  );
  assert.deepEqual(out, []);
});

test('captured URL and note-linked URL are hidden after normalization', () => {
  const s = state([
    item('github:a/captured', '2026-10-01T00:00:00Z'),
    item('github:a/linked', '2026-10-02T00:00:00Z'),
    item('github:a/new', '2026-10-03T00:00:00Z'),
  ]);
  const dedupe: DedupeIndex = {
    capturedUrls: new Set(['https://github.com/a/captured']),
    noteLinkedUrls: new Set(['https://github.com/a/linked?utm_source=x']),
    capturedTitles: new Set(),
  };
  const out = visibleItems(
    s,
    dedupe,
    normalized([
      ['github:a/captured', 'https://github.com/a/captured'],
      ['github:a/linked', 'https://github.com/a/linked?utm_source=x'],
      ['github:a/new', 'https://github.com/a/new'],
    ]),
  );
  assert.deepEqual(
    out.map((i) => i.id),
    ['github:a/new'],
  );
});

test('sorts newest savedAt first and keeps unknown dates last', () => {
  const s = state([
    item('github:a/old', '2026-09-01T00:00:00Z'),
    item('github:a/unknown', null),
    item('github:a/new', '2026-10-01T00:00:00Z'),
  ]);
  const out = visibleItems(
    s,
    emptyDedupe(),
    normalized([
      ['github:a/old', 'https://github.com/a/old'],
      ['github:a/unknown', 'https://github.com/a/unknown'],
      ['github:a/new', 'https://github.com/a/new'],
    ]),
  );
  assert.deepEqual(
    out.map((i) => i.id),
    ['github:a/new', 'github:a/old', 'github:a/unknown'],
  );
});
