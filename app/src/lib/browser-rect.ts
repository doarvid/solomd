/**
 * 视口矩形 → 传给 `browser_set_bounds` 的逻辑像素。
 *
 * 刻意不做 devicePixelRatio 换算：Tauri 的 LogicalPosition / LogicalSize
 * 接受的就是 CSS 像素，自己再乘一遍 DPR 会在 Retina 上把 webview 放大一倍。
 *
 * 若 P0 实测发现需要减标题栏高度，只改这一个函数。
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
 * 返回 null 表示"这块区域现在不可见"（面板折叠、尺寸为 0），调用方应该
 * hide 而不是 set 一个 0×0 的 bounds —— 后者在某些平台上会变成一条可见
 * 的细线。
 */
export function toLogicalBounds(rect: ViewportRect, _devicePixelRatio: number): LogicalBounds | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
}
