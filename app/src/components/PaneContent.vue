<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import Editor from './Editor.vue';
import Preview from './Preview.vue';
import BrowserToolbar from './BrowserToolbar.vue';
import { useSettingsStore } from '../stores/settings';
import { useTilesStore } from '../stores/tiles';
import { useBrowserStore } from '../stores/browser';
import type { Tab } from '../types';
import { isWindowsEditorRuntime, shouldUsePlainWindowsEditor } from '../lib/platform';
import { isBrowserTab } from '../lib/tab-kind';
import { overlayDepth } from '../lib/overlay-presence';
import { toLogicalBounds } from '../lib/browser-rect';

const props = defineProps<{
  paneId: string;
  tab: Tab | undefined;
}>();

const emit = defineEmits<{
  (e: 'cursor', line: number, col: number): void;
  (e: 'selection', text: string): void;
}>();

const settings = useSettingsStore();
const tiles = useTilesStore();
const browserStore = useBrowserStore();

const editorRef = ref<InstanceType<typeof Editor> | null>(null);
const previewRef = ref<InstanceType<typeof Preview> | null>(null);
/** 原生子 webview 的锚点。它的 rect 就是 webview 的位置来源。 */
const browserAnchor = ref<HTMLElement | null>(null);

const isBrowser = computed(() => !!props.tab && isBrowserTab(props.tab));

// Browser tabs must be excluded from BOTH arms below, not just handled first:
// they are 'plaintext' with no path, so showEditor would be true and an empty
// CodeMirror would try to render underneath the native webview.
const showEditor = computed(
  () =>
    !isBrowser.value &&
    (props.tab?.language !== 'markdown' || settings.viewMode !== 'preview')
);
// `liveEdit` mode is editor-only: the inline-rendered markdown IS the
// preview, so we don't show the separate Preview pane next to it.
const showPreview = computed(
  () =>
    !isBrowser.value &&
    props.tab?.language === 'markdown' &&
    settings.viewMode !== 'edit' &&
    settings.viewMode !== 'liveEdit'
);

// Split view with live sync off: the preview renders what's on disk, so it
// only moves when the file is saved (manually or by autosave). A tab that
// has never been saved has nothing on disk yet — keep it live so the preview
// isn't blank. Other view modes always follow the buffer.
const previewSource = computed(() => {
  const tab = props.tab;
  if (!tab) return '';
  if (settings.viewMode !== 'split' || settings.splitLiveSync || !tab.filePath) {
    return tab.content;
  }
  return tab.savedContent;
});

const isFocused = computed(() => tiles.focusedPaneId === props.paneId);
const windowsEditorRuntime = isWindowsEditorRuntime();
// Preserve CodeMirror history/caret on macOS and Linux. Only Windows needs a
// remount because toggling Vim or the editor engine changes the editor
// implementation itself.
const editorImplementationKey = computed(() => {
  if (!windowsEditorRuntime) return `${props.paneId}:codemirror`;
  const plain = shouldUsePlainWindowsEditor(true, settings.vimMode, settings.windowsEditorEngine);
  return `${props.paneId}:${plain ? 'plain' : 'codemirror'}`;
});

function onCursor(line: number, col: number) {
  if (isFocused.value) {
    emit('cursor', line, col);
  }
}

function onSelection(text: string) {
  if (isFocused.value) {
    emit('selection', text);
  }
}

function gotoLine(line: number) {
  if (settings.viewMode === 'preview') {
    previewRef.value?.scrollToLine(line);
  } else {
    editorRef.value?.gotoLine(line);
  }
}

// ---- Pane-scoped scroll sync ----
let syncEditorScroll: (() => void) | null = null;
let syncPreviewScroll: (() => void) | null = null;
let syncGuard = false;

function getPreviewElementsByLine(preview: HTMLElement): Array<{ line: number; el: HTMLElement }> {
  const nodes = preview.querySelectorAll<HTMLElement>('[data-source-line]');
  const list: Array<{ line: number; el: HTMLElement }> = [];
  for (const el of Array.from(nodes)) {
    const n = Number(el.getAttribute('data-source-line') || '0');
    if (n > 0) list.push({ line: n, el });
  }
  list.sort((a, b) => a.line - b.line);
  return list;
}

function findNearestEntry<T extends { line: number }>(list: T[], line: number): T | null {
  if (!list.length) return null;
  let lo = 0, hi = list.length - 1, best = list[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].line <= line) { best = list[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

// Index of the last anchor at/before `line` (-1 when none). The anchor AFTER
// it brackets the viewport top, letting both sync directions interpolate
// between the two instead of snapping to the earlier one. Snapping kept the
// panes level only when an anchor sat exactly at the viewport top; anywhere
// inside a tall block (a long wrapped paragraph, an image) the panes were off
// by up to the block height difference — the 双栏内容上下错位 complaint.
function findAnchorIndex<T extends { line: number }>(list: T[], line: number): number {
  let lo = 0, hi = list.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].line <= line) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

function bindScrollSync() {
  if (syncEditorScroll) syncEditorScroll();
  if (syncPreviewScroll) syncPreviewScroll();
  syncEditorScroll = null;
  syncPreviewScroll = null;

  if (settings.viewMode !== 'split' || !settings.splitLiveSync) return;

  const paneEl = document.querySelector(`[data-pane-id="${props.paneId}"]`);
  if (!paneEl) return;
  // The editor's scroll container differs by platform: CodeMirror exposes
  // `.cm-scroller`, but on Windows the live editor is the native-textarea plain
  // editor (`usePlainWindowsEditor`, v4.7) which has no CodeMirror — it scrolls
  // via `.plain-editor` (source/split) or `.plain-block-editor` (live). Matching
  // only `.cm-scroller` silently dropped scroll-sync on Windows. The exposed
  // `getViewLine()` / `scrollToLine()` already handle both editor paths.
  const editor = paneEl.querySelector(
    '.pane--editor .cm-scroller, .pane--editor .plain-block-editor, .pane--editor .plain-editor',
  ) as HTMLElement | null;
  const preview = paneEl.querySelector('.pane--preview .preview-host') as HTMLElement | null;
  if (!editor || !preview) return;

  // Driver lock: only the pane the user is actively scrolling syncs to the
  // other. The one-frame `syncGuard` alone is too short — a programmatic
  // scroll spawns its own 'scroll' events a frame or two later, after the
  // guard clears, so the two handlers echo each other. That's most visible
  // at the bottom, where the line↔pixel mappings can't both be satisfied:
  // the echoes never converge and the view scrolls forever / bounces. By
  // tracking which pane the user actually drives (wheel / pointer / touch /
  // key) and ignoring the passive pane's induced scrolls, the loop can't
  // form. The window resets on each intent event so continuous scrolling and
  // momentum keep the same driver.
  let activePane: 'editor' | 'preview' | null = null;
  let activeTimer: ReturnType<typeof setTimeout> | null = null;
  const markActive = (which: 'editor' | 'preview') => {
    activePane = which;
    if (activeTimer) clearTimeout(activeTimer);
    activeTimer = setTimeout(() => { activePane = null; }, 250);
  };
  const intentEvents = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const;
  const editorIntent = () => markActive('editor');
  const previewIntent = () => markActive('preview');
  for (const ev of intentEvents) {
    editor.addEventListener(ev, editorIntent, { passive: true });
    preview.addEventListener(ev, previewIntent, { passive: true });
  }

  const onEditorScroll = () => {
    if (syncGuard || activePane === 'preview') return;
    const cmRef = editorRef.value as any;
    // Fractional: 12.5 = halfway down source line 12 (soft wrap included).
    let currentLine: number | null = null;
    if (cmRef?.getViewLine) {
      currentLine = cmRef.getViewLine();
    }
    if (!currentLine) return;

    const previewLines = getPreviewElementsByLine(preview);
    const idx = findAnchorIndex(previewLines, Math.floor(currentLine));
    if (idx < 0) {
      const emax = editor.scrollHeight - editor.clientHeight;
      const pmax = preview.scrollHeight - preview.clientHeight;
      if (emax > 0 && pmax > 0) {
        syncGuard = true;
        preview.scrollTop = (editor.scrollTop / emax) * pmax;
        requestAnimationFrame(() => { syncGuard = false; });
      }
      return;
    }
    const wrapRect = preview.getBoundingClientRect();
    const a = previewLines[idx];
    const aTop = a.el.getBoundingClientRect().top;
    // Interpolate toward the next anchor by the *pixel* fraction the editor
    // has scrolled between the two anchors' lines. Pixel fractions (rather
    // than source-line fractions) keep the panes level even when the blocks
    // between anchors have very different heights in each pane (tall wrapped
    // paragraphs, images).
    let target = aTop;
    const b = previewLines.find((e, i) => i > idx && e.line > a.line);
    if (b && currentLine > a.line) {
      let t: number | null = null;
      const yA = cmRef?.lineTopY ? cmRef.lineTopY(a.line) : null;
      const yB = cmRef?.lineTopY ? cmRef.lineTopY(b.line) : null;
      if (yA != null && yB != null && yB > yA) {
        t = Math.max(0, Math.min(1, (editor.scrollTop - yA) / (yB - yA)));
      } else {
        t = Math.min(1, (currentLine - a.line) / (b.line - a.line));
      }
      target = aTop + t * (b.el.getBoundingClientRect().top - aTop);
    }
    syncGuard = true;
    preview.scrollTop += target - wrapRect.top - 8;
    requestAnimationFrame(() => { syncGuard = false; });
  };

  const onPreviewScroll = () => {
    if (syncGuard || activePane === 'editor') return;
    const cmRef = editorRef.value as any;
    const previewLines = getPreviewElementsByLine(preview);
    const wrapTop = preview.getBoundingClientRect().top + 8;
    // Bracket the viewport top between two anchors, take the pixel fraction
    // scrolled between them, and scroll the editor to the same fraction
    // between the anchors' source lines — the mirror of onEditorScroll.
    for (let i = 0; i < previewLines.length; i++) {
      const r = previewLines[i].el.getBoundingClientRect();
      if (r.bottom < wrapTop) continue;
      const a = previewLines[i];
      let targetLine: number = a.line;
      let t = 0;
      let b: { line: number } | null = null;
      if (r.top < wrapTop && i + 1 < previewLines.length) {
        const next = previewLines[i + 1];
        const bTop = next.el.getBoundingClientRect().top;
        t = bTop > r.top ? Math.min(1, (wrapTop - r.top) / (bTop - r.top)) : 0;
        b = next;
        targetLine = a.line + t * (next.line - a.line);
      }
      const yA = cmRef?.lineTopY ? cmRef.lineTopY(a.line) : null;
      const yB = b && cmRef?.lineTopY ? cmRef.lineTopY(b.line) : null;
      syncGuard = true;
      if (yA != null && (t === 0 || (yB != null && yB > yA))) {
        editor.scrollTop = Math.max(0, yA + (yB != null ? t * (yB - yA) : 0) - 8);
      } else if (cmRef?.scrollToLine) {
        cmRef.scrollToLine(targetLine);
      }
      requestAnimationFrame(() => { syncGuard = false; });
      break;
    }
  };

  editor.addEventListener('scroll', onEditorScroll, { passive: true });
  preview.addEventListener('scroll', onPreviewScroll, { passive: true });
  syncEditorScroll = () => {
    editor.removeEventListener('scroll', onEditorScroll);
    for (const ev of intentEvents) editor.removeEventListener(ev, editorIntent);
  };
  syncPreviewScroll = () => {
    preview.removeEventListener('scroll', onPreviewScroll);
    for (const ev of intentEvents) preview.removeEventListener(ev, previewIntent);
    if (activeTimer) clearTimeout(activeTimer);
  };
}

// v4.3.0 issue #67: preserve scroll position across view-mode switches.
// User flow: scrolls down in preview → finds typo → flips to edit mode →
// previously snapped back to line 1, forcing them to find the spot again.
// We snapshot the "current top line" from whichever view is leaving the DOM,
// then scroll the newly mounted view(s) to that line so the cursor / reader
// stays in roughly the same place.
function getCurrentTopLine(paneEl: Element, fromMode: string): number | null {
  if (fromMode === 'preview' || fromMode === 'reading') {
    const preview = paneEl.querySelector('.pane--preview .preview-host') as HTMLElement | null;
    if (!preview) return null;
    const list = getPreviewElementsByLine(preview);
    const wrapTop = preview.getBoundingClientRect().top;
    for (const { line, el } of list) {
      const r = el.getBoundingClientRect();
      if (r.bottom >= wrapTop) return line;
    }
    return null;
  }
  // edit / liveEdit / split — use the editor's top visible line
  const cmRef = editorRef.value as any;
  return cmRef?.getViewLine ? cmRef.getViewLine() : null;
}

function restoreToLine(paneEl: Element, toMode: string, line: number) {
  if (toMode === 'edit' || toMode === 'liveEdit' || toMode === 'split') {
    const cmRef = editorRef.value as any;
    if (cmRef?.scrollToLine) cmRef.scrollToLine(line);
  }
  if (toMode === 'preview' || toMode === 'reading' || toMode === 'split') {
    const preview = paneEl.querySelector('.pane--preview .preview-host') as HTMLElement | null;
    if (preview) {
      const list = getPreviewElementsByLine(preview);
      const entry = findNearestEntry(list, line);
      if (entry) {
        const elRect = entry.el.getBoundingClientRect();
        const wrapRect = preview.getBoundingClientRect();
        preview.scrollTop += elRect.top - wrapRect.top - 8;
      }
    }
  }
}

watch(() => settings.viewMode, async (newMode, oldMode) => {
  // Snapshot the logical position from the OLD view while it's still mounted.
  const paneEl = document.querySelector(`[data-pane-id="${props.paneId}"]`);
  const savedLine = paneEl ? getCurrentTopLine(paneEl, oldMode) : null;
  // 100ms matches the existing settle window before bindScrollSync.
  await new Promise((r) => setTimeout(r, 100));
  if (savedLine != null) {
    const newPaneEl = document.querySelector(`[data-pane-id="${props.paneId}"]`);
    if (newPaneEl) restoreToLine(newPaneEl, newMode, savedLine);
  }
  bindScrollSync();
});

watch(() => settings.splitLiveSync, bindScrollSync);

watch(() => props.tab?.id, async () => {
  await new Promise((r) => setTimeout(r, 100));
  bindScrollSync();
});

// ---- Browser bounds sync ----
//
// The native child webview is not laid out by CSS — it is a separate OS
// surface positioned over the anchor element — so its rect has to be pushed
// to Rust whenever anything moves it. A rAF poll beats enumerating events:
// the triggers are window resize/maximise/fullscreen, either sidebar
// toggling, tile splitter drags, tab switches and panel collapse, and that
// list keeps growing as the UI evolves.
let boundsRaf = 0;
let boundsLastKey = '';
let boundsRo: ResizeObserver | null = null;
/**
 * The browser tab this pane believes is on screen, or null.
 *
 * Tracked explicitly so the tick can hide whatever it previously showed when
 * the pane stops displaying a browser tab — the component is re-propped
 * rather than remounted on a tab switch, so unmount hooks never run.
 */
let paneVisibleTabId: string | null = null;

function browserBoundsTick() {
  boundsRaf = requestAnimationFrame(browserBoundsTick);
  const el = browserAnchor.value;
  const tab = props.tab;

  // Desired visibility. Switching to a file tab makes isBrowser false and
  // removes the anchor from the DOM — but PaneHost renders PaneContent with
  // NO :key, so this component is not unmounted, only re-propped. Nothing
  // else would ever hide the webview and it would keep painting over the
  // newly-active tab. So visibility is decided here from scratch every frame
  // rather than being a side effect of measuring.
  // 浮层打开时必须让位。**这一条不能省** —— App.vue 的 watch 确实会在
  // 浮层打开时 hide 一次，但这个 tick 每帧都跑，下一帧就会把它重新 show
  // 出来，等于白 hide。菜单被 webview 压住的根因就在这，而不是菜单没接
  // 进计数器（那些都接了）。
  const wantsVisible =
    !!tab && isBrowser.value && isFocused.value && !!el && overlayDepth.value === 0;
  const rect = wantsVisible && el ? el.getBoundingClientRect() : null;
  const bounds = rect ? toLogicalBounds(rect) : null;
  const nextVisible = bounds && tab ? tab.id : null;

  if (paneVisibleTabId !== nextVisible) {
    if (paneVisibleTabId) void browserStore.hide(paneVisibleTabId);
    paneVisibleTabId = nextVisible;
    if (nextVisible && bounds && tab) {
      // Geometry BEFORE show: the webview is created at 0x0 and would
      // otherwise flash at a stale position on its first appearance.
      void browserStore.setBounds(tab.id, bounds.x, bounds.y, bounds.w, bounds.h).then(() => {
        void browserStore.show(tab.id);
      });
      boundsLastKey = `${bounds.x}|${bounds.y}|${bounds.w}|${bounds.h}`;
    }
    return;
  }

  if (!bounds || !tab) {
    boundsLastKey = '';
    return;
  }

  const key = `${bounds.x}|${bounds.y}|${bounds.w}|${bounds.h}`;
  if (key === boundsLastKey) return;
  boundsLastKey = key;
  void browserStore.setBounds(tab.id, bounds.x, bounds.y, bounds.w, bounds.h);
}

// Window-level resize / maximise / fullscreen. Clears the dedupe so the next
// tick re-pushes the rect.
function onBrowserWindowResize() {
  boundsLastKey = '';
}

// Move the webview at the tab switch itself, BEFORE the DOM swaps.
//
// The rAF tick alone is too late in both directions, because it runs after
// Vue has rendered the incoming tab and every webview call is an async IPC
// round trip on top of that:
//
//   leaving  → the native surface stays composited over the incoming editor
//              for several frames (the reported flash)
//   entering → the pane shows an empty anchor until the tick measures it and
//              setBounds + show land (the other half of the flash)
//
// Default flush ('pre') runs before this component re-renders, so both calls
// go out as early as they can.
watch(
  () => props.tab?.id,
  (id, prevId) => {
    if (!id || id === prevId) return;

    if (prevId && paneVisibleTabId === prevId) {
      paneVisibleTabId = null;
      boundsLastKey = '';
      void browserStore.hide(prevId);
      return;
    }

    // Entering a browser tab. Only pre-show when this webview has been
    // measured before (boundsLastKey non-empty): its geometry is then almost
    // always still right, and showing it a frame early beats showing an empty
    // pane. Without a prior measurement, wait for the tick — guessing here
    // would trade this flash for one at the wrong size.
    const tab = props.tab;
    if (tab && isBrowserTab(tab) && isFocused.value && boundsLastKey) {
      paneVisibleTabId = tab.id;
      void browserStore.show(tab.id);
    }
  },
);

// An overlay opening hides the webview; when it closes the anchor's rect has
// not changed, so the dedupe above would skip the re-show and the browser
// would stay invisible. The store bumps this counter to force a re-sync.
watch(() => browserStore.boundsVersion, () => {
  boundsLastKey = '';
});

// The single most common trigger: the pane itself resizing (splitter drag,
  // sidebar toggle, panel collapse).
watch(
  () => [isBrowser.value, browserAnchor.value] as const,
  ([isB, el]) => {
    boundsLastKey = '';
    boundsRo?.disconnect();
    if (isB && el) boundsRo?.observe(el);
  },
);

onMounted(() => {
  setTimeout(bindScrollSync, 300);
  boundsRo = new ResizeObserver(() => {
    boundsLastKey = '';
  });
  window.addEventListener('resize', onBrowserWindowResize);
  boundsRaf = requestAnimationFrame(browserBoundsTick);
  window.addEventListener('solomd:outline-goto', onOutlineGotoEvent);
  window.addEventListener('solomd:insert-markdown', onInsertMarkdownEvent);
  window.addEventListener('solomd:insert-image-path', onInsertImagePathEvent);
  window.addEventListener('solomd:insert-image-url', onInsertImageUrlEvent);
  window.addEventListener('solomd:upload-local-images', onUploadLocalImagesEvent);
  window.addEventListener('solomd:editor-find', onEditorFindEvent);
  window.addEventListener('solomd:preview-search', onPreviewSearchEvent);
  window.addEventListener('solomd:fold', onFoldEvent);
  window.addEventListener('solomd:edit-table', onEditTableEvent);
  window.addEventListener('solomd:edit-formula', onEditFormulaEvent);
});

onBeforeUnmount(() => {
  syncEditorScroll?.();
  syncPreviewScroll?.();
  cancelAnimationFrame(boundsRaf);
  boundsRo?.disconnect();
  window.removeEventListener('resize', onBrowserWindowResize);
  // The webview outlives this component (the store owns it and destroys it on
  // tab close), so hide it on unmount — otherwise it keeps painting over
  // whatever replaced this pane.
  if (paneVisibleTabId) {
    void browserStore.hide(paneVisibleTabId);
    paneVisibleTabId = null;
  }
  window.removeEventListener('solomd:outline-goto', onOutlineGotoEvent);
  window.removeEventListener('solomd:insert-markdown', onInsertMarkdownEvent);
  window.removeEventListener('solomd:insert-image-path', onInsertImagePathEvent);
  window.removeEventListener('solomd:insert-image-url', onInsertImageUrlEvent);
  window.removeEventListener('solomd:upload-local-images', onUploadLocalImagesEvent);
  window.removeEventListener('solomd:editor-find', onEditorFindEvent);
  window.removeEventListener('solomd:preview-search', onPreviewSearchEvent);
  window.removeEventListener('solomd:fold', onFoldEvent);
  window.removeEventListener('solomd:edit-table', onEditTableEvent);
  window.removeEventListener('solomd:edit-formula', onEditFormulaEvent);
});

defineExpose({ gotoLine, editorRef });

// #350 — preview mode has no editor cursor to follow, so hand the preview's
// reading position to the outline instead. Split mode keeps the cursor.
function onPreviewTopline(line: number) {
  if (settings.viewMode !== 'preview') return;
  window.dispatchEvent(new CustomEvent('solomd:preview-topline', {
    detail: { line, paneId: props.paneId },
  }));
}

function onOutlineGotoEvent(e: Event) {
  const { line, paneId } = (e as CustomEvent).detail;
  if (paneId !== props.paneId) return;
  gotoLine(line);
}

function onInsertMarkdownEvent(e: Event) {
  const { snippet, paneId } = (e as CustomEvent).detail;
  if (paneId !== props.paneId) return;
  const ed = editorRef.value as unknown as { insertMarkdown?: (s: string) => void } | null;
  ed?.insertMarkdown?.(snippet);
}

function onInsertImagePathEvent(e: Event) {
  const { path, paneId } = (e as CustomEvent).detail;
  if (paneId !== props.paneId) return;
  const ed = editorRef.value as unknown as { insertImageFromPath?: (p: string) => void } | null;
  ed?.insertImageFromPath?.(path);
}

function onInsertImageUrlEvent(e: Event) {
  const { url, alt, paneId } = (e as CustomEvent).detail;
  if (paneId !== props.paneId) return;
  const ed = editorRef.value as unknown as { insertImageUrl?: (u: string, a?: string) => void } | null;
  ed?.insertImageUrl?.(url, alt || '');
}

function onUploadLocalImagesEvent(e: Event) {
  const { paneId } = (e as CustomEvent).detail;
  if (paneId !== props.paneId) return;
  const ed = editorRef.value as unknown as { uploadLocalImages?: () => void } | null;
  ed?.uploadLocalImages?.();
}

function onEditorFindEvent(e: Event) {
  const { paneId } = (e as CustomEvent).detail || {};
  // No paneId → the focused pane handles it.
  if (paneId && paneId !== props.paneId) return;
  if (!paneId && !isFocused.value) return;
  const ed = editorRef.value as unknown as { openFind?: () => void } | null;
  ed?.openFind?.();
}

/** Formula editor — same focused-pane routing as find. */
function onEditFormulaEvent(e: Event) {
  const { paneId } = (e as CustomEvent).detail || {};
  if (paneId && paneId !== props.paneId) return;
  if (!paneId && !isFocused.value) return;
  const ed = editorRef.value as unknown as { openFormulaAtCursor?: () => void } | null;
  ed?.openFormulaAtCursor?.();
}

/** Grid table editor — same focused-pane routing as find. */
function onEditTableEvent(e: Event) {
  const { paneId } = (e as CustomEvent).detail || {};
  if (paneId && paneId !== props.paneId) return;
  if (!paneId && !isFocused.value) return;
  const ed = editorRef.value as unknown as { openTableAtCursor?: () => void } | null;
  ed?.openTableAtCursor?.();
}

/** Heading folding — same focused-pane routing as find (#fold). */
function onFoldEvent(e: Event) {
  const { paneId, action, level } = (e as CustomEvent).detail || {};
  if (paneId && paneId !== props.paneId) return;
  if (!paneId && !isFocused.value) return;
  const ed = editorRef.value as unknown as {
    applyFold?: (a: string, l?: number) => void;
  } | null;
  ed?.applyFold?.(action || 'toggle', level);
}

function onPreviewSearchEvent(e: Event) {
  const { paneId } = (e as CustomEvent).detail;
  if (paneId !== props.paneId) return;
  (previewRef.value as unknown as { openSearch?: () => void } | null)?.openSearch?.();
}
</script>

<template>
  <!-- #279 — "现在都一样看着有点累": side by side, the two panes are the same
       surface, so the split reads as one wide column. The opt-in class lifts
       the preview a shade; it only applies when BOTH panes are on screen,
       because there is nothing to tell apart otherwise. -->
  <div
    class="pane-content"
    :class="{
      'pane-content--distinct': settings.distinctSplitPanes && showEditor && showPreview,
    }"
  >
    <!-- Embedded browser tab. Must come FIRST: showEditor/showPreview are
         both true for a browser tab (it is 'plaintext' with no path), so
         without this branch it would fall into the editor arm and render an
         empty CodeMirror over the native webview. -->
    <div class="pane pane--browser" v-if="isBrowser && tab">
      <BrowserToolbar :tab="tab" />
      <!-- The native child webview is positioned over this element, which is
           why it must always be present and measurable — it is the anchor
           useBrowserBounds reads its rect from. Never v-if it away. -->
      <div ref="browserAnchor" class="pane__browser-anchor"></div>
    </div>
    <template v-else>
      <div class="pane pane--editor" v-if="showEditor && tab">
        <Editor
          :key="editorImplementationKey"
          ref="editorRef"
          :tab="tab"
          :focus-mode="settings.focusMode"
          :typewriter-mode="settings.typewriterMode"
          :spell-check="settings.spellCheck"
          @cursor="onCursor"
          @selection="onSelection"
        />
      </div>
      <div class="pane pane--preview" v-if="showPreview && tab">
        <Preview
          ref="previewRef"
          :source="previewSource"
          :file-path="tab.filePath"
          :tab-id="tab.id"
          @topline="onPreviewTopline"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.pane--browser {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}
.pane__browser-anchor {
  flex: 1 1 auto;
  min-height: 0;
  /* Matches the app surface, so the frame or two before the native webview
     appears is not a visible shade change. (There is no --bg-secondary token
     here; using one with a light fallback painted a white block in dark
     mode.) */
  background: var(--bg);
}
</style>

<style scoped>
.pane-content {
  flex: 1;
  display: flex;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
/* #168 phone layout for these panes lives in styles/main.css — a scoped
   block can't reach it: `:global(.x) .y` compiles down to `.x` here. */
.pane {
  flex: 1;
  min-width: 0;
  height: 100%;
}
.pane--editor + .pane--preview {
  border-left: 1px solid var(--border);
}
</style>
