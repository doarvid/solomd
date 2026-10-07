<script setup lang="ts">
/**
 * 关联链接 —— 右侧栏面板。
 *
 * 数据源有**两个**，面板对它们一视同仁：
 *
 * - **浏览器 tab**：链接来自采集回传，目标目录是该 tab 的 `captureDir`
 * - **普通笔记**：链接从正文里现抽（见 lib/external-links.ts），目标目录是
 *   笔记自己所在的目录
 *
 * 后一种是后加的：用户写笔记时同样会贴一堆外链，"这一页引用的东西采过
 * 没有"是个通用问题，不该只在开着浏览器时能问。
 *
 * 「是否已采集」是 URL 归一化后的精确匹配。归一化在 Rust 侧做、经 IPC 取，
 * 这样前端不会和 Rust 各写一份规则然后慢慢漂移。
 */
import { computed, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '../i18n';
import { useBrowserStore } from '../stores/browser';
import { useTabsStore } from '../stores/tabs';
import { isBrowserTab } from '../lib/tab-kind';
import { extractExternalLinks, dirOf, refsDirOf, type ExternalLink } from '../lib/external-links';
import DsButton from '../ui/DsButton.vue';

const { t } = useI18n();
const browser = useBrowserStore();
const tabs = useTabsStore();

// 侧栏每个面板都自己渲染标题栏和关闭按钮（见 BacklinksPanel 等），
// 这里也照做 —— 少了它这一栏在侧栏里没有任何标识。
const emit = defineEmits<{ (e: 'close'): void }>();

interface Source {
  kind: 'browser' | 'note';
  tabId: string;
  /** 来源自己的目录（绝对路径）。空表示这条来源没有目录，不能采集。 */
  dir: string;
  /**
   * 引用页落盘目录。关联链接是"给这篇笔记收一批引用"，收在 `dir/refs`；
   * 从浏览器 tab 来的要看那个 tab 自己定好的 `refsDir`（读原文场景开出来
   * 的 tab 就是文档自己的目录，不套 refs）。
   */
  refsDir: string;
  links: ExternalLink[];
  /** 浏览器来源的对话标题，用于保存按钮的提示。 */
  title: string;
}

const source = computed<Source | null>(() => {
  const tab = tabs.activeTab;
  if (!tab) return null;

  if (isBrowserTab(tab)) {
    const payload = browser.pending[tab.id];
    const dir = tab.captureDir ?? '';
    return {
      kind: 'browser',
      tabId: tab.id,
      dir,
      // 老 tab（会话恢复出来的）没有 refsDir，回退成老版本的行为。
      refsDir: tab.refsDir ?? refsDirOf(dir),
      links: (payload?.links ?? []).map((l) => ({ href: l.href, text: l.text })),
      title: payload?.title ?? tab.fileName,
    };
  }

  // 普通笔记：正文里的外链。没有 filePath（未保存）就没有目标目录 ——
  // 与其写到别处，不如明确告诉用户先保存。
  try {
    const links = extractExternalLinks(tab.content ?? '');
    if (links.length === 0) return null;
    const dir = tab.filePath ? dirOf(tab.filePath) : '';
    return {
      kind: 'note',
      tabId: tab.id,
      dir,
      // 反链场景：这批引用页收在笔记目录下的 refs/。
      refsDir: refsDirOf(dir),
      links,
      title: tab.fileName,
    };
  } catch {
    // 正文可能是任意内容（大文件、畸形 markdown），抽链接失败不该让面板崩掉。
    return null;
  }
});

/** 归一化后的行。归一化要走 IPC，所以结果缓存在这里而不是模板里现算。 */
interface Row extends ExternalLink {
  norm: string;
}
const rows = ref<Row[]>([]);

async function rebuildRows() {
  const links = source.value?.links ?? [];
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const l of links) {
    const norm = await invoke<string>('capture_normalize_url', { url: l.href }).catch(() => l.href);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ href: l.href, text: l.text, norm });
  }
  rows.value = out;
}

const dir = computed(() => source.value?.dir ?? '');
/** 引用页落盘目录 —— 采集一律写这里。`dir` 只用来扫"已采集"索引。 */
const refsDir = computed(() => source.value?.refsDir ?? '');

watch(
  () => [source.value?.tabId, source.value?.links, dir.value] as const,
  () => void rebuildRows(),
  { immediate: true },
);

// 换目录就重扫一次，否则一进来所有链接都显示"未采集"。
watch(dir, (d) => { if (d) void browser.refreshCaptured(d); }, { immediate: true });

const capturedCount = computed(() => rows.value.filter((r) => browser.isCaptured(r.norm)).length);
const uncaptured = computed(() => rows.value.filter((r) => !browser.isCaptured(r.norm)));

function statusOf(row: Row): 'running' | 'done' | 'failed' | 'captured' | 'idle' {
  const s = browser.linkStatus[row.norm];
  if (s === 'running') return 'running';
  if (s === 'failed') return 'failed';
  if (browser.isCaptured(row.norm)) return 'captured';
  return s === 'done' ? 'done' : 'idle';
}

/**
 * 来源笔记的**文件名主干**。
 *
 * wikilink 指向的是文件名而不是路径：`[[某次对话]]`，不是
 * `[[/Users/x/vault/某次对话]]`。浏览器 tab 的标题就是保存时的文件名，
 * 笔记 tab 的 fileName 带扩展名，要去掉。
 */
const sourceStem = computed(() => {
  const s = source.value;
  if (!s) return undefined;
  if (s.kind === 'browser') return s.title;
  return s.title.replace(/\.(md|markdown|mdown|mkd|txt)$/i, '');
});

async function captureOne(row: Row) {
  if (!refsDir.value) return;
  await browser.captureLink(refsDir.value, row.href, row.text, sourceStem.value);
}

/** 内嵌浏览器只在支持的平台上有（Wayland / 移动端为 false）。 */
const canBrowse = computed(() => browser.platformSupported === true);

/**
 * 在内嵌浏览器里打开这条链接。**目标目录跟着来源走** —— 打开就是为了
 * 能顺手采下来，换个目录等于白开；`refsDir` 也一并带过去，这样"从面板
 * 采集"和"从浏览器工具栏采集"落的是同一个地方。
 */
function openInBrowser(row: Row) {
  tabs.newBrowserTab({
    url: row.href,
    captureDir: dir.value,
    refsDir: refsDir.value,
    title: row.text || row.href,
    // 采集那一步在浏览器 tab 里做，来源笔记得跟着走 —— 否则采下来的页面
    // 不会 `[[wikilink]]` 回这篇笔记。
    sourceTitle: sourceStem.value,
  });
}

async function captureAll() {
  if (!refsDir.value) return;
  // 串行：并发抓取会同时打一批站点，既容易触发反爬，也让逐条状态无法阅读。
  for (const row of [...uncaptured.value]) {
    await browser.captureLink(refsDir.value, row.href, row.text, sourceStem.value);
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
    <header class="rlinks__head">
      <span class="rlinks__title">{{ t('rsPane.relatedLinks') }}</span>
      <span v-if="rows.length" class="rlinks__count">{{ capturedCount }}/{{ rows.length }}</span>
      <button
        class="rs-pane-close"
        type="button"
        :title="t('rightSidebar.hidePane')"
        @click="emit('close')"
      >×</button>
    </header>

    <div v-if="!source" class="rlinks__empty">
      {{ t('browser.noLinks') }}
    </div>

    <template v-else>
      <div class="rlinks__actions">
        <DsButton size="sm" :disabled="uncaptured.length === 0" @click="captureAll">
          {{ t('browser.captureAll') }}
        </DsButton>
      </div>

      <!-- 没有目标目录就没法采集。说清楚原因，而不是让按钮点了没反应。 -->
      <p v-if="!refsDir" class="rlinks__hint">{{ t('browser.noTargetDir') }}</p>

      <p v-if="browser.notice" class="rlinks__notice">{{ browser.notice }}</p>

      <ul class="rlinks__list">
        <li v-for="row in rows" :key="row.norm" class="rlinks__item">
          <!-- 标题和操作分两行：挤在一行时标题只剩几个字，按钮也点不准。 -->
          <div class="rlinks__title" :title="row.norm">{{ row.text }}</div>
          <div class="rlinks__meta">
            <span class="rlinks__status" :class="`rlinks__status--${statusOf(row)}`">
              {{ label(statusOf(row)) }}
            </span>
            <div class="rlinks__ops">
              <DsButton v-if="canBrowse" size="sm" variant="ghost" @click="openInBrowser(row)">
                {{ t('browser.openInBrowser') }}
              </DsButton>
              <DsButton
                v-if="refsDir && !browser.isCaptured(row.norm) && statusOf(row) !== 'running'"
                size="sm"
                variant="ghost"
                @click="captureOne(row)"
              >
                {{ t('browser.captureOne') }}
              </DsButton>
            </div>
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
  height: 100%;
  min-height: 0;
  /* 滚动只发生在下面的列表里 —— 标题栏钉在顶部（issue: 标题不该跟着滚）。 */
  overflow: hidden;
}
.rlinks__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex: 0 0 auto;
}
.rlinks__title {
  font-weight: 600;
}
.rlinks__count {
  color: var(--text-faint);
  margin-right: auto;
}
.rlinks__actions {
  display: flex;
  justify-content: flex-end;
}
.rlinks__hint,
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
  gap: var(--sp-3);
  flex: 1;
  /* min-height:0 —— 否则 flex 项不肯缩到内容高度以下，列表会顶破面板而不是滚动。 */
  min-height: 0;
  overflow-y: auto;
}
.rlinks__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rlinks__title {
  /* 允许折两行：链接标题常常是整句话，单行省略等于没显示。 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.35;
}
.rlinks__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}
.rlinks__status {
  color: var(--text-faint);
}
.rlinks__ops {
  display: flex;
  gap: var(--sp-2);
}
.rlinks__status--captured,
.rlinks__status--done {
  color: var(--accent);
}
.rlinks__status--failed {
  color: var(--danger, #c0392b);
}
</style>
