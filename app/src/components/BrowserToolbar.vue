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
import DsInput from '../ui/DsInput.vue';
import DsButton from '../ui/DsButton.vue';

const props = defineProps<{ tab: Tab }>();
const emit = defineEmits<{ (e: 'captured'): void }>();

const browser = useBrowserStore();
const { t } = useI18n();
const address = ref(props.tab.url ?? '');

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

/**
 * 采集对话。
 *
 * 不能在这里用局部 loading 标志：`requestCapture` 只是在页面里 eval 一下
 * 就返回，真正的数据随后才经事件到达。用局部队列会让按钮瞬间复位，用户
 * 以为没点上（这正是第一版的问题）。改成由 store 的 `capturing` 驱动，
 * 它一直亮到回传到达或看门狗超时。
 */
async function capture() {
  await browser.requestCapture(props.tab.id);
  emit('captured');
}

/**
 * 保存对话。内容来自上一次「采集对话」的回传 —— 所以顺序是：
 * 先采集，再保存。没采过就提示，而不是写一个空文件。
 */
async function save() {
  await browser.saveConversation(props.tab.id);
}
</script>

<template>
  <div class="browser-toolbar">
    <!-- DsInput/DsButton, not raw markup: they carry the app's real theme
         vars (--text / --bg / --border / --text-faint). Hand-rolled styles
         here picked a non-existent --input-bg and `color: inherit`, which
         rendered the address text near-invisible against the surface. -->
    <DsInput
      v-model="address"
      class="browser-toolbar__addr"
      size="sm"
      :placeholder="t('browser.addressPlaceholder')"
      @keydown.enter.prevent="go"
    />
    <DsButton
      class="browser-toolbar__btn"
      size="sm"
      :loading="browser.capturing"
      :disabled="browser.capturing"
      @click="capture"
    >
      {{ t('browser.capture') }}
    </DsButton>
    <DsButton
      class="browser-toolbar__btn"
      size="sm"
      variant="primary"
      :loading="browser.saving"
      @click="save"
    >
      {{ t('browser.save') }}
    </DsButton>
    <span v-if="browser.notice" class="browser-toolbar__notice" :title="browser.notice">
      {{ browser.notice }}
    </span>
  </div>
</template>

<style scoped>
.browser-toolbar {
  display: flex;
  gap: var(--sp-2);
  padding: var(--sp-2);
  align-items: center;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}
.browser-toolbar__addr {
  flex: 1 1 auto;
  min-width: 0;
}
.browser-toolbar__btn {
  flex: 0 0 auto;
}
/* 采集/保存的结果就地显示在工具栏上 —— 侧栏面板可能根本没打开，
   只把提示放在那里等于没有提示。 */
.browser-toolbar__notice {
  flex: 0 0 auto;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-faint);
}
</style>
