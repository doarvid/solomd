/**
 * Browser bookmark ↔ note sync.
 *
 * Two independent directions, sharing one schedule:
 *
 *   read  — Chromium bookmarks → notes. Bookmarks the user drops into the
 *           managed `SoloMD/` folder are captured through the existing
 *           `capture_fetch_page` pipeline and mirrored under the workspace
 *           root. Links we mirrored from notes are marked and skipped.
 *   write — notes → browser. Every external link in the workspace becomes a
 *           bookmark inside the browser's managed `SoloMD/` subtree. The Rust
 *           side reconciles the whole subtree and skips any browser that is
 *           currently running (it would overwrite us from memory).
 *
 * Background runs are silent; the settings panel renders the progress state.
 */
import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';

import { useSettingsStore } from './settings';
import { useWorkspaceStore } from './workspace';
import { useWorkspaceIndexStore } from './workspaceIndex';
import { useToastsStore } from './toasts';
import { useI18n } from '../i18n';
import { isMobile } from '../lib/platform';

export interface BookmarkSourceInfo {
  browser: string;
  profile: string;
  path: string;
  mtime: number;
  size: number;
}

export interface BookmarkCatalog {
  sources: BookmarkSourceInfo[];
  fingerprint: string;
}

export interface BookmarkPlanEntry {
  folder: string[];
  title: string;
  url: string;
  normalized_url: string;
}

export interface BookmarkWriteEntry {
  folder: string[];
  title: string;
  url: string;
}

export interface SkippedProfile {
  browser: string;
  profile: string;
  reason: 'running' | 'unreadable';
}

export interface ApplyReport {
  written_profiles: string[];
  skipped_profiles: SkippedProfile[];
  added: number;
  removed: number;
  unchanged: boolean;
}

type Phase = 'idle' | 'reading' | 'writing';

interface State {
  running: boolean;
  phase: Phase;
  total: number;
  done: number;
  captured: number;
  skipped: number;
  failed: number;
  currentTitle: string;
  lastRunAt: number | null;
  lastError: string | null;
  writeReport: ApplyReport | null;
  /** Cached detection result for the settings panel. */
  catalog: BookmarkCatalog | null;
}

/** Module-level so a hot reload can't leave a second interval running. */
let timer: ReturnType<typeof setInterval> | null = null;
let lastAttemptAt = 0;

export const useBookmarkSyncStore = defineStore('bookmarkSync', {
  state: (): State => ({
    running: false,
    phase: 'idle',
    total: 0,
    done: 0,
    captured: 0,
    skipped: 0,
    failed: 0,
    currentTitle: '',
    lastRunAt: null,
    lastError: null,
    writeReport: null,
    catalog: null,
  }),

  actions: {
    start() {
      if (timer) return;
      timer = setInterval(() => void this.maybeSync(), 60_000);
      void this.maybeSync();
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    /** Re-run soon (used when the workspace changed). */
    kick() {
      lastAttemptAt = 0;
      void this.maybeSync();
    },

    async refreshCatalog(): Promise<BookmarkCatalog | null> {
      try {
        this.catalog = await invoke<BookmarkCatalog>('bookmarks_catalog');
        return this.catalog;
      } catch (e) {
        this.lastError = String(e);
        this.catalog = null;
        return null;
      }
    },

    async syncNow() {
      const ran = await this.maybeSync(true);
      if (!ran) return;
      const { t } = useI18n();
      const toasts = useToastsStore();
      if (this.lastError) {
        toasts.error(this.lastError);
        return;
      }
      const nothing =
        this.captured === 0 &&
        this.failed === 0 &&
        (this.writeReport?.written_profiles.length ?? 0) === 0 &&
        (this.writeReport?.skipped_profiles.length ?? 0) === 0;
      toasts.info(
        nothing
          ? t('settings.bookmarkSync.manualNothing')
          : t('settings.bookmarkSync.manualResult', {
              captured: this.captured,
              skipped: this.skipped,
              failed: this.failed,
            }),
      );
    },

    async maybeSync(force = false): Promise<boolean> {
      const settings = useSettingsStore();
      const workspace = useWorkspaceStore();

      if (!settings.bookmarkSyncEnabled) return false;
      if (isMobile()) return false;
      if (this.running) return false;
      const root = workspace.currentFolder;
      if (!root || root.startsWith('saf:')) return false;
      // Both directions read the workspace index. Wait for it instead of
      // searching the vault file-by-file; the next 60s tick retries.
      if (!useWorkspaceIndexStore().ready) return false;

      const intervalMs = Math.max(1, settings.bookmarkSyncIntervalMinutes) * 60_000;
      if (!force && Date.now() - lastAttemptAt < intervalMs) return false;
      lastAttemptAt = Date.now();

      this.running = true;
      this.lastError = null;
      this.captured = 0;
      this.skipped = 0;
      this.failed = 0;
      this.done = 0;
      this.total = 0;
      this.currentTitle = '';

      try {
        await this.readDirection(root, force);
        await this.writeDirection(root);
        this.lastRunAt = Date.now();
      } catch (e) {
        this.lastError = String(e);
      } finally {
        this.phase = 'idle';
        this.currentTitle = '';
        this.running = false;
      }
      return true;
    },

    async readDirection(root: string, force: boolean) {
      const settings = useSettingsStore();
      this.phase = 'reading';

      let catalog: BookmarkCatalog;
      try {
        catalog = await invoke<BookmarkCatalog>('bookmarks_catalog');
        this.catalog = catalog;
      } catch (e) {
        this.lastError = String(e);
        return;
      }

      if (!force && settings.bookmarkSyncFingerprint === catalog.fingerprint) {
        return;
      }

      let plan: BookmarkPlanEntry[];
      try {
        plan = await invoke<BookmarkPlanEntry[]>('bookmarks_sync_plan');
      } catch (e) {
        this.lastError = String(e);
        return; // don't advance the fingerprint — retry next round
      }

      // One global set from the workspace index — no per-folder file scans.
      // `captured_url` is the normalized frontmatter `url:` written by the
      // capture pipeline.
      const index = useWorkspaceIndexStore();
      const captured = new Set<string>();
      for (const note of index.entries) {
        if (note.captured_url) captured.add(note.captured_url);
      }
      const todo = plan.filter((e) => !captured.has(e.normalized_url));
      this.skipped = plan.length - todo.length;
      this.total = todo.length;

      let fatal = false;
      let cursor = 0;
      // ponytail: fixed 4-way pool. Bump it if sites tolerate more; the
      // per-host politeness of the existing capture path is unchanged.
      const worker = async () => {
        while (true) {
          const i = cursor++;
          if (i >= todo.length) return;
          const entry = todo[i];
          const dir = joinDir(root, entry.folder);
          this.currentTitle = entry.title;
          try {
            const outcome = await invoke<{ error: string | null }>('capture_fetch_page', {
              dir,
              url: entry.url,
              fallbackTitle: entry.title,
              sourceTitle: null,
            });
            if (outcome.error) this.failed += 1;
            else this.captured += 1;
            // The stub note still carries `url:`, so don't retry a failed page
            // forever. Same behavior as the manual capture panel.
            captured.add(entry.normalized_url);
          } catch {
            this.failed += 1;
            fatal = true;
          }
          this.done += 1;
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(4, todo.length) }, () => worker()),
      );

      // Make the newly captured notes visible to the write pass in the same
      // round, so their bookmarks are kept instead of looking "user-added".
      if (this.captured > 0) {
        try {
          await invoke('workspace_index_rescan');
          await index.refresh();
        } catch {
          // Next round will catch up via the watcher.
        }
      }

      if (!fatal) {
        settings.bookmarkSyncFingerprint = catalog.fingerprint;
        settings.persist();
      }
    },

    async writeDirection(root: string) {
      const index = useWorkspaceIndexStore();
      // `ready` distinguishes "index loaded and truly empty" from "still
      // loading", which would otherwise wipe SoloMD on every startup.
      if (!index.ready) return;

      this.phase = 'writing';

      const entries: BookmarkWriteEntry[] = [];
      for (const note of index.entries) {
        const rel = relativePath(root, note.path);
        if (rel === null) continue;
        const folder = rel.split('/').slice(0, -1).filter(Boolean);
        const add = (url: unknown, text: string) => {
          if (typeof url !== 'string' || !isHttp(url)) return;
          const label = text.trim() || hostOf(url);
          entries.push({ folder, title: `${note.stem} · ${label}`, url });
        };
        for (const link of note.links ?? []) add(link.url, link.text);
        const fm = note.frontmatter as Record<string, unknown> | null;
        if (fm && typeof fm.url === 'string') add(fm.url, '');
      }

      try {
        this.writeReport = await invoke<ApplyReport>('bookmarks_apply', { entries });
      } catch (e) {
        this.lastError = String(e);
      }
    },
  },
});

function isHttp(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function joinDir(root: string, segments: string[]): string {
  const base = root.replace(/[\\/]+$/, '');
  if (segments.length === 0) return base;
  return `${base}/${segments.join('/')}`;
}

/** Workspace-relative path with `/` separators, or null when outside. */
function relativePath(root: string, path: string): string | null {
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const p = path.replace(/\\/g, '/');
  // Windows drives are case-insensitive.
  const caseInsensitive = /^[a-zA-Z]:\//.test(r);
  const rr = caseInsensitive ? r.toLowerCase() : r;
  const pp = caseInsensitive ? p.toLowerCase() : p;
  if (pp === rr) return '';
  if (!pp.startsWith(`${rr}/`)) return null;
  return p.slice(r.length + 1);
}
