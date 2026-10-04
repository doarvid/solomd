<script setup lang="ts">
/**
 * 内嵌浏览器 tab 的工具栏。
 *
 * 刻意做得极简 —— **不做书签、历史栈、下载管理、扩展**。这个功能的定位是
 * "知识检索入口"，不是浏览器。地址栏只用来跳转，"采集对话"是唯一的主操作。
 * 后退/前进也没有：保留历史栈就要处理它与会话恢复、多次导航的交互，而它
 * 对"检索 → 采集 → 归档"这条主路径没有贡献。
 */
import { ref, watch } from 'vue';
import type { Tab } from '../types';
import { useBrowserStore } from '../stores/browser';
import { useI18n } from '../i18n';

const props = defineProps<{ tab: Tab }>();
const emit = defineEmits<{ (e: 'captured'): void }>();

const browser = useBrowserStore();
const { t } = useI18n();
const address = ref(props.tab.url ?? '');
const busy = ref(false);

// The tab's url is the last address we navigated to; keep the field in sync
// when it changes from elsewhere.
watch(
  () => props.tab.url,
  (u) => {
    if (u) address.value = u;
  },
);

function normalise(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    // Never hand a non-http scheme to the webview. Rust rejects it too, but
    // failing here keeps the error next to the input.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function go() {
  const url = normalise(address.value);
  if (!url) return;
  await browser.navigate(props.tab.id, url);
}

async function capture() {
  busy.value = true;
  try {
    await browser.requestCapture(props.tab.id);
    emit('captured');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="browser-toolbar">
    <input
      v-model="address"
      class="browser-toolbar__addr"
      type="text"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      :placeholder="'https://…'"
      @keydown.enter.prevent="go"
    />
    <button class="browser-toolbar__btn" type="button" :disabled="busy" @click="capture">
      {{ t('browser.capture') || '采集对话' }}
    </button>
  </div>
</template>

<style scoped>
.browser-toolbar {
  display: flex;
  gap: 6px;
  padding: 4px 6px;
  align-items: center;
  border-bottom: 1px solid var(--border, #e5e5e5);
  flex: 0 0 auto;
}
.browser-toolbar__addr {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  padding: 3px 6px;
  border-radius: 4px;
  border: 1px solid var(--border, #e5e5e5);
  background: var(--input-bg, #fff);
  color: inherit;
}
.browser-toolbar__btn {
  flex: 0 0 auto;
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 4px;
  border: 1px solid var(--border, #e5e5e5);
  background: var(--btn-bg, transparent);
  color: inherit;
  cursor: pointer;
}
.browser-toolbar__btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
