<script setup lang="ts">
/**
 * 关联连接 —— 右侧栏面板。
 *
 * 显示当前浏览器 tab 采集到的引用链接，每条标注**是否已在目标目录里采过**，
 * 并可以逐条采集。
 *
 * 「是否已采集」是 URL 归一化后的精确匹配（见 capture_store.rs 的
 * normalize_url）。归一化在 Rust 侧做，前端调 capture_normalize_url 取，
 * 这样两边不会各写一份然后慢慢漂移。
 */
import { computed, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '../i18n';
import { useBrowserStore } from '../stores/browser';
import { useTabsStore } from '../stores/tabs';
import { isBrowserTab } from '../lib/tab-kind';
import DsButton from '../ui/DsButton.vue';

const { t } = useI18n();
const browser = useBrowserStore();
const tabs = useTabsStore();

/** 当前浏览器 tab —— 面板只服务它。 */
const activeBrowserTab = computed(() => {
  const t = tabs.activeTab;
  return t && isBrowserTab(t) ? t : tabs.tabs.find((x) => isBrowserTab(x));
});

const payload = computed(() =>
  activeBrowserTab.value ? browser.pending[activeBrowserTab.value.id] : undefined,
);

const dir = computed(() => activeBrowserTab.value?.captureDir ?? '');

/** 归一化后的链接 + 是否已采集。归一化结果缓存在这里，避免每条每帧都
 *  走一次 IPC。 */
interface Row {
  raw: string;
  norm: string;
  title: string;
}
const rows = ref<Row[]>([]);

async function rebuildRows() {
  const links = payload.value?.links ?? [];
  const out: Row[] = [];
  const seen = new Set<string>();
  for (const l of links) {
    const norm = await invoke<string>('capture_normalize_url', { url: l.href }).catch(() => l.href);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ raw: l.href, norm, title: l.text || norm });
  }
  rows.value = out;
}

// 换了 tab、换了一轮采集结果、或者目录变了，都要重算。
watch(() => [activeBrowserTab.value?.id, payload.value, dir.value] as const, () => {
  void rebuildRows();
}, { immediate: true });

// 面板挂载时先扫一次目录，否则一进来所有链接都显示"未采集"。
watch(dir, (d) => { if (d) void browser.refreshCaptured(d); }, { immediate: true });

const capturedCount = computed(
  () => rows.value.filter((r) => browser.isCaptured(r.norm)).length,
);

const uncaptured = computed(() => rows.value.filter((r) => !browser.isCaptured(r.norm)));

function statusOf(row: Row): 'running' | 'done' | 'failed' | 'captured' | 'idle' {
  const s = browser.linkStatus[row.norm];
  if (s === 'running') return 'running';
  if (s === 'failed') return 'failed';
  if (browser.isCaptured(row.norm)) return 'captured';
  return s === 'done' ? 'done' : 'idle';
}

async function captureOne(row: Row) {
  if (!dir.value) return;
  await browser.captureLink(dir.value, row.raw, row.title);
}

async function captureAll() {
  if (!dir.value) return;
  // 串行：并发抓取会同时打一批站点，既容易触发反爬，也让逐条状态无法阅读。
  for (const row of [...uncaptured.value]) {
    await browser.captureLink(dir.value, row.raw, row.title);
  }
}

function label(s: ReturnType<typeof statusOf>): string {
  switch (s) {
    case 'running': return t('browser.linkRunning');
    case 'done': return t('browser.linkDone');
    case 'failed': return t('browser.linkFailed');
    case 'captured': return t('browser.linkCaptured');
    default: return t('browser.linkIdle');
  }
}
</script>

<template>
  <div class="rlinks">
    <div v-if="!activeBrowserTab" class="rlinks__empty">
      {{ t('browser.noTab') }}
    </div>

    <template v-else>
      <div class="rlinks__head">
        <span class="rlinks__count">
          {{ t('browser.capturedOf', { done: String(capturedCount), total: String(rows.length) }) }}
        </span>
        <DsButton
          size="sm"
          :disabled="uncaptured.length === 0"
          @click="captureAll"
        >
          {{ t('browser.captureAll') }}
        </DsButton>
      </div>

      <p v-if="browser.notice" class="rlinks__notice">{{ browser.notice }}</p>

      <div v-if="rows.length === 0" class="rlinks__empty">
        {{ t('browser.noLinks') }}
      </div>

      <ul v-else class="rlinks__list">
        <li v-for="row in rows" :key="row.norm" class="rlinks__item">
          <div class="rlinks__title" :title="row.norm">{{ row.title }}</div>
          <div class="rlinks__meta">
            <span class="rlinks__status" :class="`rlinks__status--${statusOf(row)}`">
              {{ label(statusOf(row)) }}
            </span>
            <DsButton
              v-if="!browser.isCaptured(row.norm) && statusOf(row) !== 'running'"
              size="sm"
              variant="ghost"
              @click="captureOne(row)"
            >
              {{ t('browser.captureOne') }}
            </DsButton>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.rlinks {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-2);
  font-size: 12px;
  min-height: 0;
  overflow: auto;
}
.rlinks__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}
.rlinks__count {
  color: var(--text-faint);
}
.rlinks__notice {
  margin: 0;
  color: var(--text-faint);
  word-break: break-word;
}
.rlinks__empty {
  color: var(--text-faint);
  padding: var(--sp-2) 0;
}
.rlinks__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.rlinks__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rlinks__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rlinks__meta {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.rlinks__status {
  color: var(--text-faint);
}
.rlinks__status--captured,
.rlinks__status--done {
  color: var(--accent);
}
.rlinks__status--failed {
  color: var(--danger, #c0392b);
}
</style>
