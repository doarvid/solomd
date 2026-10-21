<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { openUrl } from '@tauri-apps/plugin-opener';
import { DsModal } from '../ui';
import { useI18n } from '../i18n';
import {
  TIP_TIERS,
  supporterRecord,
  storeProducts,
  iapUseStoreFlow,
  iapNativeSupported,
  badgeInfo,
  fetchStoreProducts,
  purchaseTipTier,
  restoreSupporterPurchases,
  activateSupporterBadgeLocally,
  type TipTierSpec,
} from '../lib/supporter';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const { lang } = useI18n();
const isZh = computed(() => String(lang.value || '').startsWith('zh'));

const busyProductId = ref<string | null>(null);
const restoring = ref(false);
const feedbackMsg = ref<string | null>(null);
const feedbackKind = ref<'ok' | 'err'>('ok');

const activeBadge = computed(() => badgeInfo(supporterRecord.value.active, isZh.value));

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      feedbackMsg.value = null;
      void fetchStoreProducts();
    }
  },
  { immediate: true },
);

function displayTitle(tier: TipTierSpec): string {
  const live = storeProducts.value[tier.productId]?.title;
  if (live && live.trim()) return live.trim();
  return isZh.value ? tier.titleZh : tier.titleEn;
}

function displayDesc(tier: TipTierSpec): string {
  const live = storeProducts.value[tier.productId]?.description;
  if (live && live.trim()) return live.trim();
  return isZh.value ? tier.descZh : tier.descEn;
}

function displayPrice(tier: TipTierSpec): string {
  const live = storeProducts.value[tier.productId]?.formattedPrice;
  if (live && live.trim()) return live.trim();
  return isZh.value ? tier.defaultPriceZh : tier.defaultPriceEn;
}

async function handleSelectTier(tier: TipTierSpec) {
  if (busyProductId.value || restoring.value) return;
  feedbackMsg.value = null;

  // Store builds (macOS MAS, iOS App Store, Android Google Play) use native
  // StoreKit / Google Play Billing exclusively — never external links.
  if (iapUseStoreFlow.value) {
    busyProductId.value = tier.productId;
    try {
      const res = await purchaseTipTier(tier.productId);
      if (res.status === 'purchased' || res.status === 'restored') {
        feedbackKind.value = 'ok';
        feedbackMsg.value = isZh.value
          ? '🎉 感谢你的支持！已为你点亮专属「✨ 支持者」徽章。'
          : '🎉 Thank you for supporting SoloMD! Your "✨ Supporter" badge is now active.';
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err || '');
      feedbackKind.value = 'err';
      feedbackMsg.value = isZh.value
        ? `暂时无法完成内购：${msg}`
        : `Could not complete purchase: ${msg}`;
    } finally {
      busyProductId.value = null;
    }
    return;
  }

  // Non-store desktop builds (GitHub DMG / Windows / Linux): open sponsor page
  // and unlock the Supporter badge locally.
  try {
    await openUrl('https://solomd.app/#sponsor');
  } catch {
    /* ignore */
  }
  activateSupporterBadgeLocally(tier.productId);
  feedbackKind.value = 'ok';
  feedbackMsg.value = isZh.value
    ? '✨ 已为你点亮「支持者」徽章，感谢支持独立开发！'
    : '✨ Your "Supporter" badge is now active. Thank you for supporting SoloMD!';
}

async function handleRestore() {
  if (busyProductId.value || restoring.value) return;
  restoring.value = true;
  feedbackMsg.value = null;
  try {
    const rec = await restoreSupporterPurchases();
    if (rec.active) {
      feedbackKind.value = 'ok';
      feedbackMsg.value = isZh.value
        ? '✨ 已恢复「支持者」徽章！'
        : '✨ Restored your "Supporter" badge!';
    } else {
      feedbackKind.value = 'err';
      feedbackMsg.value = isZh.value
        ? '未查询到历史支持记录。'
        : 'No previous supporter purchases found.';
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err || '');
    feedbackKind.value = 'err';
    feedbackMsg.value = isZh.value ? `恢复失败：${msg}` : `Restore failed: ${msg}`;
  } finally {
    restoring.value = false;
  }
}
</script>

<template>
  <DsModal
    :model-value="open"
    width="480px"
    @update:model-value="emit('close')"
  >
    <template #header>
      <span class="support-hdr__title">
        {{ isZh ? '支持 SoloMD 独立开发' : 'Support SoloMD' }}
      </span>
    </template>

    <div class="support">
      <!-- Supporter Badge Banner -->
      <div
        class="support__badge-card"
        :class="{
          'support__badge-card--active': Boolean(activeBadge),
        }"
      >
        <div class="support__badge-pill">
          <span class="support__badge-icon">✨</span>
          <span class="support__badge-label">
            {{
              activeBadge
                ? activeBadge.label
                : isZh
                  ? '支持者徽章（待点亮）'
                  : 'Supporter Badge'
            }}
          </span>
        </div>
        <p class="support__badge-sub">
          <template v-if="activeBadge">
            {{
              isZh
                ? '你已点亮专属「支持者」徽章，徽章会展示在「关于」与「设置」界面。'
                : 'Your Supporter badge is active and displayed in About and Settings.'
            }}
          </template>
          <template v-else>
            {{
              isZh
                ? 'SoloMD 所有功能永久免费、无广告。选择任意一档支持，即可永久点亮专属「支持者」徽章。'
                : 'All SoloMD features are free forever. Pick any tier below to permanently unlock your Supporter badge.'
            }}
          </template>
        </p>
      </div>

      <!-- 3 Tip Tier Options -->
      <div class="support__tiers">
        <button
          v-for="tier in TIP_TIERS"
          :key="tier.productId"
          type="button"
          class="support__tier"
          :class="{
            'support__tier--owned': supporterRecord.purchasedIds.includes(tier.productId),
          }"
          :disabled="Boolean(busyProductId) || restoring"
          @click="handleSelectTier(tier)"
        >
          <div class="support__tier-icon">{{ tier.icon }}</div>
          <div class="support__tier-body">
            <div class="support__tier-top">
              <span class="support__tier-title">{{ displayTitle(tier) }}</span>
              <span class="support__tier-badge-tag">
                ✨ {{ isZh ? '支持者徽章' : 'Supporter Badge' }}
              </span>
            </div>
            <div class="support__tier-desc">{{ displayDesc(tier) }}</div>
          </div>
          <div class="support__tier-action">
            <span v-if="busyProductId === tier.productId" class="support__tier-price">…</span>
            <span v-else class="support__tier-price">{{ displayPrice(tier) }}</span>
          </div>
        </button>
      </div>

      <!-- Status / Thank-you message -->
      <div
        v-if="feedbackMsg"
        class="support__feedback"
        :class="feedbackKind === 'ok' ? 'support__feedback--ok' : 'support__feedback--err'"
      >
        {{ feedbackMsg }}
      </div>

      <!-- Footer: note + Restore Purchases -->
      <div class="support__footer">
        <span class="support__note">
          {{
            isZh
              ? '一次性自愿支持（非自动续费订阅）· 核心功能 100% 免费'
              : 'One-time voluntary tip (no auto-renewal) · 100% of features remain free'
          }}
        </span>
        <button
          v-if="iapNativeSupported || iapUseStoreFlow"
          type="button"
          class="support__restore"
          :disabled="Boolean(busyProductId) || restoring"
          @click="handleRestore"
        >
          {{ restoring ? (isZh ? '恢复中…' : 'Restoring…') : isZh ? '恢复徽章' : 'Restore' }}
        </button>
      </div>
    </div>
  </DsModal>
</template>

<style scoped>
.support-hdr__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.support {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 2px 6px;
}

.support__badge-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 8px;
  padding: 16px 14px;
  border-radius: 12px;
  background: var(--bg-elev);
  border: 1px dashed var(--hairline);
  transition: all 0.2s ease;
}

.support__badge-card--active {
  border-style: solid;
  border-color: color-mix(in srgb, var(--accent) 45%, var(--hairline));
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--accent) 12%, var(--bg-elev)),
    var(--bg-elev)
  );
}

.support__badge-card--super {
  border-color: color-mix(in srgb, #f59e0b 55%, var(--hairline));
  background: linear-gradient(
    135deg,
    color-mix(in srgb, #f59e0b 16%, var(--bg-elev)),
    color-mix(in srgb, var(--accent) 10%, var(--bg-elev))
  );
}

.support__badge-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
}

.support__badge-card--super .support__badge-pill {
  color: #d97706;
  background: color-mix(in srgb, #f59e0b 18%, transparent);
  border-color: color-mix(in srgb, #f59e0b 40%, transparent);
}

.support__badge-icon {
  font-size: 15px;
  line-height: 1;
}

.support__badge-sub {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-2);
  max-width: 390px;
}

.support__tiers {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.support__tier {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 13px 14px;
  border-radius: 11px;
  border: 1px solid var(--hairline);
  background: var(--bg-elev);
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease, transform 0.12s ease, background 0.15s ease;
}

.support__tier:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--fill-1);
  transform: translateY(-1px);
}

.support__tier:disabled {
  opacity: 0.65;
  cursor: wait;
}

.support__tier--feast {
  border-color: color-mix(in srgb, var(--accent) 38%, var(--hairline));
}

.support__tier-icon {
  font-size: 24px;
  line-height: 1;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: var(--fill-1);
}

.support__tier-body {
  flex: 1;
  min-width: 0;
}

.support__tier-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.support__tier-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.support__tier-badge-tag {
  font-size: 11px;
  font-weight: 500;
  padding: 1px 7px;
  border-radius: 999px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.support__tier-desc {
  margin-top: 3px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-2);
}

.support__tier-action {
  flex-shrink: 0;
}

.support__tier-price {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 58px;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  background: var(--accent);
}

.support__feedback {
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 12.5px;
  line-height: 1.45;
}

.support__feedback--ok {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
}

.support__feedback--err {
  color: var(--danger, #dc2626);
  background: color-mix(in srgb, var(--danger, #dc2626) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger, #dc2626) 25%, transparent);
}

.support__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-top: 2px;
}

.support__note {
  font-size: 11.5px;
  color: var(--text-3);
}

.support__restore {
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 12px;
  font-weight: 500;
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
}

.support__restore:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
</style>
