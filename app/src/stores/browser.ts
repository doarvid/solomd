/**
 * 内嵌浏览器的前端状态，**以及原生子 webview 的生命周期**。
 *
 * 这个 store 是 tabs 列表的唯一观察者：所有 webview 的创建/销毁都从这里的
 * diff 触发。别处不要直接调 browser_create / browser_destroy —— tab 列表
 * 有太多条改动路径，逐处手写必然漏掉某一条（会话恢复就是最容易漏的，
 * 它不经过任何 action，只是从 localStorage 反序列化出 state）。
 *
 * 采集数据不走这里 —— 它经哨兵 URL 由 Rust 的 on_navigation 截获后
 * 以事件形式推过来，本 store 只负责接收和暂存。
 */
import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { useTabsStore } from './tabs';
import { diffBrowserTabs, type TabLike } from '../lib/browser-lifecycle.ts';

export interface CaptureLink {
  href: string;
  text: string;
}

export interface CapturePayload {
  url: string;
  title: string;
  text: string;
  links: CaptureLink[];
}

interface BrowserState {
  /** 每个 tab 的加载态/标题，供 tab 栏显示。key 是裸 tabId。 */
  meta: Record<string, { title?: string; url?: string }>;
  /** 待用户审阅的采集结果。key 是裸 tabId。null = 已被消费。 */
  pending: Record<string, CapturePayload | null>;
  /** 「选中片段」模式的结果。key 是裸 tabId。 */
  selection: Record<string, string>;
  /** `browser_platform_supported` 的结果。null = 还没问出来。 */
  platformSupported: boolean | null;
  /**
   * 每次浮层开合 +1。useBrowserBounds 靠它知道"矩形没变但需要重新同步"
   * —— 浮层期间子 webview 被 hide，关掉后 show 回来时 lastKey 还是旧值，
   * 不去重就会既不显示也不重设尺寸。
   */
  boundsVersion: number;
}

let unlisten: UnlistenFn[] = [];
let stopWatch: (() => void) | null = null;
/**
 * 上一帧的 tab 形状。
 *
 * **必须放模块级，不能放 store 的 options 里**：Pinia 的 createOptionsStore
 * 只认 { state, actions, getters }，多出来的键既不是响应式 state，也会在
 * vue-tsc 下报 excess property。
 */
let prevSeen: TabLike[] = [];

/** Rust 发来的 tabId 已经是裸 id，但历史事件可能带 label 前缀，统一剥掉。 */
function stripLabel(tabId: string): string {
  return tabId.replace(/^browser-/, '');
}

export const useBrowserStore = defineStore('browser', {
  state: (): BrowserState => ({
    meta: {},
    pending: {},
    selection: {},
    platformSupported: null,
    boundsVersion: 0,
  }),

  actions: {
    /** 从 App.vue 的 setup 调一次。幂等。 */
    async start() {
      if (stopWatch) return;
      const tabs = useTabsStore();

      // Pinia 3 的 $subscribe 返回的是 removeSubscription 函数本身，
      // 不是 { __stop } 包装对象。
      stopWatch = tabs.$subscribe((_mutation, state) => {
        void this.syncWebviews(state.tabs);
      });

      unlisten.push(
        await listen<{ tabId: string; payload: CapturePayload }>('browser://capture', (e) => {
          const tabId = stripLabel(e.payload.tabId);
          this.pending = { ...this.pending, [tabId]: e.payload.payload };
        }),
        await listen<{ tabId: string; payload: CapturePayload }>('browser://selection', (e) => {
          const tabId = stripLabel(e.payload.tabId);
          this.selection = { ...this.selection, [tabId]: e.payload.payload.text };
        }),
      );

      // 关键：$subscribe 只对**之后的**变更触发，不会为当前已有的 state
      // 补发。会话恢复出来的浏览器 tab 在 start() 之前就已在 tabs 里，
      // 不显式跑一次初始同步，它们永远拿不到 webview —— 用户看到的是一块
      // 空白锚点，而且没有任何报错。
      await this.syncWebviews(tabs.tabs);
    },

    stop() {
      if (stopWatch) stopWatch();
      stopWatch = null;
      for (const fn of unlisten) fn();
      unlisten = [];
      prevSeen = [];
    },

    /** 由 tabs 的 $subscribe 驱动，不要手动调（除非做初始同步）。 */
    async syncWebviews(nextTabs: readonly TabLike[]) {
      const { create, destroy } = diffBrowserTabs(prevSeen, nextTabs);
      // 先记快照再发命令：命令是异步的，中途若又触发一次 subscribe，
      // 用未更新的快照会重复创建同一批。
      prevSeen = nextTabs.map((t) => ({ id: t.id, kind: t.kind }));

      for (const id of destroy) {
        await invoke('browser_destroy', { tabId: id }).catch(() => {});
        const { [id]: _p, ...restPending } = this.pending;
        const { [id]: _s, ...restSelection } = this.selection;
        this.pending = restPending;
        this.selection = restSelection;
      }

      const tabs = useTabsStore();
      for (const id of create) {
        const tab = tabs.tabs.find((t) => t.id === id);
        if (!tab?.url) continue;
        // 尺寸先给 0，useBrowserBounds 挂载后会立刻纠正。
        await invoke('browser_create', {
          tabId: id,
          url: tab.url,
          x: 0,
          y: 0,
          w: 0,
          h: 0,
        }).catch(() => {});
      }
    },

    /** 一次性问出本机是否支持（Wayland / 移动端为 false）。 */
    async loadPlatformSupport() {
      if (this.platformSupported !== null) return;
      this.platformSupported = await invoke<boolean>('browser_platform_supported').catch(
        () => false,
      );
    },

    /** 由 useBrowserBounds 调用。 */
    async setBounds(tabId: string, x: number, y: number, w: number, h: number) {
      await invoke('browser_set_bounds', { tabId, x, y, w, h }).catch(() => {});
    },

    async show(tabId: string) {
      await invoke('browser_show', { tabId }).catch(() => {});
    },

    async hide(tabId: string) {
      await invoke('browser_hide', { tabId }).catch(() => {});
    },

    async navigate(tabId: string, url: string) {
      await invoke('browser_navigate', { tabId, url });
    },

    async requestCapture(tabId: string) {
      await invoke('browser_request_capture', { tabId });
    },

    async requestSelection(tabId: string) {
      await invoke('browser_request_selection', { tabId });
    },

    /** 浮层开合后调一次，让 bounds 同步重新计算。 */
    bumpBoundsVersion() {
      this.boundsVersion += 1;
    },

    clearPending(tabId: string) {
      this.pending = { ...this.pending, [tabId]: null };
    },
  },
});
