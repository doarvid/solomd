import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { IS_APP_STORE_BUILD } from './app-build';

export type SupporterTier = 'coffee' | 'meal' | 'feast';

export interface TipTierSpec {
  productId: string;
  tier: SupporterTier;
  icon: string;
  titleZh: string;
  titleEn: string;
  descZh: string;
  descEn: string;
  defaultPriceZh: string;
  defaultPriceEn: string;
}

export const SUPPORTER_BADGE = {
  icon: '✨',
  labelZh: '支持者',
  labelEn: 'Supporter',
} as const;

export const TIP_TIERS: readonly TipTierSpec[] = [
  {
    productId: 'app.solomd.tip.coffee',
    tier: 'coffee',
    icon: '☕',
    titleZh: '请喝杯咖啡',
    titleEn: 'Buy a Coffee',
    descZh: '为深夜写代码的开发者添一杯热咖啡，点亮「支持者」徽章。',
    descEn: 'Fuel a late-night coding session and unlock the Supporter badge.',
    defaultPriceZh: '¥8',
    defaultPriceEn: '$0.99',
  },
  {
    productId: 'app.solomd.tip.meal',
    tier: 'meal',
    icon: '🍜',
    titleZh: '请吃顿工作餐',
    titleEn: 'Buy a Lunch',
    descZh: '支持 SoloMD 持续打磨五端体验，点亮「支持者」徽章。',
    descEn: 'Support cross-platform polish and unlock the Supporter badge.',
    defaultPriceZh: '¥28',
    defaultPriceEn: '$2.99',
  },
  {
    productId: 'app.solomd.tip.feast',
    tier: 'feast',
    icon: '🚀',
    titleZh: '强力支持',
    titleEn: 'Generous Support',
    descZh: '支持 SoloMD 保持免费开源与独立开发，点亮「支持者」徽章。',
    descEn: 'Champion free, open-source independent development and unlock the Supporter badge.',
    defaultPriceZh: '¥68',
    defaultPriceEn: '$9.99',
  },
] as const;

export interface SupporterRecord {
  active: boolean;
  purchasedIds: string[];
  count: number;
  updatedAt: number;
}

export interface IapProductInfo {
  productId: string;
  title: string;
  description: string;
  formattedPrice: string;
}

interface BackendIapState {
  supported: boolean;
  isStoreBuild: boolean;
  purchasedIds: string[];
}

interface BackendPurchaseResult {
  status: 'purchased' | 'restored' | 'cancelled' | string;
  productId: string;
  purchasedIds: string[];
}

const STORAGE_KEY = 'solomd.supporter.v1';

export function tierFromProductId(productId: string): SupporterTier | null {
  if (productId === 'app.solomd.tip.feast' || productId === 'feast') return 'feast';
  if (productId === 'app.solomd.tip.meal' || productId === 'meal') return 'meal';
  if (productId === 'app.solomd.tip.coffee' || productId === 'coffee') return 'coffee';
  return null;
}

export function badgeInfo(
  active: boolean,
  isZh: boolean,
): { icon: string; label: string } | null {
  if (!active) return null;
  return {
    icon: SUPPORTER_BADGE.icon,
    label: isZh ? SUPPORTER_BADGE.labelZh : SUPPORTER_BADGE.labelEn,
  };
}

export function mergeSupporterRecord(
  current: SupporterRecord,
  incomingIds: readonly string[],
  incrementCount = false,
): SupporterRecord {
  const set = new Set<string>(current.purchasedIds);
  for (const id of incomingIds) {
    if (tierFromProductId(id)) set.add(id);
  }
  const purchasedIds = Array.from(set);
  const active = purchasedIds.length > 0 || current.active;
  const count = incrementCount
    ? Math.max(1, current.count + 1)
    : Math.max(current.count, purchasedIds.length);
  return {
    active,
    purchasedIds,
    count,
    updatedAt: Date.now(),
  };
}

function readStoredRecord(): SupporterRecord {
  try {
    if (typeof localStorage === 'undefined') {
      return { active: false, purchasedIds: [], count: 0, updatedAt: 0 };
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { active: false, purchasedIds: [], count: 0, updatedAt: 0 };
    }
    const parsed = JSON.parse(raw);
    const ids = Array.isArray(parsed?.purchasedIds)
      ? parsed.purchasedIds.filter((x: unknown): x is string => typeof x === 'string')
      : [];
    return {
      active: Boolean(parsed?.active || ids.length > 0),
      purchasedIds: ids,
      count: typeof parsed?.count === 'number' && parsed.count > 0 ? parsed.count : ids.length,
      updatedAt: typeof parsed?.updatedAt === 'number' ? parsed.updatedAt : 0,
    };
  } catch {
    return { active: false, purchasedIds: [], count: 0, updatedAt: 0 };
  }
}

function writeStoredRecord(rec: SupporterRecord): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rec));
    }
  } catch {
    /* ignore storage quota errors */
  }
}

export const supporterRecord = ref<SupporterRecord>(readStoredRecord());
export const storeProducts = ref<Record<string, IapProductInfo>>({});
export const iapNativeSupported = ref<boolean>(IS_APP_STORE_BUILD);
export const iapUseStoreFlow = ref<boolean>(IS_APP_STORE_BUILD);

export const isSupporter = computed(() => supporterRecord.value.active);

let initDone = false;

export async function initSupporterState(): Promise<void> {
  if (initDone) return;
  initDone = true;
  try {
    const state = await invoke<BackendIapState>('iap_get_state');
    iapNativeSupported.value = Boolean(state?.supported);
    iapUseStoreFlow.value = Boolean(state?.isStoreBuild || IS_APP_STORE_BUILD);
    if (Array.isArray(state?.purchasedIds) && state.purchasedIds.length > 0) {
      const merged = mergeSupporterRecord(supporterRecord.value, state.purchasedIds, false);
      supporterRecord.value = merged;
      writeStoredRecord(merged);
    }
  } catch {
    /* non-Tauri or desktop test env */
  }
}

export async function fetchStoreProducts(): Promise<void> {
  await initSupporterState();
  if (!iapNativeSupported.value) return;
  try {
    const list = await invoke<IapProductInfo[]>('iap_fetch_products', {
      productIds: TIP_TIERS.map((t) => t.productId),
    });
    if (Array.isArray(list)) {
      const map: Record<string, IapProductInfo> = { ...storeProducts.value };
      for (const item of list) {
        if (item?.productId) {
          map[item.productId] = item;
        }
      }
      storeProducts.value = map;
    }
  } catch {
    /* offline or products not yet approved in store console — keep default labels */
  }
}

export async function purchaseTipTier(
  productId: string,
): Promise<{ status: 'purchased' | 'restored' | 'cancelled'; record: SupporterRecord }> {
  const res = await invoke<BackendPurchaseResult>('iap_purchase', { productId });
  if (res.status === 'purchased' || res.status === 'restored') {
    const ids = Array.isArray(res.purchasedIds) && res.purchasedIds.length > 0
      ? res.purchasedIds
      : [productId];
    const merged = mergeSupporterRecord(
      supporterRecord.value,
      ids.includes(productId) ? ids : [...ids, productId],
      res.status === 'purchased',
    );
    supporterRecord.value = merged;
    writeStoredRecord(merged);
    return { status: res.status, record: merged };
  }
  return { status: 'cancelled', record: supporterRecord.value };
}

export async function restoreSupporterPurchases(): Promise<SupporterRecord> {
  const ids = await invoke<string[]>('iap_restore');
  if (Array.isArray(ids) && ids.length > 0) {
    const merged = mergeSupporterRecord(supporterRecord.value, ids, false);
    supporterRecord.value = merged;
    writeStoredRecord(merged);
  }
  return supporterRecord.value;
}

export function activateSupporterBadgeLocally(productId = 'app.solomd.tip.coffee'): SupporterRecord {
  const merged = mergeSupporterRecord(supporterRecord.value, [productId], true);
  supporterRecord.value = merged;
  writeStoredRecord(merged);
  return merged;
}
