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
import { useTabsStore } from '../stores/tabs';
import { useWorkspaceStore } from '../stores/workspace';
import { useToastsStore } from '../stores/toasts';
import { isMobile } from '../lib/platform';
import { useI18n } from '../i18n';

const { t } = useI18n();
const settings = useSettingsStore();
const collections = useCollectionsStore();
const tabs = useTabsStore();
const workspace = useWorkspaceStore();
const toasts = useToastsStore();
const githubConnected = ref(false);

const pendingCount = computed(() => collections.pendingItems.length);
const toutiaoPending = computed(
  () => collections.pendingItems.filter((i) => i.source === 'toutiao').length,
);
const lastRefresh = computed(() => collections.state?.lastRefresh?.github ?? 0);
const lastToutiaoRefresh = computed(() => collections.state?.lastRefresh?.toutiao ?? 0);
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

function openToutiaoLogin() {
  const dir = workspace.currentFolder ? `${workspace.currentFolder}/inbox` : '';
  tabs.newBrowserTab({
    url: 'https://www.toutiao.com/',
    captureDir: dir,
    refsDir: dir,
    title: t('settings.collectionSources.toutiaoHeading'),
  });
}

async function collectToutiao() {
  await collections.refreshToutiao(true);
}

function toggleToutiao() {
  settings.persist();
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
        <span
          class="collection-sources__status"
          :class="{ 'is-on': settings.collectionToutiaoEnabled && !collections.toutiaoLoginRequired }"
        >
          {{
            settings.collectionToutiaoEnabled && !collections.toutiaoLoginRequired
              ? t('settings.collectionSources.connected')
              : t('settings.collectionSources.toutiaoLoginNeeded')
          }}
        </span>
      </div>
      <p class="collection-sources__hint">{{ t('settings.collectionSources.toutiaoHint') }}</p>

      <div class="collection-sources__row">
        <button class="rp-btn" type="button" @click="openToutiaoLogin">
          {{ t('settings.collectionSources.toutiaoOpenLogin') }}
        </button>
        <button
          class="rp-btn rp-btn--primary"
          type="button"
          :disabled="collections.refreshing || !collections.available"
          @click="collectToutiao"
        >
          {{
            collections.refreshing
              ? t('settings.collectionSources.refreshing')
              : t('settings.collectionSources.toutiaoCollect')
          }}
        </button>
      </div>

      <label class="collection-sources__row">
        <input
          v-model="settings.collectionToutiaoEnabled"
          type="checkbox"
          @change="toggleToutiao"
        />
        <span>{{ t('settings.collectionSources.toutiaoEnable') }}</span>
      </label>

      <div class="collection-sources__row">
        <span class="collection-sources__hint">
          {{ t('settings.collectionSources.lastRefresh') }} {{ lastToutiaoRefresh ? new Date(lastToutiaoRefresh).toLocaleString() : t('settings.collectionSources.never') }}
        </span>
        <span class="collection-sources__hint">
          {{ t('settings.collectionSources.toutiaoPending', { n: String(toutiaoPending) }) }}
        </span>
      </div>
      <p v-if="collections.toutiaoLoginRequired" class="collection-sources__hint">
        {{ t('settings.collectionSources.toutiaoLoginHint') }}
      </p>
      <p v-if="collections.lastError" class="collection-sources__error">
        {{ t('settings.collectionSources.lastError', { error: collections.lastError }) }}
      </p>
    </div>

    <label class="collection-sources__row">
      <input v-model="settings.captureRenderFallback" type="checkbox" @change="persistToggle" />
      <span>{{ t('settings.collectionSources.renderFallback') }}</span>
    </label>
    <p class="collection-sources__hint">{{ t('settings.collectionSources.renderFallbackHint') }}</p>
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
