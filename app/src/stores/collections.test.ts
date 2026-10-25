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

const TOUTIAO = {
  id: 'toutiao:https://www.toutiao.com/article/1',
  source: 'toutiao',
  title: '头条文章标题',
  url: 'https://www.toutiao.com/article/1',
  savedAt: null,
  description: null,
  language: null,
  stars: null,
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

/** Record invocations and answer like the Rust side would. */
function stubBackend(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  g.window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string) => {
        calls.push(cmd);
        if (cmd in overrides) return overrides[cmd];
        if (cmd === 'github_has_token') return true;
        if (cmd === 'collections_load') {
          return { version: 1, items: [ITEM], dismissed: [], imported: {}, lastRefresh: {} };
        }
        if (cmd === 'collections_import') return { path: '/vault/inbox/a.md', warning: null, error: null };
        return null;
      },
    },
    localStorage: g.localStorage,
  };
  return calls;
}

test('refresh is a silent skip when no GitHub token is set', async () => {
  const calls = stubBackend({ github_has_token: false });
  const { collections } = setup();
  await collections.refresh();
  assert.ok(!calls.includes('collections_refresh_github'));
  assert.equal(collections.lastError, null);
});

test('refresh records the truncation flag from the backend', async () => {
  stubBackend({
    collections_refresh_github: { added: 0, total: 1000, truncated: true },
  });
  const { collections } = setup();
  await collections.refresh();
  assert.equal(collections.truncated, true);
});

test('a second importAll does not start while one is running', async () => {
  const calls = stubBackend();
  const { collections } = setup();
  const first = collections.importAll();
  const second = collections.importAll();
  await Promise.all([first, second]);
  assert.equal(calls.filter((c) => c === 'collections_import').length, 1);
  assert.equal(collections.importingAll, false);
});

test('clearHistory reports failure instead of pretending success', async () => {
  stubBackend({ collections_clear_history: Promise.reject(new Error('disk full')) });
  const { collections } = setup();
  assert.equal(await collections.clearHistory(), false);
});

test('each source toggle hides only its own items', () => {
  const { collections } = setup();
  collections.state!.items.push(TOUTIAO);
  const settings = useSettingsStore();

  settings.collectionGithubEnabled = false;
  settings.collectionToutiaoEnabled = true;
  assert.deepEqual(collections.pendingItems.map((i) => i.source), ['toutiao']);

  settings.collectionGithubEnabled = true;
  settings.collectionToutiaoEnabled = false;
  assert.deepEqual(collections.pendingItems.map((i) => i.source), ['github']);
});

test('a login-required probe stops before harvesting', async () => {
  const calls = stubBackend({
    collector_status: { state: 'login_required', url: '', error: 'no-avatar' },
  });
  const { collections } = setup();
  useSettingsStore().collectionToutiaoEnabled = true;

  await collections.refreshToutiao(true);

  assert.ok(calls.includes('collector_status'));
  assert.ok(!calls.includes('collector_harvest'));
  assert.equal(collections.toutiaoLoginRequired, true);
  assert.equal(collections.lastError, null);
});

test('a ready harvest upserts the items and reloads the cache', async () => {
  const calls = stubBackend({
    collector_status: { state: 'ready', url: '', error: null },
    collector_harvest: {
      items: [{ url: TOUTIAO.url, title: TOUTIAO.title }],
      hasMore: false,
      loginRequired: false,
    },
    collections_upsert_items: { added: 1, total: 1, truncated: false },
  });
  const { collections } = setup();
  useSettingsStore().collectionToutiaoEnabled = true;

  await collections.refreshToutiao(true);

  assert.ok(calls.includes('collector_harvest'));
  assert.ok(calls.includes('collections_upsert_items'));
  assert.equal(collections.toutiaoLoginRequired, false);
  assert.equal(calls.filter((c) => c === 'collections_load').length, 1);
});

