# Agent 面板停靠（右侧栏 ↔ 编辑器下方）— 设计

日期：2026-10-23
状态：待实现
相关：[Agent Panel](../../../app/src/components/AgentPanel.vue)、[App 布局](../../../app/src/App.vue)

## 目标

Agent 面板不再只能待在右侧栏：

1. 默认停靠在**编辑器下方**（右侧栏保持全高，文件树也不受影响）。
2. 面板头部可拖动，在**右侧栏**和**编辑器下方**两个停靠位之间切换。
3. 底部停靠高度可拖动调节，停靠位置和高度持久化。

## 非目标

- 不做自由浮动窗口、不做任意位置放置。
- 不让其它右侧栏面板停靠底部；本期只处理 `agent`。
- 不动手机/窄屏布局：小屏继续用右侧抽屉。
- 不做多实例（同一时间只有一份 Agent 面板）。

## 总体架构

```
.workspace (row)
├── [outline side] aside (可选)
├── .content-col (column)          ← 新增
│   ├── .content                   ← 原有编辑器/视图
│   └── .agent-dock (可选)         ← 停靠底部时渲染 AgentPanel
└── aside.side-sidebar--right      ← 全高；停靠底部时不含 agent
```

- 停靠状态存在 settings，App.vue 决定 AgentPanel 渲染在哪一栏。
- 拖动/落点/高度调节都在 App.vue；AgentPanel 只负责发出 `dock-drag` 事件。

## 1. 设置

`app/src/stores/settings.ts` 新增：

```ts
/** 'bottom' = 编辑器下方（默认）；'right' = 右侧栏。 */
agentDock: 'right' | 'bottom';
/** 底部停靠高度（px）。 */
agentDockHeight: number;
```

默认值：`agentDock: 'bottom'`，`agentDockHeight: 320`。持久化走现有 `persist()`（序列化整个 `$state`），加载走现有 `{...defaults, ...saved}` 合并，无需迁移。

Actions：

```ts
setAgentDock(dock: 'right' | 'bottom') {
  this.agentDock = dock === 'right' ? 'right' : 'bottom';
  this.persist();
}
/** 存储层只做 160..2000 的粗夹取；窗口 70% 上限由拖拽与 CSS 负责。 */
setAgentDockHeight(px: number) {
  this.agentDockHeight = Math.max(160, Math.min(2000, Math.round(px)));
  this.persist();
}
```

`toggleAgentPanel()` 改成：面板打开且 `agentDock === 'right'` 时才调用 `ensureRightSidebarVisible()`；停靠底部时只翻转标志并持久化。

## 2. App.vue

### 2.1 派生状态

```ts
/** 非法存储值按 'bottom' 处理。 */
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

- `visibleRsPanes` 在 `agentInRightSidebar` 为 false 时排除 `agent`。
- `rightSidebarHasRenderablePane` 里的 `showAgentPane` 换成 `agentInRightSidebar`。
- `sideSidebarStyle` 的 440px 加宽条件加上 `agentInRightSidebar`。

### 2.2 模板

`.content` 外包一层：

```html
<div class="content-col">
  <div class="content">…原有内容…</div>
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
</div>
```

右侧栏里的 `AgentPanel` 加 `@dock-drag="startAgentDockDrag"`。

拖拽落点层（只在拖动时渲染）：

```html
<div v-if="dockDragging" class="agent-dock-zones">
  <div class="agent-dock-zone agent-dock-zone--right"
       :class="{ 'is-active': dockDropZone === 'right' }"
       data-agent-dock-zone="right">
    {{ t('agent.dockToRight') }}
  </div>
  <div class="agent-dock-zone agent-dock-zone--bottom"
       :class="{ 'is-active': dockDropZone === 'bottom' }"
       data-agent-dock-zone="bottom">
    {{ t('agent.dockToBottom') }}
  </div>
</div>
```

### 2.3 拖动逻辑

```ts
const dockDragging = ref(false);
const dockDropZone = ref<'right' | 'bottom' | null>(null);

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
```

落点区固定在窗口上：右侧 240px 宽、全高；底部 35% 高、全宽。仅在拖动时存在，且 `pointer-events: auto`（`elementFromPoint` 会跳过 `pointer-events: none` 的元素）。

### 2.4 高度调节

```ts
function onAgentDockResize(ev: PointerEvent) {
  ev.preventDefault();
  const startY = ev.clientY;
  const startH = settings.agentDockHeight;
  const onMove = (m: PointerEvent) => {
    // 向上拖 = 变高
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

### 2.5 布局与样式

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
.agent-dock__resize {
  position: absolute;
  top: -4px;
  left: 0;
  right: 0;
  height: 8px;
  cursor: ns-resize;
  z-index: 10;
}
.agent-dock__resize:hover { background: var(--accent); opacity: 0.35; }
.agent-dock-zones { position: fixed; inset: 0; z-index: 9998; }
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
.agent-dock-zone--right { top: 8px; right: 8px; bottom: 8px; width: 240px; }
.agent-dock-zone--bottom { left: 8px; right: 8px; bottom: 8px; height: 35%; }
.agent-dock-zone.is-active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}
```

`.content` 保持 `flex: 1` 不变，作为纵向容器里的第一项；高度由 `.content-col` 分配。窄屏原有规则 `.app--narrow .content { flex: 1 1 100% }` 现在作用于内层，需要补一条 `.app--narrow .content-col { flex: 1 1 100%; min-width: 0; }`。

停靠变化或高度变化后，沿用现有 `solomd:relayout` 通知编辑器重新测量：

```ts
watch([agentBottomVisible, () => settings.agentDockHeight], () => {
  nextTick(() => requestAnimationFrame(() =>
    window.dispatchEvent(new CustomEvent('solomd:relayout'))));
});
```

## 3. AgentPanel.vue

新增事件：

```ts
const emit = defineEmits<{
  (e: 'open-settings', section?: string): void;
  (e: 'close'): void;
  (e: 'dock-drag', event: PointerEvent): void;
}>();
```

头部接管拖动：

```ts
function onHeaderPointerDown(e: PointerEvent) {
  // 头部按钮有自己的点击行为，不当作拖动。
  if ((e.target as HTMLElement | null)?.closest('button, input, textarea, a')) return;
  emit('dock-drag', e);
}
```

```html
<header class="rp-head agent-panel__head" @pointerdown="onHeaderPointerDown">
```

头部加提示（`title` 用 `t('agent.dragDock')`）与 `cursor: grab`；拖动进行中由 App.vue 的全局样式接管。`.agent-panel__source`、`.agent-panel__folder` 等仍可点击。

## 4. i18n

`agent` 对象新增（受 `I18n = typeof en` 约束，15 种语言都要加）：

- `dockToRight`：`Dock right` / `停靠到右侧`
- `dockToBottom`：`Dock bottom` / `停靠到底部`
- `dragDock`：`Drag to move this panel` / `拖动可移动面板`

## 5. 边界情况

| 情况 | 行为 |
|---|---|
| 停靠底部且右侧栏没有其它面板 | 右侧栏不渲染（`showRightSidebar` 为 false） |
| 停靠底部时右键目录 → Agent | 面板已在底部，只清空会话并打开 |
| 拖动中松开在落点外 | 保持原停靠，不报错 |
| 窄屏 / 手机 | 忽略底部停靠，面板仍在右侧抽屉 |
| 存储里是非法 `agentDock` | 按 `'bottom'` 处理（渲染与 toggle 都用 `=== 'right'` 判断） |
| 高度存储值过大/过小 | `setAgentDockHeight` 夹取 160..2000，CSS 再限制 `max-height: 70vh` |
| 拖拽时面板正在流式输出 | 只是移动 DOM 位置，组件不卸载（两个停靠位互斥渲染，切换会重建组件） |

**已知取舍**：切换停靠会卸载并重建 `AgentPanel`。会话状态在 Pinia store 里，消息和 `cliSessionId` 不丢；正在流式的请求在后台继续，新挂载的监听器按 `request_id` 继续收事件，但卸载/挂载之间的极短空档可能丢掉少量流式片段。停靠切换不中断会话。

## 6. 测试

- `app/src/stores/settings-dock.test.ts`：
  - 默认 `agentDock === 'bottom'`、`agentDockHeight === 320`。
  - `setAgentDock('right')` 后值正确且写入 localStorage。
  - `setAgentDockHeight(50)` → 160；`setAgentDockHeight(99999)` → 2000。
- 手动验收：
  1. 启动 → Agent 面板在编辑器下方，右侧栏全高。
  2. 按住面板头部拖到右侧 → 停靠右侧；拖回底部 → 恢复。
  3. 拖底部上边缘调高度；重启应用后位置与高度保持。
  4. 停靠底部时右侧栏没有重复的 Agent 面板；若右侧栏没有其它面板则不显示。
  5. 手机宽度下面板仍在右侧抽屉。
