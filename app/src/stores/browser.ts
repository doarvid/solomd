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
import { useToastsStore } from './toasts';
import { useSettingsStore } from './settings';
import { useI18n } from '../i18n';
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
  /** 结构化提取的完整 markdown（含引用编号 + References）。走 DeepSeek
   *  接口时才有；DOM 兜底时为空，此时用 `text`。 */
  markdown?: string;
  model?: string;
  /** 提取过程中的降级说明。有值不代表失败，但要让用户看见。 */
  error?: string;
}

/** 一个引用链接在采集流程里的状态。 */
export type LinkStatus = 'idle' | 'running' | 'done' | 'failed';

export interface FetchOutcome {
  url: string;
  title: string;
  path: string | null;
  via: string;
  error: string | null;
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
  /**
   * 当前目标目录里**已采集**的归一化 URL 集合。
   *
   * 用数组而不是 Set：Pinia 的 state 要可序列化，Set 在 devtools 里也难读。
   * 规模是几十到几百条，includes 的开销可以忽略。
   */
  capturedUrls: string[];
  /** 每个链接的采集状态，key 是归一化 URL。 */
  linkStatus: Record<string, LinkStatus>;
  /** 保存对话的进行状态：null 表示没在保存。 */
  saving: boolean;
  /**
   * 正在等待采集结果。
   *
   * 采集是**异步**的：`browser_request_capture` 只是在页面里 eval 一下，
   * 立刻返回；真正的数据随后经 `browser://capture` 事件到达。所以按钮
   * 不能靠 invoke 的返回判断完成 —— 早期版本这么做，结果按钮毫无反应，
   * 用户以为没点上。
   */
  capturing: boolean;
  /** 上一次操作的提示，供面板显示。 */
  notice: string;
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

/**
 * 采集看门狗。
 *
 * 采集靠事件回传，事件可能永远不来（页面里没注入成功、页面被导航走了、
 * 接口超时后 DOM 兜底也失败）。没有这个的话按钮会一直转，而用户不知道
 * 是还在跑还是卡住了。
 */
let captureTimer: ReturnType<typeof setTimeout> | null = null;
const CAPTURE_TIMEOUT_MS = 60_000;

/**
 * 重设采集看门狗。
 *
 * 开始采集时调一次，之后**每收到一片都再调一次**。这样超时只会在"整整
 * 一分钟一片都没来"时触发 —— 真正的卡死。
 *
 * 固定超时会误报：长对话有几十片、每片之间还要让出 25ms，几十秒是正常
 * 的，而"采集超时 —— 页面可能没加载完"这样的提示会把用户引向完全错误的
 * 方向（他们刚看到页面明明好好的）。
 */
function resetCaptureWatchdog(store: { finishCapture: (t: string, p: null, f?: string) => void }) {
  if (captureTimer) clearTimeout(captureTimer);
  captureTimer = setTimeout(() => {
    captureTimer = null;
    store.finishCapture('', null, tr('browser.captureTimeout'));
  }, CAPTURE_TIMEOUT_MS);
}

/**
 * t() 的惰性取用。
 *
 * 不能在模块顶层调 `useI18n()` —— 它会建 computed 并在调用时读 settings
 * store，而 store 模块在 pinia 激活之前就被求值了。放在函数体里、每次
 * 现取，代价只是每处调用建一个 computed，相对于一次用户操作可以忽略。
 */
function tr(key: string, params?: Record<string, string | number>): string {
  return useI18n().t(key, params);
}

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
    capturedUrls: [],
    linkStatus: {},
    saving: false,
    capturing: false,
    notice: '',
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
        await listen<{ tabId: string; received: number; total: number }>(
          'browser://capture-progress',
          (e) => {
            // 每一片都重置看门狗 —— 超时只应该意味着"真的没动静了"。
            if (!this.capturing) return;
            resetCaptureWatchdog(this);
            this.notice = tr('browser.capturingProgress', {
              got: String(e.payload.received),
              total: String(e.payload.total),
            });
          },
        ),
        await listen<{ tabId: string; payload: CapturePayload }>('browser://capture', (e) => {
          const tabId = stripLabel(e.payload.tabId);
          this.finishCapture(tabId, e.payload.payload);
        }),
        await listen<{ tabId: string; payload: CapturePayload }>('browser://selection', (e) => {
          const tabId = stripLabel(e.payload.tabId);
          this.selection = { ...this.selection, [tabId]: e.payload.payload.text };
          useToastsStore().success(tr('browser.selectionDone', { n: String(e.payload.payload.text.length) }));
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
      if (this.capturing) return;
      this.capturing = true;
      this.notice = tr('browser.capturing');

      resetCaptureWatchdog(this);

      try {
        await invoke('browser_request_capture', { tabId });
      } catch (e) {
        this.finishCapture(tabId, null, String(e));
      }
    },

    /** 采集回传到达（或失败）时收尾：停表、报结果。 */
    finishCapture(tabId: string, payload: CapturePayload | null, failure?: string) {
      if (captureTimer) {
        clearTimeout(captureTimer);
        captureTimer = null;
      }
      this.capturing = false;

      if (failure || !payload) {
        this.notice = failure ?? tr('browser.captureFailed');
        useToastsStore().error(this.notice);
        return;
      }

      this.pending = { ...this.pending, [tabId]: payload };
      this.notice = tr('browser.captureDone', {
        chars: String((payload.markdown || payload.text || '').length),
        links: String(payload.links.length),
      });
      // 接口不可用时脚本会带回 error —— 数据仍然可用（DOM 兜底），
      // 但用户要知道质量降级了。
      if (payload.error) useToastsStore().warning(payload.error);
      else useToastsStore().success(this.notice);

      // 抓到了引用但面板没开 —— 那这些链接在界面上根本看不见，用户会
      // 以为"采集引用没实现"。给一个可点的提示直接把它打开。
      if (payload.links.length > 0) {
        const settings = useSettingsStore();
        if (!settings.showRelatedLinks) {
          useToastsStore().info(tr('browser.openPanelHint'), 6000, () => {
            settings.toggleRelatedLinks();
          });
        }
      }
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

    // ---------------------------------------------------------------- 采集

    /**
     * 重新扫描目标目录，刷新"已采集"索引。
     *
     * 每次保存/采集后都要调 —— 索引过期的话，刚采完的链接在面板里仍然
     * 显示"未采集"，用户会重复采一遍。
     */
    async refreshCaptured(dir: string) {
      this.capturedUrls = await invoke<string[]>('capture_captured_urls', { dir }).catch(() => []);
    },

    /**
     * 保存当前 tab 抓到的对话。
     *
     * 优先用 `markdown`（接口路径产出的结构化全文），退回 `text`（DOM
     * 兜底）。两者都空就什么都不做 —— 与其写一个空文件，不如让用户
     * 知道没抓到。
     */
    async saveConversation(tabId: string) {
      const tab = useTabsStore().tabs.find((t) => t.id === tabId);
      const payload = this.pending[tabId];
      if (!tab?.captureDir) {
        this.notice = tr('browser.errNoDir');
        useToastsStore().error(this.notice);
        return;
      }
      if (!payload) {
        this.notice = tr('browser.errNothingToSave');
        useToastsStore().warning(this.notice);
        return;
      }

      const body = (payload.markdown || payload.text || '').trim();
      if (!body) {
        this.notice = tr('browser.errEmpty');
        useToastsStore().error(this.notice);
        return;
      }

      this.saving = true;
      try {
        const path = await invoke<string>('capture_save_conversation', {
          dir: tab.captureDir,
          title: payload.title || tab.fileName,
          url: payload.url,
          model: payload.model ?? '',
          markdown: body,
        });
        this.notice = tr('browser.saveDone', { name: path.split('/').pop() ?? '' });
        useToastsStore().success(this.notice);
        // 对话也有 url，会进索引 —— 刷新一次让状态一致。
        await this.refreshCaptured(tab.captureDir);
      } catch (e) {
        this.notice = tr('browser.saveFailed', { error: String(e) });
        useToastsStore().error(this.notice);
      } finally {
        this.saving = false;
      }
    },

    /** 采集单个引用链接：抓取 → 抽取 → 落盘 → 刷新索引。 */
    async captureLink(dir: string, url: string, title: string): Promise<FetchOutcome | null> {
      const key = await invoke<string>('capture_normalize_url', { url }).catch(() => url);
      this.linkStatus = { ...this.linkStatus, [key]: 'running' };
      try {
        const outcome = await invoke<FetchOutcome>('capture_fetch_page', {
          dir,
          url,
          fallbackTitle: title,
        });
        const failed = !!outcome.error && outcome.via === 'stub';
        this.linkStatus = { ...this.linkStatus, [key]: failed ? 'failed' : 'done' };
        // 抓完立刻重扫，否则这条仍显示"未采集"。
        await this.refreshCaptured(dir);
        if (failed) {
          useToastsStore().warning(tr('browser.linkFailedToast', { title: outcome.title }));
        } else {
          useToastsStore().success(tr('browser.linkDoneToast', { title: outcome.title }));
        }
        return outcome;
      } catch (e) {
        this.linkStatus = { ...this.linkStatus, [key]: 'failed' };
        this.notice = tr('browser.captureLinkFailed', { error: String(e) });
        useToastsStore().error(this.notice);
        return null;
      }
    },

    /** 判断一条链接是否已在当前目录采过。 */
    isCaptured(normalizedUrl: string): boolean {
      return this.capturedUrls.includes(normalizedUrl);
    },
  },
});
