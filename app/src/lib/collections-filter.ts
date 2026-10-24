/**
 * 收藏源 → 收件箱“待导入”的可见条目过滤。
 *
 * 保持纯函数：不碰 Tauri、不碰 store，方便用 node:test 覆盖去重规则。
 * 去重复用书签同步的 `shouldCapture`，确保两处的“已采集”判断一致。
 */
import { shouldCapture, type DedupeIndex } from './bookmark-dedupe.ts';

export interface PendingItem {
  id: string;
  source: string;
  title: string;
  url: string;
  savedAt?: string | null;
  description?: string | null;
  language?: string | null;
  stars?: number | null;
  topics?: string[];
}

export interface CollectionsState {
  version: number;
  items: PendingItem[];
  dismissed: string[];
  imported: Record<string, string>;
  lastRefresh: Record<string, number>;
}

function savedAtMs(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

export function visibleItems(
  state: CollectionsState,
  dedupe: DedupeIndex,
  normalized: ReadonlyMap<string, string>,
): PendingItem[] {
  const dismissed = new Set(state.dismissed);
  const imported = new Set(Object.keys(state.imported));

  return state.items
    .filter((item) => {
      if (dismissed.has(item.id) || imported.has(item.id)) return false;
      const url = normalized.get(item.id) || item.url;
      return shouldCapture({ title: item.title, normalized_url: url }, dedupe);
    })
    .sort((a, b) => {
      const am = savedAtMs(a.savedAt);
      const bm = savedAtMs(b.savedAt);
      if (am !== bm) {
        if (!Number.isFinite(am)) return 1;
        if (!Number.isFinite(bm)) return -1;
        return bm - am;
      }
      return a.title.localeCompare(b.title);
    });
}
