<script setup lang="ts">
/**
 * 内嵌浏览器 tab 的工具栏。
 *
 * 刻意做得极简 —— **不做书签、历史栈、下载管理、扩展**。这个功能的定位是
 * "知识检索入口"，不是浏览器。地址栏只用来跳转，"采集对话"是唯一的主操作。
 * 后退/前进也没有：保留历史栈就要处理它与会话恢复、多次导航的交互，而它
 * 对"检索 → 采集 → 归档"这条主路径没有贡献。
 */
import { computed, ref, watch } from 'vue';
import type { Tab } from '../types';
import { useBrowserStore } from '../stores/browser';
import { refsDirOf } from '../lib/external-links';
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

/**
 * 这是 DeepSeek 对话页吗？
 *
 * 两种情况必须分开，不能共用一个按钮：`browser_request_capture` 注入的
 * 脚本是 DeepSeek 专用的（调 /api/v0/chat/history_messages 拿结构化 JSON），
 * 在别的站点上什么也提取不到；而通用网页抓取走的是 `capture_fetch_page`
 * （服务端抓 + 正文抽取，GitHub 仓库读 README），在对话页上只能捞到一坨 UI 文本。
 *
 * 地址取地址栏的值而不是 `tab.url`：后者只在建 tab 时写一次，页内跳转
 * （点页面里的链接）不会更新它。
 */
const isChatPage = computed(() => {
  const u = normalise(address.value);
  return !!u && new URL(u).hostname === 'chat.deepseek.com';
});

/**
 * 采集本页 —— 通用网页抓取，和「关联链接」面板是同一个后端命令
 * （`capture_fetch_page`），所以采完面板里那条会直接变成「已采集」。
 *
 * `sourceTitle` 带上 tab 的来源笔记（从关联链接面板开出来的会带），
 * 采集页的 frontmatter 与正文才有 `[[wikilink]]` 指回去。
 */
const capturingPage = ref(false);

/**
 * 引用页落盘目录 —— **开 tab 时就定好了**（见 stores/tabs.ts 的 `refsDir`），
 * 关联链接场景是 `D/refs`，读原文场景就是文档自己的目录。这里只管用，
 * 不再猜该不该多套一层。会话恢复出来的老 tab 没有这个字段，退回老行为。
 */
const refsDir = computed(() => props.tab.refsDir ?? refsDirOf(props.tab.captureDir ?? ''));

async function capturePage() {
  const url = normalise(address.value) ?? props.tab.url;
  const dir = refsDir.value;
  if (!url || !dir || capturingPage.value) return;
  capturingPage.value = true;
  try {
    await browser.captureLink(dir, url, props.tab.fileName, props.tab.sourceTitle);
  } finally {
    capturingPage.value = false;
  }
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
    <!-- 按页面切换：对话页给「采集对话 + 保存」，普通网页给「采集本页」。
         两边的按钮互不相干，同时摆出来的话另外那个永远是点错的。 -->
    <DsButton
      v-if="isChatPage"
      class="browser-toolbar__btn"
      size="sm"
      :loading="browser.capturing"
      :disabled="browser.capturing"
      @click="capture"
    >
      {{ t('browser.capture') }}
    </DsButton>
    <DsButton
      v-else
      class="browser-toolbar__btn"
      size="sm"
      :loading="capturingPage"
      :disabled="capturingPage || !refsDir"
      :title="refsDir ? '' : t('browser.noTargetDir')"
      @click="capturePage"
    >
      {{ t('browser.capturePage') }}
    </DsButton>
    <DsButton
      v-if="isChatPage"
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
