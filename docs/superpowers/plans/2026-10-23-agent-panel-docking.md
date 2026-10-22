# Agent 面板停靠 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent 面板默认停靠在编辑器下方，可在右侧栏与底部之间拖动切换，底部高度可调，选择持久化。

**Architecture:** 停靠状态存在 settings；`App.vue` 在编辑器列外包一层纵向容器，按状态把 `AgentPanel` 渲染在底部或右侧栏；`AgentPanel` 头部发出 `dock-drag` 事件，`App.vue` 负责落点覆盖层和高度拖拽。

**Tech Stack:** Vue 3 + Pinia + TypeScript，纯 CSS 布局。

**Spec:** `docs/superpowers/specs/2026-10-23-agent-panel-docking-design.md`

## Global Constraints

- 默认 `agentDock: 'bottom'`、`agentDockHeight: 320`。
- 高度存储夹取 `160..2000`；拖拽时再限制到窗口 `70%`，CSS `max-height: 70vh`。
- 窄屏（`isNarrow`）不启用底部停靠，面板仍在右侧抽屉。
- 停靠底部时右侧栏不得再渲染 Agent；右侧栏没有其它面板时自动隐藏。
- 只有 `agent` 一个面板参与本次停靠；其它面板行为不变。
- 新 i18n key 必须加到全部 15 个 locale（`I18n = typeof en`）。

## Review Focus

- **存储里是非法 `agentDock`**：必须按底部处理，不能出现空白右侧栏或面板消失。
- **窄屏/手机**：底部停靠必须被忽略，面板不能占掉编辑器高度。
- **右侧栏重复渲染**：停靠底部时 `agent` 不能同时出现在两处。
- **从头部按钮起手拖动**：点击发送、关闭、来源切换不能触发停靠拖动。
- **流式中切换停靠**：组件会重挂载，消息和 CLI 会话不能丢（状态在 Pinia）。
- **拖到落点之外松手**：保持原停靠，不报错。

---

### Task 1: 设置字段与归一化

**Files:**
- Modify: `app/src/stores/settings.ts`
- Test: `app/src/stores/settings-dock.test.ts`

**Interfaces:**
- Produces: `agentDock: 'right' | 'bottom'`、`agentDockHeight: number`
- Produces: `setAgentDock(dock)`、`setAgentDockHeight(px)`

- [ ] **Step 1: 写失败测试**

创建 `app/src/stores/settings-dock.test.ts`：

```ts
/**
 * Agent panel docking — defaults, persistence and load-time normalization.
 * Runs the real store with a fake window / localStorage, same harness as
 * settings-theme.test.ts.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const saved = new Map<string, string>();
const g = globalThis as Record<string, unknown>;
g.localStorage = {
  getItem: (k: string) => saved.get(k) ?? null,
  setItem: (k: string, v: string) => void saved.set(k, v),
  removeItem: (k: string) => void saved.delete(k),
};
g.window = {
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  localStorage: g.localStorage,
};
if (!g.navigator) g.navigator = { userAgent: 'node', language: 'en-US', platform: 'MacIntel' };

const { createPinia, setActivePinia } = await import('pinia');
const { useSettingsStore } = await import('./settings');

const LS_KEY = 'solomd.settings.v1';

beforeEach(() => {
  saved.clear();
});

function fresh() {
  setActivePinia(createPinia());
  return useSettingsStore();
}

test('a new install docks the agent at the bottom', () => {
  const s = fresh();
  assert.equal(s.agentDock, 'bottom');
  assert.equal(s.agentDockHeight, 320);
});

test('setAgentDock persists the choice', () => {
  const s = fresh();
  s.setAgentDock('right');
  assert.equal(s.agentDock, 'right');
  const blob = JSON.parse(saved.get(LS_KEY)!);
  assert.equal(blob.agentDock, 'right');
});

test('setAgentDockHeight clamps and rounds', () => {
  const s = fresh();
  s.setAgentDockHeight(50);
  assert.equal(s.agentDockHeight, 160);
  s.setAgentDockHeight(99999);
  assert.equal(s.agentDockHeight, 2000);
  s.setAgentDockHeight(420.6);
  assert.equal(s.agentDockHeight, 421);
});

test('an invalid stored dock and height are normalized on load', () => {
  saved.set(
    LS_KEY,
    JSON.stringify({ agentDock: 'left', agentDockHeight: 99999 }),
  );
  assert.equal(fresh().agentDock, 'bottom');
  assert.equal(fresh().agentDockHeight, 2000);
});

test('a non-numeric stored height falls back to 320', () => {
  saved.set(LS_KEY, JSON.stringify({ agentDockHeight: 'oops' }));
  assert.equal(fresh().agentDockHeight, 320);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd app && node --test --experimental-strip-types --import ./scripts/test-register.mjs src/stores/settings-dock.test.ts`

Expected: FAIL —— `agentDock` 为 `undefined`，`setAgentDock is not a function`。

- [ ] **Step 3: 加字段、默认值与归一化**

在 `app/src/stores/settings.ts` 的 `showAgentPanel: boolean;` 之后加：

```ts
  /** Agent 面板停靠位：'bottom' = 编辑器下方（默认），'right' = 右侧栏。 */
  agentDock: 'right' | 'bottom';
  /** 底部停靠高度（px）。 */
  agentDockHeight: number;
```

在默认值对象的 `showAgentPanel: true,` 之后加：

```ts
    agentDock: 'bottom',
    agentDockHeight: 320,
```

在 `load()` 里 `const merged: Settings = { ...defaults(), ...parsed };` 之后加：

```ts
      // 停靠值来自旧版本或被篡改的 blob：未知停靠位一律按底部，
      // 高度夹到渲染器能用的范围。
      if (merged.agentDock !== 'right') merged.agentDock = 'bottom';
      const dockH = Number(merged.agentDockHeight);
      merged.agentDockHeight = Number.isFinite(dockH)
        ? Math.max(160, Math.min(2000, Math.round(dockH)))
        : 320;
```

在 `toggleAgentPanel()` 里，把 `ensureRightSidebarVisible()` 改为只在停靠右侧时调用：

```ts
    toggleAgentPanel() {
      this.showAgentPanel = !this.showAgentPanel;
      // 停靠底部时不需要把右侧栏拉出来。
      if (this.showAgentPanel && this.agentDock === 'right') {
        this.ensureRightSidebarVisible();
      }
      this.persist();
    },
```

在 `toggleAgentPanel()` 之后加：

```ts
    setAgentDock(dock: 'right' | 'bottom') {
      this.agentDock = dock === 'right' ? 'right' : 'bottom';
      this.persist();
    },
    /** 存储层粗夹取；窗口 70% 上限由拖拽与 CSS 负责。 */
    setAgentDockHeight(px: number) {
      this.agentDockHeight = Math.max(160, Math.min(2000, Math.round(px)));
      this.persist();
    },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd app && node --test --experimental-strip-types --import ./scripts/test-register.mjs src/stores/settings-dock.test.ts`

Expected: 5 passed。

- [ ] **Step 5: 提交**

```bash
git add app/src/stores/settings.ts app/src/stores/settings-dock.test.ts
git commit -m "feat(agent): persist agent panel dock and height"
```

---

### Task 2: AgentPanel 发出 dock-drag + i18n

**Files:**
- Modify: `app/src/components/AgentPanel.vue`
- Modify: `app/src/i18n/*.ts`（15 个 locale）

**Interfaces:**
- Produces: 事件 `(e: 'dock-drag', event: PointerEvent)`

- [ ] **Step 1: 声明事件与头部处理**

在 `AgentPanel.vue` 的 `defineEmits` 里加：

```ts
  (e: 'dock-drag', event: PointerEvent): void;
```

在 `onKeydown` 之前加：

```ts
/** 头部是停靠拖动抓手；里面的按钮有自己的点击行为，不参与拖动。 */
function onHeaderPointerDown(e: PointerEvent) {
  const target = e.target as HTMLElement | null;
  if (target?.closest('button, input, textarea, a, select')) return;
  emit('dock-drag', e);
}
```

把头部标签改成：

```html
    <header
      class="rp-head agent-panel__head agent-panel__head--draggable"
      :title="t('agent.dragDock')"
      @pointerdown="onHeaderPointerDown"
    >
```

在 `<style scoped>` 的 `.agent-panel__title` 之前加：

```css
.agent-panel__head--draggable {
  cursor: grab;
}
.agent-panel__head--draggable:active {
  cursor: grabbing;
}
.agent-panel__head--draggable button {
  cursor: pointer;
}
```

- [ ] **Step 2: i18n**

在 `app/src/i18n/en.ts` 的 `agent` 对象里（`cliFolder` 之后）加：

```ts
    dockToRight: 'Dock right',
    dockToBottom: 'Dock bottom',
    dragDock: 'Drag to move this panel',
```

在 `app/src/i18n/zh.ts` 的同一位置加：

```ts
    dockToRight: '停靠到右侧',
    dockToBottom: '停靠到底部',
    dragDock: '拖动可移动面板',
```

其余 13 个 locale（de/es/fr/it/ja/ko/nl/pl/pt/ru/sv/tr/uk）在各自的 `agent` 对象里、`cliFolder` 之后加同样的英文值：

```ts
    dockToRight: 'Dock right',
    dockToBottom: 'Dock bottom',
    dragDock: 'Drag to move this panel',
```

- [ ] **Step 3: 类型检查**

Run: `cd app && pnpm exec vue-tsc --noEmit && echo ok`

Expected: `ok`。

- [ ] **Step 4: 提交**

```bash
git add app/src/components/AgentPanel.vue app/src/i18n
git commit -m "feat(agent): make the panel header a dock drag handle"
```

---

### Task 3: 底部停靠渲染与面板排除

**Files:**
- Modify: `app/src/App.vue`

**Interfaces:**
- Consumes: `settings.agentDock`、`settings.agentDockHeight`（Task 1）

- [ ] **Step 1: 加派生状态**

在 `const { isNarrow } = useViewport();` 之后加：

```ts
/** 非法存储值按底部处理（load() 也会归一化，这里是双保险）。 */
const agentDock = computed<'right' | 'bottom'>(() =>
  settings.agentDock === 'right' ? 'right' : 'bottom',
);
/** 面板是否真的渲染在底部：小屏一律不启用。 */
const agentBottomVisible = computed(
  () => showAgentPane.value && agentDock.value === 'bottom' && !isNarrow.value,
);
/** 面板是否参与右侧栏的面板栈。 */
const agentInRightSidebar = computed(
  () => showAgentPane.value && !agentBottomVisible.value,
);
```

- [ ] **Step 2: 右侧栏排除 Agent**

把 `rightSidebarHasRenderablePane` 里的：

```ts
    showAgentPane.value ||
```

改成：

```ts
    agentInRightSidebar.value ||
```

把 `visibleRsPanes` 的 `.filter((id) => all[id as keyof typeof all])` 改成：

```ts
    .filter(
      (id) =>
        all[id as keyof typeof all] &&
        (id !== 'agent' || agentInRightSidebar.value),
    )
```

把 `sideSidebarStyle` 的条件：

```ts
    showAgentPane.value && settings.sideSidebarWidth <= 260
```

改成：

```ts
    agentInRightSidebar.value && settings.sideSidebarWidth <= 260
```

- [ ] **Step 3: 模板包一层纵向容器**

把：

```html
        <div class="content">
          <BasesView v-if="basesOpen" />
          <InboxView v-else-if="inboxViewOpen" />
          <TypeLensView v-else-if="typeLensOpen" :type-name="typeLensName" />
          <ViewNoteList v-else-if="viewPaneVisible" />
          <TileRoot v-else :node="tiles.root" @cursor="onCursor" @selection="onSelection" />
          <StatsPill v-if="!basesOpen && !inboxViewOpen && !typeLensOpen && !viewPaneVisible" :line="cursorLine" :col="cursorCol" :selection-text="selectionText" />
        </div>
```

换成：

```html
        <div class="content-col">
          <div class="content">
            <BasesView v-if="basesOpen" />
            <InboxView v-else-if="inboxViewOpen" />
            <TypeLensView v-else-if="typeLensOpen" :type-name="typeLensName" />
            <ViewNoteList v-else-if="viewPaneVisible" />
            <TileRoot v-else :node="tiles.root" @cursor="onCursor" @selection="onSelection" />
            <StatsPill v-if="!basesOpen && !inboxViewOpen && !typeLensOpen && !viewPaneVisible" :line="cursorLine" :col="cursorCol" :selection-text="selectionText" />
          </div>
          <div
            v-if="agentBottomVisible"
            class="agent-dock"
            :style="{ height: settings.agentDockHeight + 'px' }"
          >
            <AgentPanel
              @open-settings="(section?: string) => openSettingsAt(section ?? 'integrations')"
              @close="settings.toggleAgentPanel()"
            />
          </div>
        </div>
```

- [ ] **Step 4: 样式**

在 `App.vue` 的 `.content { ... }` 规则之后加：

```css
.content-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.agent-dock {
  position: relative;
  flex: 0 0 auto;
  min-height: 160px;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  border-top: var(--bd-hair);
  background: var(--bg);
}
.agent-dock > .agent-panel {
  flex: 1;
  min-height: 0;
}
/* 窄屏：内层 .content 仍是 flex 项，外层容器占满宽度。 */
.app--narrow .content-col {
  flex: 1 1 100%;
  min-width: 0;
}
```

- [ ] **Step 5: 类型检查**

Run: `cd app && pnpm exec vue-tsc --noEmit && echo ok`

Expected: `ok`。此时面板应默认出现在编辑器下方；手动 `pnpm tauri dev` 可先看一眼布局。

- [ ] **Step 6: 提交**

```bash
git add app/src/App.vue
git commit -m "feat(agent): render the agent panel under the editor by default"
```

---

### Task 4: 拖动停靠、高度调节与重排通知

**Files:**
- Modify: `app/src/App.vue`

**Interfaces:**
- Consumes: `(e: 'dock-drag', event: PointerEvent)`（Task 2）、`settings.setAgentDock` / `setAgentDockHeight`（Task 1）

- [ ] **Step 1: 加拖动与高度逻辑**

在 `startPaneReorder` 之后加：

```ts
// --- Agent panel docking -------------------------------------------------
const dockDragging = ref(false);
const dockDropZone = ref<'right' | 'bottom' | null>(null);

/** 头部拖动：显示两个落点区，松手时切换停靠。 */
function startAgentDockDrag(ev: PointerEvent) {
  if (ev.button !== 0 && ev.pointerType === 'mouse') return;
  ev.preventDefault();
  dockDragging.value = true;
  dockDropZone.value = null;
  const zoneAt = (x: number, y: number) =>
    (document.elementFromPoint(x, y) as HTMLElement | null)
      ?.closest('[data-agent-dock-zone]')
      ?.getAttribute('data-agent-dock-zone');
  const onMove = (m: PointerEvent) => {
    const z = zoneAt(m.clientX, m.clientY);
    dockDropZone.value = z === 'right' || z === 'bottom' ? z : null;
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.body.style.userSelect = '';
    const target = dockDropZone.value;
    dockDragging.value = false;
    dockDropZone.value = null;
    if (target) settings.setAgentDock(target);
  };
  document.body.style.userSelect = 'none';
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

/** 底部停靠的上边缘：向上拖变高。 */
function onAgentDockResize(ev: PointerEvent) {
  ev.preventDefault();
  const startY = ev.clientY;
  const startH = settings.agentDockHeight;
  const onMove = (m: PointerEvent) => {
    const next = startH - (m.clientY - startY);
    const cap = Math.round(window.innerHeight * 0.7);
    settings.setAgentDockHeight(Math.min(next, cap));
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
  document.body.style.cursor = 'ns-resize';
  document.body.style.userSelect = 'none';
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}
```

在现有 `watch(visibleRsPanes, ...)` 之后加：

```ts
// 停靠位置或高度变化会改变编辑器可用高度，让 CodeMirror 重新测量。
watch([agentBottomVisible, () => settings.agentDockHeight], () => {
  nextTick(() => {
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('solomd:relayout'));
    });
  });
});
```

- [ ] **Step 2: 落点覆盖层**

在 `<div class="workspace">` 之后加：

```html
        <div v-if="dockDragging" class="agent-dock-zones">
          <div
            class="agent-dock-zone agent-dock-zone--right"
            :class="{ 'is-active': dockDropZone === 'right' }"
            data-agent-dock-zone="right"
          >
            {{ t('agent.dockToRight') }}
          </div>
          <div
            class="agent-dock-zone agent-dock-zone--bottom"
            :class="{ 'is-active': dockDropZone === 'bottom' }"
            data-agent-dock-zone="bottom"
          >
            {{ t('agent.dockToBottom') }}
          </div>
        </div>
```

- [ ] **Step 3: 绑定拖动与高度手柄**

给底部停靠的 `AgentPanel` 加 `@dock-drag="startAgentDockDrag"`，并在它前面加高度手柄：

```html
          <div
            v-if="agentBottomVisible"
            class="agent-dock"
            :style="{ height: settings.agentDockHeight + 'px' }"
          >
            <div class="agent-dock__resize" @pointerdown="onAgentDockResize" />
            <AgentPanel
              @dock-drag="startAgentDockDrag"
              @open-settings="(section?: string) => openSettingsAt(section ?? 'integrations')"
              @close="settings.toggleAgentPanel()"
            />
          </div>
```

`App.vue` 里现有的 `AgentPanel` 渲染点有**两处**（`outlineSide === 'left'` 时的左侧栏、以及右侧栏），两处标记完全相同，都要加 `@dock-drag`：

```html
              <AgentPanel
                v-if="p.id === 'agent'"
                @dock-drag="startAgentDockDrag"
                @open-settings="(section?: string) => openSettingsAt(section ?? 'integrations')"
                @close="ctxToggle(() => settings.toggleAgentPanel())"
              />
```

用 `replace_all` 或在两处分别应用；改完后 `grep -c '@dock-drag' app/src/App.vue` 应为 3（两处侧栏 + 一处底部）。

- [ ] **Step 4: 落点与手柄样式**

在 `.agent-dock > .agent-panel` 规则之后加：

```css
.agent-dock__resize {
  position: absolute;
  top: -4px;
  left: 0;
  right: 0;
  height: 8px;
  cursor: ns-resize;
  z-index: 10;
}
.agent-dock__resize:hover {
  background: var(--accent);
  opacity: 0.35;
}
.agent-dock-zones {
  position: fixed;
  inset: 0;
  z-index: 9998;
}
.agent-dock-zone {
  position: absolute;
  display: grid;
  place-items: center;
  border: 2px dashed var(--border);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--text-2);
  font-size: 12px;
  border-radius: 8px;
}
.agent-dock-zone--right {
  top: 8px;
  right: 8px;
  bottom: 8px;
  width: 240px;
}
.agent-dock-zone--bottom {
  left: 8px;
  right: 8px;
  bottom: 8px;
  height: 35%;
}
.agent-dock-zone.is-active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}
```

- [ ] **Step 5: 类型检查与测试**

Run: `cd app && pnpm exec vue-tsc --noEmit && pnpm test`

Expected: 类型检查通过；现有测试全绿（含 Task 1 新增 5 项）。

- [ ] **Step 6: 提交**

```bash
git add app/src/App.vue
git commit -m "feat(agent): drag the agent panel between right and bottom docks"
```

---

### Task 5: 整体验证

**Files:** 无

- [ ] **Step 1: 前端**

Run: `cd app && pnpm test && pnpm exec vue-tsc --noEmit && echo ok && pnpm build >/dev/null && echo build-ok`

Expected: 测试全绿、`ok`、`build-ok`。

- [ ] **Step 2: 手动验收**

`pnpm tauri dev`：

1. 启动后面板在编辑器下方，右侧栏全高且没有重复的 Agent。
2. 按住面板头部拖到右侧落点 → 停靠右侧；再拖到底部落点 → 回到底部。
3. 点击头部按钮（发送/清空/来源切换/关闭）不会触发拖动。
4. 拖底部上边缘调高度，最大不超过窗口 70%。
5. 重启应用，位置和高度保持。
6. 缩到手机宽度：面板回到右侧抽屉，不占编辑器高度。

- [ ] **Step 3: 提交（如有零散改动）**

```bash
git status --short
# 有改动才执行
git add -A && git commit -m "chore(agent): verify panel docking"
```
