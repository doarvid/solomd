/**
 * tabs 列表前后两帧的差异 → 原生子 webview 该创建谁、该销毁谁。
 *
 * 之所以用 diff 而不是在 closeTab / newBrowserTab 里直接调命令：tab 列表
 * 有多条改动路径（新建、关闭、会话恢复、工作区切换、批量关闭、窗口关闭…），
 * 每一处都手写一次 invoke 必然漏。盯 diff 是唯一能覆盖全路径的位置。
 *
 * 会话恢复也走这里 —— 从 localStorage 恢复出 kind==='browser' 的 tab 时，
 * 第一帧 diff 就会为它 create，不需要额外的恢复分支。前提是调用方在
 * 订阅之外**显式跑一次初始同步**（Pinia 的 $subscribe 不会为已有 state 补发）。
 */

import { isBrowserTab, type TabKind } from './tab-kind.ts';

export interface TabLike {
  id: string;
  kind?: TabKind;
}

export interface LifecycleDiff {
  create: string[];
  destroy: string[];
}

export function diffBrowserTabs(
  prev: readonly TabLike[],
  next: readonly TabLike[],
): LifecycleDiff {
  const prevIds = new Set(prev.filter(isBrowserTab).map((t) => t.id));
  const nextIds = new Set(next.filter(isBrowserTab).map((t) => t.id));

  const create: string[] = [];
  const destroy: string[] = [];
  for (const id of nextIds) if (!prevIds.has(id)) create.push(id);
  for (const id of prevIds) if (!nextIds.has(id)) destroy.push(id);
  return { create, destroy };
}
