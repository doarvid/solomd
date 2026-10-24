/**
 * The pending-import list is derived state: it must react to the workspace
 * index (a URL captured or linked elsewhere disappears immediately), stay
 * hidden until the index is ready, and respect the source toggle.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const g = globalThis as Record<string, unknown>;
g.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
if (!g.navigator) g.navigator = { userAgent: 'node', language: 'en-US', platform: 'MacIntel' };
if (!g.location) g.location = { search: '' };

const { createPinia, setActivePinia } = await import('pinia');
const { useCollectionsStore } = await import('./collections');
const { useWorkspaceStore } = await import('./workspace');
const { useWorkspaceIndexStore } = await import('./workspaceIndex');
const { useSettingsStore } = await import('./settings');

const ITEM = {
  id: 'github:a/one',
  source: 'github',
  title: 'a/one',
  url: 'https://github.com/a/one',
  savedAt: '2026-10-01T00:00:00Z',
  description: null,
  language: null,
  stars: 1,
  topics: [],
};

function setup() {
  setActivePinia(createPinia());
  const workspace = useWorkspaceStore();
  workspace.currentFolder = '/vault';
  const index = useWorkspaceIndexStore();
  index.ready = true;
  index.entries = [];
  useSettingsStore().collectionGithubEnabled = true;
  const collections = useCollectionsStore();
  collections.state = {
    version: 1,
    items: [ITEM],
    dismissed: [],
    imported: {},
    lastRefresh: {},
  };
  return { collections, index };
}

beforeEach(() => {});

test('pending list follows the workspace index live', () => {
  const { collections, index } = setup();
  assert.deepEqual(
    collections.pendingItems.map((i) => i.id),
    ['github:a/one'],
  );

  // Another pass captured the same URL: the row must disappear without a
  // reload, or clicking Import would create a duplicate note.
  index.entries = [
    {
      path: '/vault/inbox/a__one.md',
      name: 'a__one.md',
      stem: 'a__one',
      mtime: 0,
      size: 0,
      frontmatter: null,
      wikilinks: [],
      tags: [],
      headings: [],
      summary: '',
      title: 'a/one',
      captured_url: 'https://github.com/a/one',
      links: [],
    },
  ];
  assert.deepEqual(collections.pendingItems, []);
});

test('pending list stays hidden until the index is ready', () => {
  const { collections, index } = setup();
  index.ready = false;
  assert.deepEqual(collections.pendingItems, []);
  index.ready = true;
  assert.equal(collections.pendingItems.length, 1);
});

test('the source toggle hides pending items', () => {
  const { collections } = setup();
  const settings = useSettingsStore();
  settings.collectionGithubEnabled = false;
  assert.deepEqual(collections.pendingItems, []);
  settings.collectionGithubEnabled = true;
  assert.equal(collections.pendingItems.length, 1);
});
