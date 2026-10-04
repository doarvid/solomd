<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { revealInFileManager } from '../lib/reveal-in-file-manager';
import { useTabsStore } from '../stores/tabs';
import { useToastsStore } from '../stores/toasts';
import { useTilesStore } from '../stores/tiles';
import { useSettingsStore } from '../stores/settings';
import { useWorkspaceStore } from '../stores/workspace';
import { useFiles } from '../composables/useFiles';
import { requestRevealInTree } from '../composables/useFileTreeReveal';
import { shortcutLabel } from '../lib/keybindings';
import { isMacOS } from '../lib/platform';
import { useI18n } from '../i18n';
import { useOverlayPresenceOf } from '../lib/overlay-presence';
import type { SplitDirection } from '../types';

const props = defineProps<{
  paneId: string;
  activeTabId: string;
}>();

const tabs = useTabsStore();
const tiles = useTilesStore();
const settings = useSettingsStore();
const workspace = useWorkspaceStore();
const files = useFiles();
const { t } = useI18n();
const macChord = isMacOS();
/** "New tab (Ctrl+N)" — the chord is read at render time so a rebind in
 *  Settings shows up here (same reason CommandPalette does it). */
const newTabChord = shortcutLabel('file.new', settings.keybindings, macChord);

const tabsEl = ref<HTMLElement | null>(null);

// #263 / #306 — dragging a tab onto the editor splits it, and the new pane
// had no visible way to close: closing its tab just refills the pane with
// another one, and "Close Pane" lived only in the command palette. The layout
// is also restored on the next launch, so people were left with panes they
// could not get rid of even across reinstalls. Every pane gets a close button
// while there is more than one.
const canClosePane = computed(() => tiles.allLeaves.length > 1);

// When the active tab changes (e.g., opening a new file that creates a tab
// off-screen in a crowded tabbar), scroll it into view so the user sees
// the switch.
watch(
  () => props.activeTabId,
  async (id) => {
    if (!id) return;
    await nextTick();
    const el = tabsEl.value?.querySelector<HTMLElement>(`[data-tab-id="${id}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  },
);

// ---- Context menu ----
const ctxMenu = ref<{ x: number; y: number; tabId: string } | null>(null);
// Registers the menu with App.vue's open-layer count so a native browser
// webview in the pane below stops painting over it. Declared after ctxMenu
// because the registration watches with { immediate: true }.
useOverlayPresenceOf(ctxMenu);

function onContextMenu(e: MouseEvent, tabId: string) {
  e.preventDefault();
  ctxMenu.value = { x: e.clientX, y: e.clientY, tabId };
}

function closeCtxMenu() {
  ctxMenu.value = null;
}

function splitPane(direction: SplitDirection) {
  tiles.splitPane(props.paneId, direction);
  closeCtxMenu();
}

function closePane() {
  tiles.closePane(props.paneId);
  closeCtxMenu();
}

// Tab-level close operations relative to the tab the menu was opened on.
const ctxFlags = computed(() => {
  if (!ctxMenu.value) return null;
  const list = tabs.tabs;
  const idx = list.findIndex((t) => t.id === ctxMenu.value!.tabId);
  if (idx < 0) return null;
  const target = list[idx];
  return {
    hasLeft: idx > 0,
    hasRight: idx < list.length - 1,
    hasOthers: list.length > 1,
    hasSaved: list.some((x) => x.id !== ctxMenu.value!.tabId && x.content === x.savedContent),
    hasAny: list.length > 0,
    // Issue #64 — "Open Enclosing Folder" only meaningful when the tab
    // is backed by a real on-disk path. Untitled / unsaved buffers have
    // no path, so the menu item is rendered disabled.
    hasFilePath: !!target?.filePath,
  };
});

async function closeMany(ids: string[]) {
  for (const id of ids) {
    if (!tabs.tabs.find((t) => t.id === id)) continue;
    await files.closeTabSafe(id);
  }
}

async function onTabAction(action: 'close' | 'closeLeft' | 'closeRight' | 'closeOthers' | 'closeSaved' | 'closeAll' | 'revealInFolder' | 'revealInFileTree') {
  const m = ctxMenu.value;
  closeCtxMenu();
  if (!m) return;
  const list = tabs.tabs;
  const idx = list.findIndex((t) => t.id === m.tabId);
  if (idx < 0) return;
  if (action === 'revealInFolder') {
    const path = list[idx]?.filePath;
    if (!path) return;
    try { await revealInFileManager(path); } catch (e) { useToastsStore().error(`${e}`); }
    return;
  }
  if (action === 'revealInFileTree') {
    const path = list[idx]?.filePath;
    if (!path) return;
    if (!settings.showFileTree) settings.toggleFileTree();
    // Revealing is a view action, so the workspace is left alone when the file
    // is already inside it — re-rooting the tree at the file's folder (what
    // this used to do) moved the user's workspace, churned the recent-folder
    // list, and looked like a no-op whenever the file sat directly in the root.
    // Only a file from outside the workspace needs the tree to follow it;
    // otherwise there would be nothing to point at.
    const root = workspace.currentFolder;
    const sep = path.includes('\\') ? '\\' : '/';
    const inside =
      !!root && (path === root || path.startsWith(root.endsWith(sep) ? root : root + sep));
    if (!inside) {
      const parent = path.replace(/[\\/][^\\/]+$/, '');
      if (parent && parent !== path) workspace.setFolder(parent);
    }
    requestRevealInTree(path);
    return;
  }
  const ids = (() => {
    switch (action) {
      case 'close':       return [m.tabId];
      case 'closeLeft':   return list.slice(0, idx).map((x) => x.id);
      case 'closeRight':  return list.slice(idx + 1).map((x) => x.id);
      case 'closeOthers': return list.filter((x) => x.id !== m.tabId).map((x) => x.id);
      case 'closeSaved':  return list.filter((x) => x.content === x.savedContent).map((x) => x.id);
      case 'closeAll':    return list.map((x) => x.id);
    }
    return [];
  })();
  await closeMany(ids);
}

// ---- Pointer-based drag: reorder within the bar + drag-to-split across panes
// ----
// #86 — we deliberately do NOT use the HTML5 Drag and Drop API. On Windows,
// Tauri's native drag-drop (`dragDropEnabled`, which the app relies on for
// dropping files from Explorer into the editor — see App.vue onDragDropEvent)
// makes WebView2 swallow every in-page `draggable` drag at the OS level: the
// cursor shows 🚫 and tabs won't move. Pointer events bypass that interception
// and behave identically on macOS, Windows, and Linux.
const SPLIT_EDGE = 50; // px from a pane edge that arms drag-to-split
const DRAG_THRESHOLD = 4; // px of movement before a press counts as a drag

let pointerStart: { x: number; y: number; tabId: string } | null = null;
let dragging = false;
// Set briefly after a real drag so the trailing synthetic `click` doesn't
// re-activate the tab the user just dropped.
let suppressClick = false;

function onTabPointerDown(e: PointerEvent, tabId: string) {
  // Left button only — middle closes the tab, right opens the context menu.
  if (e.button !== 0) return;
  pointerStart = { x: e.clientX, y: e.clientY, tabId };
  dragging = false;
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
}

// Hit-test the element under the pointer for a drag-to-split target: a pane
// edge that is NOT over the tab bar (positions over a tab bar are reorders).
function paneSplitAt(x: number, y: number): { paneId: string; direction: SplitDirection } | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el || el.closest('.pane-tabbar')) return null;
  const pane = el.closest('[data-pane-id]') as HTMLElement | null;
  const paneId = pane?.getAttribute('data-pane-id');
  if (!pane || !paneId) return null;
  const r = pane.getBoundingClientRect();
  const lx = x - r.left;
  const ly = y - r.top;
  if (lx < SPLIT_EDGE || lx > r.width - SPLIT_EDGE) return { paneId, direction: 'horizontal' };
  if (ly < SPLIT_EDGE || ly > r.height - SPLIT_EDGE) return { paneId, direction: 'vertical' };
  return null;
}

function tabIdAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  return (el?.closest('[data-tab-id]') as HTMLElement | null)?.getAttribute('data-tab-id') ?? null;
}

function onPointerMove(e: PointerEvent) {
  if (!pointerStart) return;
  if (!dragging) {
    const moved = Math.abs(e.clientX - pointerStart.x) + Math.abs(e.clientY - pointerStart.y);
    if (moved < DRAG_THRESHOLD) return;
    dragging = true;
    tiles.beginTabDrag(pointerStart.tabId);
  }
  tiles.setDragSplit(paneSplitAt(e.clientX, e.clientY));
}

function teardownPointer() {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerCancel);
}

function onPointerCancel() {
  teardownPointer();
  pointerStart = null;
  dragging = false;
  tiles.endTabDrag();
}

function onPointerUp(e: PointerEvent) {
  teardownPointer();
  const start = pointerStart;
  pointerStart = null;
  if (!dragging || !start) {
    dragging = false;
    return;
  }
  dragging = false;
  suppressClick = true;

  const split = paneSplitAt(e.clientX, e.clientY);
  if (split) {
    tiles.splitPane(split.paneId, split.direction, start.tabId);
  } else {
    // Reorder: insert relative to the tab under the pointer. Right half of the
    // target inserts AFTER it, left half BEFORE — same rule as before.
    const overId = tabIdAt(e.clientX, e.clientY);
    if (overId && overId !== start.tabId) {
      const targetIdx = tabs.tabs.findIndex((t) => t.id === overId);
      if (targetIdx >= 0) {
        const overEl = tabsEl.value?.querySelector<HTMLElement>(`[data-tab-id="${overId}"]`);
        const rect = overEl?.getBoundingClientRect();
        const after = rect ? e.clientX > rect.left + rect.width / 2 : false;
        tabs.reorder(start.tabId, after ? targetIdx + 1 : targetIdx);
      }
    }
  }
  tiles.endTabDrag();
}

// ---- #218 — every open tab one click away ----
// With many files open the strip overflows. It scrolls (wheel, middle-drag;
// #106), but its scrollbar is hidden, so nothing says so — "根本没办法切换，
// 显示不全". While the strip overflows, a "⌄" button lists every open tab.
const tabsOverflow = ref(false);
function measureTabsOverflow() {
  const el = tabsEl.value;
  tabsOverflow.value = !!el && el.scrollWidth > el.clientWidth + 1;
}
let tabsRO: ResizeObserver | null = null;
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined' && tabsEl.value) {
    tabsRO = new ResizeObserver(measureTabsOverflow);
    tabsRO.observe(tabsEl.value);
  }
  measureTabsOverflow();
});
onBeforeUnmount(() => tabsRO?.disconnect());
watch(
  () => tabs.tabs.map((x) => x.fileName).join('\u0000'),
  () => nextTick(measureTabsOverflow),
);

const tabListPos = ref<{ top: number; right: number } | null>(null);
function toggleTabList(e: MouseEvent) {
  if (tabListPos.value) {
    tabListPos.value = null;
    return;
  }
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  tabListPos.value = { top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) };
}
function pickFromTabList(tabId: string) {
  tabListPos.value = null;
  tiles.setActiveTab(props.paneId, tabId);
}

function onTabClick(tabId: string) {
  // Swallow the click that immediately follows a drag-drop.
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  tiles.setActiveTab(props.paneId, tabId);
}

// ---- Horizontal scroll: mouse wheel over the tab strip (#106) ----
// The bar hides its scrollbar, so without this hidden/overflowing tabs are
// unreachable on a trackpad/mouse. Translate vertical wheel deltas into
// horizontal scroll; honor native horizontal deltas (deltaX) as-is.
function onTabsWheel(e: WheelEvent) {
  const el = tabsEl.value;
  if (!el) return;
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  el.scrollLeft += delta;
}

// ---- Middle-button: drag-to-pan, or close on a clean click (#106) ----
// #89 added middle-click-to-close. To also restore middle-drag panning we
// distinguish the two: motion past DRAG_THRESHOLD pans the strip and cancels
// the close; a middle press with no real movement closes the tab on release.
let middleStart: { x: number; scrollLeft: number; tabId: string } | null = null;
let middleDragging = false;

function onMiddlePointerDown(e: MouseEvent, tabId: string) {
  // Prevent the OS auto-scroll affordance some platforms attach to middle-press.
  e.preventDefault();
  middleStart = { x: e.clientX, scrollLeft: tabsEl.value?.scrollLeft ?? 0, tabId };
  middleDragging = false;
  window.addEventListener('mousemove', onMiddleMove);
  window.addEventListener('mouseup', onMiddleUp);
}

function onMiddleMove(e: MouseEvent) {
  if (!middleStart) return;
  const dx = e.clientX - middleStart.x;
  if (!middleDragging && Math.abs(dx) < DRAG_THRESHOLD) return;
  middleDragging = true;
  // Drag right reveals tabs to the right: pulling the strip with the cursor.
  if (tabsEl.value) tabsEl.value.scrollLeft = middleStart.scrollLeft - dx;
}

function onMiddleUp() {
  window.removeEventListener('mousemove', onMiddleMove);
  window.removeEventListener('mouseup', onMiddleUp);
  const start = middleStart;
  middleStart = null;
  // No real motion → treat as a click and close the tab (#89 behavior).
  if (!middleDragging && start) files.closeTabSafe(start.tabId);
  middleDragging = false;
}

// Close context menu (and the #218 tab list) on click outside
function onDocClick() {
  if (ctxMenu.value) closeCtxMenu();
  if (tabListPos.value) tabListPos.value = null;
}

onMounted(() => document.addEventListener('click', onDocClick));
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  // Drop any drag listeners still attached if the bar unmounts mid-drag.
  teardownPointer();
  window.removeEventListener('mousemove', onMiddleMove);
  window.removeEventListener('mouseup', onMiddleUp);
});
</script>

<template>
  <div class="pane-tabbar">
    <div class="tabs" ref="tabsEl" @wheel.prevent="onTabsWheel">
      <!-- The loop variable is `tab`, not `t`: `t` is the i18n function in
           this component, and `v-for="t in …"` silently shadowed it — any
           `t('key')` written inside the row would have called the tab. -->
      <div
        v-for="tab in tabs.tabs"
        :key="tab.id"
        :data-tab-id="tab.id"
        class="tab"
        :class="{ 'tab--active': tab.id === activeTabId, 'tab--dragging': tiles.dragTabId === tab.id }"
        @click="onTabClick(tab.id)"
        @pointerdown="onTabPointerDown($event, tab.id)"
        @mousedown.middle="onMiddlePointerDown($event, tab.id)"
        @contextmenu="onContextMenu($event, tab.id)"
        :title="tab.filePath || tab.fileName"
      >
        <span class="tab__name">{{ tab.fileName }}</span>
        <button
          v-if="tab.language === 'markdown'"
          class="tab__outline"
          :class="{ 'tab__outline--active': tab.showOutline }"
          :title="tab.showOutline ? t('tabMenu.hideOutline') : t('tabMenu.showOutline')"
          @click.stop="tabs.toggleOutline(tab.id)"
        >≡</button>
        <span class="tab__dot" v-if="tabs.isDirty(tab.id)">●</span>
        <button
          class="tab__close"
          @click.stop="files.closeTabSafe(tab.id)"
          :aria-label="t('tabMenu.close')"
        >×</button>
      </div>
    </div>
    <button
      v-if="tabsOverflow"
      class="tabbar__list"
      :class="{ 'tabbar__list--open': tabListPos }"
      :title="t('tabMenu.allTabs')"
      :aria-label="t('tabMenu.allTabs')"
      :aria-expanded="!!tabListPos"
      @click.stop="toggleTabList"
    >⌄</button>
    <button class="tabbar__new" @click="files.newFile" :title="newTabChord ? `${t('tabMenu.newTab')} (${newTabChord})` : t('tabMenu.newTab')">+</button>
    <button
      v-if="canClosePane"
      class="tabbar__close-pane"
      :title="t('cmd.tile.closePane')"
      :aria-label="t('cmd.tile.closePane')"
      @click.stop="tiles.closePane(paneId)"
    >
      <!-- A pane with an × through it — a tab's own × is right next to it
           and closes the document, which is not what this does. `.stop`:
           the pane's own click handler would otherwise re-focus the pane that
           was just closed. -->
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2" />
        <path d="M6 6l4 4M10 6l-4 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      </svg>
    </button>

    <!-- #218 — all open tabs -->
    <Teleport to="body">
      <div
        v-if="tabListPos"
        class="ctx-menu tablist"
        role="menu"
        :style="{ top: tabListPos.top + 'px', right: tabListPos.right + 'px' }"
        @click.stop
      >
        <button
          v-for="tl in tabs.tabs"
          :key="tl.id"
          class="ctx-item tablist__item"
          :class="{ 'tablist__item--active': tl.id === activeTabId }"
          role="menuitem"
          :title="tl.filePath || tl.fileName"
          @click="pickFromTabList(tl.id)"
        >
          <span class="tablist__name">{{ tl.fileName }}</span>
          <span v-if="tabs.isDirty(tl.id)" class="tablist__dot">●</span>
        </button>
      </div>
    </Teleport>

    <!-- Context menu -->
    <Teleport to="body">
      <div
        v-if="ctxMenu"
        class="ctx-menu"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        @click.stop
      >
        <button class="ctx-item" @click="onTabAction('close')">{{ t('tabMenu.close') }}</button>
        <div class="ctx-sep" />
        <button class="ctx-item" :disabled="!ctxFlags?.hasLeft"   @click="onTabAction('closeLeft')">{{ t('tabMenu.closeLeft') }}</button>
        <button class="ctx-item" :disabled="!ctxFlags?.hasRight"  @click="onTabAction('closeRight')">{{ t('tabMenu.closeRight') }}</button>
        <button class="ctx-item" :disabled="!ctxFlags?.hasOthers" @click="onTabAction('closeOthers')">{{ t('tabMenu.closeOthers') }}</button>
        <div class="ctx-sep" />
        <button class="ctx-item" :disabled="!ctxFlags?.hasSaved" @click="onTabAction('closeSaved')">{{ t('tabMenu.closeSaved') }}</button>
        <button class="ctx-item" :disabled="!ctxFlags?.hasAny"   @click="onTabAction('closeAll')">{{ t('tabMenu.closeAll') }}</button>
        <div class="ctx-sep" />
        <button class="ctx-item" :disabled="!ctxFlags?.hasFilePath" @click="onTabAction('revealInFolder')">{{ t('tabMenu.revealInFolder') }}</button>
        <button class="ctx-item" :disabled="!ctxFlags?.hasFilePath" @click="onTabAction('revealInFileTree')">{{ t('tabMenu.revealInFileTree') }}</button>
        <div class="ctx-sep" />
        <button class="ctx-item" @click="splitPane('horizontal')">{{ t('cmd.tile.splitRight') }}</button>
        <button class="ctx-item" @click="splitPane('vertical')">{{ t('cmd.tile.splitDown') }}</button>
        <div class="ctx-sep" v-if="tiles.allLeaves.length > 1" />
        <button class="ctx-item" v-if="tiles.allLeaves.length > 1" @click="closePane">{{ t('cmd.tile.closePane') }}</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.pane-tabbar {
  display: flex;
  align-items: stretch;
  height: var(--tabbar-h);
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  user-select: none;
  overflow: hidden;
  flex-shrink: 0;
}
.tabs {
  display: flex;
  flex: 1;
  overflow-x: auto;
  scrollbar-width: none;
  /* Momentum + horizontal touch panning for the overflowing strip on iOS. */
  -webkit-overflow-scrolling: touch;
  touch-action: pan-x;
}
.tabs::-webkit-scrollbar { display: none; }

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 200px;
  padding: 0 10px 0 14px;
  border-right: 1px solid var(--border);
  cursor: pointer;
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  position: relative;
  /* Pointer-based drag (#86): block vertical pan / pinch-zoom during a drag,
     but ALLOW horizontal panning. Tabs fill the whole strip, so a touch always
     lands on a `.tab`; `touch-action: none` here meant a finger swipe could
     never scroll an overflowing tab bar on iOS/iPad — the bar was stuck (the
     user's #139 follow-up). `pan-x` lets the finger scroll the strip while a
     mouse drag (unaffected by touch-action) still reorders on desktop. */
  touch-action: pan-x;
}
.tab:hover {
  background: var(--bg-hover);
}
.tab--dragging {
  opacity: 0.5;
}
.tab--active {
  background: var(--bg);
  color: var(--text);
}
.tab--active::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 2px;
  background: var(--accent);
}
.tab__name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.tab__dot {
  color: var(--accent);
  font-size: 10px;
}
.tab__outline {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-faint);
  padding: 1px 4px;
  line-height: 1;
  border-radius: 3px;
  opacity: 0;
  transition: opacity 0.12s, color 0.12s, background 0.12s;
}
.tab:hover .tab__outline,
.tab--active .tab__outline {
  opacity: 1;
}
.tab__outline--active {
  opacity: 1 !important;
  color: var(--accent);
  background: var(--bg-active);
}
.tab__outline:hover {
  color: var(--accent);
  background: var(--bg-hover);
}
.tab__close {
  padding: 0 4px;
  font-size: 14px;
  line-height: 1;
  color: var(--text-faint);
  opacity: 0;
  transition: opacity 0.12s;
}
.tab:hover .tab__close,
.tab--active .tab__close {
  opacity: 1;
}
.tab__close:hover {
  color: var(--text);
  background: var(--bg-active);
}
.tabbar__new {
  width: 32px;
  padding: 0;
  font-size: 16px;
  color: var(--text-muted);
}
.tabbar__list {
  width: 28px;
  padding: 0;
  font-size: 14px;
  color: var(--text-muted);
}
.tabbar__list:hover,
.tabbar__list--open {
  color: var(--text);
}
.tablist {
  max-height: min(60vh, 480px);
  overflow-y: auto;
  min-width: 220px;
  max-width: 420px;
}
.tablist__item {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tablist__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.tablist__item--active {
  color: var(--accent);
  font-weight: 600;
}
.tablist__dot {
  color: var(--accent);
  font-size: 9px;
}
.tabbar__close-pane {
  width: 32px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}
.tabbar__close-pane:hover {
  color: var(--text);
}
.ctx-menu {
  position: fixed;
  z-index: var(--z-pop);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  padding: 4px 0;
  min-width: 140px;
  box-shadow: var(--sh-pop);
}
.ctx-item {
  display: block;
  width: 100%;
  padding: 6px 14px;
  text-align: left;
  font-size: 13px;
  color: var(--text);
  background: none;
  border: none;
  cursor: pointer;
}
.ctx-item:hover:not(:disabled) {
  background: var(--bg-hover);
}
.ctx-item:disabled {
  color: var(--text-faint);
  cursor: default;
}
.ctx-sep {
  height: 1px;
  margin: 4px 8px;
  background: var(--border);
}
</style>
