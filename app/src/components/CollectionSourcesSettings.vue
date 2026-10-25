<script setup lang="ts">
/**
 * Settings → Integrations → Collection sources.
 *
 * Phase 1 only wires GitHub Star. Toutiao is a labelled placeholder so the
 * surface and copy are settled before the browser work lands.
 */
import { computed, onMounted, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../stores/settings';
import { useCollectionsStore } from '../stores/collections';
import { useToastsStore } from '../stores/toasts';
import { isMobile } from '../lib/platform';
import { useI18n } from '../i18n';

const { t } = useI18n();
const settings = useSettingsStore();
const collections = useCollectionsStore();
const toasts = useToastsStore();
const githubConnected = ref(false);

const pendingCount = computed(() => collections.pendingItems.length);
const lastRefresh = computed(() => collections.state?.lastRefresh?.github ?? 0);
const lastRefreshLabel = computed(() => {
  if (!lastRefresh.value) return t('settings.collectionSources.never');
  return new Date(lastRefresh.value).toLocaleString();
});

async function checkConnection() {
  githubConnected.value = await invoke<boolean>('github_has_token').catch(() => false);
}

function persistToggle() {
  settings.persist();
}

function setMinutes(event: Event) {
  const n = Number((event.target as HTMLInputElement).value);
  settings.collectionRefreshMinutes = Number.isFinite(n)
    ? Math.max(1, Math.min(1440, Math.round(n)))
    : 30;
  settings.persist();
}

async function refreshNow() {
  await collections.refresh();
}

function openGithubSettings() {
  window.dispatchEvent(
    new CustomEvent('solomd:settings-section', { detail: { section: 'sync' } }),
  );
}

async function clearHistory() {
  if (!window.confirm(t('settings.collectionSources.clearConfirm'))) return;
  if (await collections.clearHistory()) {
    toasts.success(t('settings.collectionSources.clearDone'));
  }
}

onMounted(() => {
  void checkConnection();
  void collections.load();
});
</script>

<template>
  <section class="collection-sources">
    <h3 class="collection-sources__heading">{{ t('settings.collectionSources.heading') }}</h3>
    <p class="collection-sources__hint">{{ t('settings.collectionSources.hint') }}</p>
    <p v-if="isMobile()" class="collection-sources__hint">
      {{ t('settings.collectionSources.disabledHere') }}
    </p>
    <p v-else-if="!collections.available" class="collection-sources__hint">
      {{ t('settings.collectionSources.noWorkspace') }}
    </p>

    <div class="collection-sources__card">
      <div class="collection-sources__card-head">
        <strong>{{ t('settings.collectionSources.githubHeading') }}</strong>
        <span class="collection-sources__status" :class="{ 'is-on': githubConnected }">
          {{
            githubConnected
              ? t('settings.collectionSources.connected')
              : t('settings.collectionSources.notConnected')
          }}
        </span>
      </div>
      <p class="collection-sources__hint">{{ t('settings.collectionSources.githubHint') }}</p>

      <template v-if="githubConnected">
        <label class="collection-sources__row">
          <input
            v-model="settings.collectionGithubEnabled"
            type="checkbox"
            @change="persistToggle"
          />
          <span>{{ t('settings.collectionSources.enable') }}</span>
        </label>
        <label class="collection-sources__row">
          <span>{{ t('settings.collectionSources.interval') }}</span>
          <input
            class="collection-sources__number"
            type="number"
            min="1"
            max="1440"
            :value="settings.collectionRefreshMinutes"
            @change="setMinutes"
          />
          <span>{{
            t('settings.collectionSources.minutes', {
              count: String(settings.collectionRefreshMinutes),
            })
          }}</span>
        </label>
        <div class="collection-sources__row">
          <button class="rp-btn" type="button" :disabled="collections.refreshing" @click="refreshNow">
            {{
              collections.refreshing
                ? t('settings.collectionSources.refreshing')
                : t('settings.collectionSources.refreshNow')
            }}
          </button>
          <span class="collection-sources__hint">
            {{ t('settings.collectionSources.lastRefresh') }} {{ lastRefreshLabel }}
          </span>
          <span class="collection-sources__hint">
            {{ t('settings.collectionSources.pending', { n: String(pendingCount) }) }}
          </span>
        </div>
        <p v-if="collections.lastError" class="collection-sources__error">
          {{ t('settings.collectionSources.lastError', { error: collections.lastError }) }}
        </p>
        <button class="rp-btn" type="button" @click="clearHistory">
          {{ t('settings.collectionSources.clearHistory') }}
        </button>
      </template>

      <template v-else>
        <p class="collection-sources__hint">{{ t('settings.collectionSources.connectHint') }}</p>
        <div class="collection-sources__row">
          <button class="rp-btn" type="button" @click="openGithubSettings">
            {{ t('settings.collectionSources.goToGithub') }}
          </button>
          <button class="rp-btn" type="button" @click="checkConnection">
            {{ t('settings.collectionSources.recheck') }}
          </button>
        </div>
      </template>
    </div>

    <div class="collection-sources__card">
      <div class="collection-sources__card-head">
        <strong>{{ t('settings.collectionSources.toutiaoHeading') }}</strong>
      </div>
      <p class="collection-sources__hint">{{ t('settings.collectionSources.toutiaoSoon') }}</p>
    </div>
  </section>
</template>

<style scoped>
.collection-sources {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.collection-sources__heading {
  margin: 0;
  font-size: 15px;
}
.collection-sources__hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}
.collection-sources__card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-elev);
}
.collection-sources__card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.collection-sources__status {
  font-size: 12px;
  color: var(--text-faint);
}
.collection-sources__status.is-on {
  color: var(--success);
}
.collection-sources__row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.collection-sources__number {
  width: 72px;
}
.collection-sources__error {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
}
</style>
