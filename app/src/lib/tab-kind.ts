/**
 * 浏览器 tab 与文件 tab 的判别。
 *
 * `kind` 是可选的：老版本持久化下来的 tab 没有这个字段，必须当作文件 tab，
 * 否则升级后用户的每个标签页都会变成一片空白的浏览器面板。
 *
 * 抽成独立模块而不是内联判断，是为了让判别逻辑可单测 —— 这个函数在
 * 保存、关闭、工作区切换、会话恢复四个地方都要用，写错一处就是数据丢失。
 */

export type TabKind = 'file' | 'browser';

/** 判别只关心 kind，不关心 Tab 的其余字段，所以这里用结构化最小类型，
 *  好让测试不必构造一个完整的 Tab。 */
export interface KindCarrier {
  kind?: TabKind;
}

export function isBrowserTab(tab: KindCarrier): boolean {
  return tab.kind === 'browser';
}

export function isFileTab(tab: KindCarrier): boolean {
  return tab.kind !== 'browser';
}
