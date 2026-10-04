/**
 * 浏览器 tab 在三条容易漏的路径上的行为。
 *
 * 每一条漏掉都对应一个具体故障：
 *
 *   - shouldSaveTab:               Ctrl+S 在浏览器 tab 上弹出"另存为"对话框
 *                                  （saveTab 在无 filePath 时会走 saveTabAs）
 *   - shouldPromptOnClose:         关 tab 时不弹脏确认直接关 → 原生子 webview
 *                                  泄漏且继续绘制在编辑器之上
 *   - shouldCarryAcrossWorkspace:  切工作区时被当成"无 filePath 的干净 tab"
 *                                  静默丢弃
 *
 * 浏览器 tab 永不 dirty（content 与 savedContent 都是空串），所以靠 dirty
 * 判断的既有逻辑**恰好**不误伤，但也**恰好**漏掉后两条 —— 它们不是因为
 * "脏"才需要特殊对待，而是因为浏览器 tab 与文件本来就不同类。
 *
 * 抽成纯函数是为了可单测：这三条都在数据丢失 / 资源泄漏的路径上。
 */

import { isBrowserTab } from './tab-kind.ts';

export interface Guardable {
  kind?: 'file' | 'browser';
  content: string;
  savedContent: string;
}

/** 浏览器 tab 没有可保存的内容，任何保存路径都必须短路。 */
export function shouldSaveTab(tab: Guardable): boolean {
  return !isBrowserTab(tab);
}

/**
 * 关闭前是否需要弹脏数据确认。
 * 浏览器 tab 没有未保存内容，不该被这个对话框拦住 —— 但**必须**单独走
 * 销毁 webview 的路径（见 shouldSaveTab 的说明）。
 */
export function shouldPromptOnClose(tab: Guardable): boolean {
  if (isBrowserTab(tab)) return false;
  return tab.content !== tab.savedContent;
}

/**
 * 切工作区时是否保留。
 *
 * 浏览器 tab 与工作区无关 —— 它的 captureDir 存的是绝对路径，跨工作区
 * 仍然有效，而且用户"开着的那几个检索窗口"不该因为换了个文件夹就消失。
 */
export function shouldCarryAcrossWorkspace(tab: Guardable): boolean {
  if (isBrowserTab(tab)) return true;
  return tab.content !== tab.savedContent;
}
