/**
 * 视口矩形 → 传给 `browser_set_bounds` 的逻辑像素。
 *
 * 两个换算，都只在缩放不是 1 的时候才看得见：
 *
 * 1. **不乘 devicePixelRatio**：Tauri 的 LogicalPosition / LogicalSize 收的
 *    就是逻辑像素，自己再乘一遍 DPR 会在 Retina 上把 webview 放大一倍。
 *
 * 2. **要乘页面缩放**：`getBoundingClientRect()` 给的是页面**布局空间**的
 *    CSS px，它不随缩放变化；而原生子 webview 是窗口上的一块独立表面，收的
 *    是逻辑像素。原生 `setZoom` 和 CSS `zoom` 兜底都是"渲染时放大 z 倍，
 *    布局度量不变"，所以两条路径都只差这一个系数。（实测：globalZoom 0.8、
 *    窗口逻辑宽 1792 时 `innerWidth` 是 2240 = 1792 / 0.8 —— CSS px × z
 *    才是逻辑 px。）
 *
 *    漏了这一步的表现很具体：位置和尺寸**一起**被放大，离左上角越远偏得
 *    越多 —— 左边和上边留一条空白，右边盖住侧栏，下边盖住 devtools。
 *    默认缩放是 1，所以这个 bug 只在用户按过 ⌘+/⌘- 之后才出现。
 */

export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LogicalBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 页面当前被缩放的倍数，由 App.vue 的全局缩放 watcher 写进来。
 *
 * 模块级可变值而不是响应式 ref：读它的是每帧都跑的 rAF tick，天然会读到
 * 最新值，不需要为它建立依赖。
 */
let pageZoom = 1;

export function setBrowserPageZoom(z: number): void {
  pageZoom = z > 0 ? z : 1;
}

/** 只给测试用。 */
export function browserPageZoom(): number {
  return pageZoom;
}

/**
 * 返回 null 表示"这块区域现在不可见"（面板折叠、尺寸为 0），调用方应该
 * hide 而不是 set 一个 0×0 的 bounds —— 后者在某些平台上会变成一条可见
 * 的细线。
 */
export function toLogicalBounds(rect: ViewportRect): LogicalBounds | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  return {
    x: rect.left * pageZoom,
    y: rect.top * pageZoom,
    w: rect.width * pageZoom,
    h: rect.height * pageZoom,
  };
}
