/**
 * 收藏源前端状态：加载缓存、按需刷新、批量导入。
 *
 * “哪些还没导入”不落盘 —— 由 workspace index 实时算出（见
 * lib/collections-filter.ts）。这样用户在任何地方手动建过同 URL 笔记，
 * 都不会被再次导入。
 */
import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';

import { useSettingsStore } from './settings';
import { useWorkspaceStore } from './workspace';
import { useWorkspaceIndexStore } from './workspaceIndex';
import { useToastsStore } from './toasts';
import { hasGitBackend, isMobile } from '../lib/platform';
import { noteTitleKey, type DedupeIndex } from '../lib/bookmark-dedupe';
import {
  visibleItems,
  type CollectionsState,
  type PendingItem,
} from '../lib/collections-filter';
import { useI18n } from '../i18n';

interface ImportOutcome {
  path: string | null;
  warning: string | null;
  error: string | null;
}

/** 归一化 URL 缓存：id → capture_normalize_url 的结果。进程内即可。 */
const normalizedUrls = new Map<string, string>();

export const useCollectionsStore = defineStore('collections', {
  state: () => ({
    state: null as CollectionsState | null,
    loading: false,
    refreshing: false,
    /** Backend told us it stopped at the 1000-star page cap. */
    truncated: false,
    importingIds: [] as string[],
    importingAll: false,
    importDone: 0,
    importTotal: 0,
    lastError: null as string | null,
  }),

  getters: {
    available(): boolean {
      return !isMobile() && hasGitBackend() && !!useWorkspaceStore().currentFolder;
    },

    dedupe(): DedupeIndex {
      const index = useWorkspaceIndexStore();
      const capturedUrls = new Set<string>();
      const noteLinkedUrls = new Set<string>();
      const capturedTitles = new Set<string>();
      for (const note of index.entries) {
        for (const link of note.links ?? []) {
          if (link.normalized_url) noteLinkedUrls.add(link.normalized_url);
        }
        if (!note.captured_url) continue;
        capturedUrls.add(note.captured_url);
        capturedTitles.add(noteTitleKey(note.stem));
      }
      return { capturedUrls, noteLinkedUrls, capturedTitles };
    },

    /**
     * Derived, never stored: an item disappears the moment its URL is captured
     * or linked anywhere in the workspace, and stays hidden until the index is
     * ready (otherwise startup briefly shows everything as pending).
     */
    pendingItems(): PendingItem[] {
      const index = useWorkspaceIndexStore();
      if (!this.available || !index.ready) return [];
      if (!useSettingsStore().collectionGithubEnabled) return [];
      return this.state ? visibleItems(this.state, this.dedupe, normalizedUrls) : [];
    },
  },

  actions: {
    async load() {
      if (!this.available) {
        this.state = null;
        return;
      }
      this.loading = true;
      try {
        const state = await invoke<CollectionsState>('collections_load', {
          workspace: useWorkspaceStore().currentFolder,
        });
        this.state = state;
        for (const item of state.items) {
          if (normalizedUrls.has(item.id)) continue;
          try {
            normalizedUrls.set(
              item.id,
              await invoke<string>('capture_normalize_url', { url: item.url }),
            );
          } catch {
            // Leave it uncached: the raw-URL fallback is fine for this pass,
            // and a later load can succeed.
          }
        }
      } catch (e) {
        this.lastError = String(e);
      } finally {
        this.loading = false;
      }
    },

    async start() {
      if (!this.available) return;
      await this.load();
      void this.maybeRefresh();
    },

    async maybeRefresh(force = false) {
      if (!this.available) return;
      const settings = useSettingsStore();
      if (!settings.collectionGithubEnabled || this.refreshing) return;
      const last = this.state?.lastRefresh?.github ?? 0;
      const interval = Math.max(1, settings.collectionRefreshMinutes) * 60_000;
      if (!force && Date.now() - last < interval) return;
      await this.refresh();
    },

    /** No token = stay silent, per spec §5. A command failure is not a
     *  "no token" answer, so it falls through and surfaces as a refresh error. */
    async hasToken(): Promise<boolean> {
      try {
        return await invoke<boolean>('github_has_token');
      } catch {
        return true;
      }
    },

    async refresh() {
      if (!this.available || this.refreshing) return;
      if (!useSettingsStore().collectionGithubEnabled) return;
      if (!(await this.hasToken())) return;
      this.refreshing = true;
      this.lastError = null;
      try {
        const outcome = await invoke<{ truncated?: boolean }>('collections_refresh_github', {
          workspace: useWorkspaceStore().currentFolder,
        });
        this.truncated = outcome?.truncated === true;
        await this.load();
      } catch (e) {
        this.lastError = String(e);
      } finally {
        this.refreshing = false;
      }
    },

    async importOne(item: PendingItem, reload = true): Promise<{ ok: boolean }> {
      if (this.importingIds.includes(item.id)) return { ok: false };
      const { t } = useI18n();
      const toasts = useToastsStore();
      this.importingIds = [...this.importingIds, item.id];
      try {
        const out = await invoke<ImportOutcome>('collections_import', {
          workspace: useWorkspaceStore().currentFolder,
          id: item.id,
        });
        if (out.error) {
          // Toasts carry import errors; `lastError` is the refresh line.
          toasts.error(t('inbox.pendingImport.importFailed', { title: item.title, error: out.error }));
          return { ok: false };
        }
        this.lastError = null;
        if (out.warning) {
          toasts.info(t('inbox.pendingImport.importWarning', { title: item.title, error: out.warning }));
        } else {
          toasts.success(t('inbox.pendingImport.importedOne', { title: item.title }));
        }
        // 单条导入后立刻刷新：后端已把 id 写进 imported，条目会从列表消失。
        if (reload) await this.load();
        return { ok: true };
      } catch (e) {
        const error = String(e);
        toasts.error(t('inbox.pendingImport.importFailed', { title: item.title, error }));
        return { ok: false };
      } finally {
        this.importingIds = this.importingIds.filter((id) => id !== item.id);
      }
    },

    async importAll() {
      if (this.importingAll) return;
      const items = [...this.pendingItems];
      if (items.length === 0) return;
      this.importingAll = true;
      this.importDone = 0;
      this.importTotal = items.length;
      let ok = 0;
      let failed = 0;
      try {
        for (const item of items) {
          const result = await this.importOne(item, false);
          if (result.ok) ok += 1;
          else failed += 1;
          this.importDone += 1;
        }
      } finally {
        this.importingAll = false;
      }
      await this.load();
      const { t } = useI18n();
      const toasts = useToastsStore();
      if (failed === 0) {
        toasts.success(t('inbox.pendingImport.importedAll', { n: String(ok) }));
      } else {
        toasts.error(
          t('inbox.pendingImport.importFinished', { ok: String(ok), failed: String(failed) }),
        );
      }
    },

    async dismiss(id: string) {
      if (!this.available) return;
      try {
        this.state = await invoke<CollectionsState>('collections_dismiss', {
          workspace: useWorkspaceStore().currentFolder,
          id,
        });
      } catch (e) {
        this.lastError = String(e);
      }
    },

    async clearHistory(): Promise<boolean> {
      if (!this.available) return false;
      try {
        this.state = await invoke<CollectionsState>('collections_clear_history', {
          workspace: useWorkspaceStore().currentFolder,
        });
      } catch (e) {
        this.lastError = String(e);
        return false;
      }
      return true;
    },
  },
});
