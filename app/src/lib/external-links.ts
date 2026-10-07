/**
 * 从笔记正文里抽出**外部链接** —— 关联链接面板在普通笔记页上的数据源。
 *
 * 面板原本只服务浏览器 tab（链接来自采集回传）。但用户在日常写笔记时同样
 * 会贴一堆外链，"这一页引用的东西采过没有"是个通用问题，不该只在浏览器
 * 面板里能问。
 *
 * 抽成独立模块是为了可单测：正则抽链接是那种"看着对、边界全是坑"的逻辑
 * （图片链接、相对路径、代码块里的示例、被括号包住的 URL），值得有用例
 * 盯着。
 */

// 带扩展名：这个模块要能在 `node --test` 下直接跑（同 lib/ 的其它模块）。
import { splitFrontmatter } from './frontmatter.ts';

export interface ExternalLink {
  /** 原始 URL，未归一化 —— 归一化由 Rust 侧统一负责，避免两边规则漂移。 */
  href: string;
  /** 显示文字；没有就用 URL 本身。 */
  text: string;
}

/** 允许的协议。刻意只收 http(s)：其他协议（mailto/file/vscode）不是可采集的网页。 */
const HTTP = /^https?:\/\//i;

/** markdown 链接 / 图片：`[text](url)`、`![alt](url)` */
const MD_LINK = /(!?)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;

/** 裸 URL。排除引号、尖括号和各种括号，避免把 markdown 结构吃进来。 */
const BARE_URL = /https?:\/\/[^\s<>()[\]"'`，。；：、）】]+/gi;

/** 常见的中文标点结尾，粘贴时常被带进来但属于句子而非 URL。 */
const TRAILING_PUNCT = /[.,;:!?，。；：、！？）】」』]+$/;

/**
 * 抽出正文里的外部链接。
 *
 * 规则：
 * - 图片（`![](...)`）**跳过**：图片地址不是可采集的文章
 * - 相对路径 / 锚点 / 非 http 协议**跳过**
 * - 代码块里的内容不特殊处理：一个 URL 出现在代码块里，用户多半也希望
 *   能采它。为"示例链接"做区分需要解析 markdown 结构，收益不抵复杂度。
 * - 按**原始 URL** 去重；跨写法（markdown 链接 + 裸 URL 指向同一地址）
 *   也去重，靠记录已匹配区间实现
 */
export function extractExternalLinks(markdown: string): ExternalLink[] {
  const out: ExternalLink[] = [];
  const seen = new Set<string>();
  // 已被 markdown 链接消费掉的区间，避免同一 URL 又被裸 URL 规则抓一次。
  const consumed: Array<[number, number]> = [];

  const push = (href: string, text: string) => {
    const clean = href.replace(TRAILING_PUNCT, '');
    if (!HTTP.test(clean)) return;
    const key = clean;
    if (seen.has(key)) {
      // 已有的没文字、这次有 —— 补上，标题比 URL 可读得多。
      if (text) {
        const hit = out.find((l) => l.href === key);
        if (hit && hit.text === hit.href) hit.text = text;
      }
      return;
    }
    seen.add(key);
    out.push({ href: clean, text: text.trim() || clean });
  };

  MD_LINK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MD_LINK.exec(markdown)) !== null) {
    consumed.push([m.index, m.index + m[0].length]);
    if (m[1] === '!') continue; // 图片
    push(m[3], m[2]);
  }

  BARE_URL.lastIndex = 0;
  let b: RegExpExecArray | null;
  while ((b = BARE_URL.exec(markdown)) !== null) {
    if (consumed.some(([s, e]) => b!.index >= s && b!.index < e)) continue;
    push(b[0], '');
  }

  return out;
}

/**
 * 取路径的父目录。
 *
 * 自己写而不是复用 cm-image-paste 的私有 `dirnameOf`：那个函数要调用方
 * 自己传分隔符、服务于图片落盘，签名和用途都不对。这段逻辑只有一行。
 */
export function dirOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const cut = normalized.lastIndexOf('/');
  return cut > 0 ? filePath.slice(0, cut) : '';
}

/**
 * 引用页目录：`<dir>/refs`。
 *
 * 关联链接（反链）场景是"给这篇笔记收一批引用"，那批引用页收在 `refs/`
 * 子目录里 —— 和笔记本身分开，免得几十篇引用页把笔记目录淹掉。读原文的
 * 场景不套这一层，直接落文档自己的目录（见 `stores/tabs.ts` 的 `refsDir`）。
 *
 * 分隔符跟着入参走：Windows 上 `dirOf` 给的是反斜杠路径，拼个 `/` 上去
 * 就成了混用分隔符，落盘时虽然能用，但用户看着别扭，日志里也不好比对。
 */
export function refsDirOf(dir: string): string {
  if (!dir) return '';
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith(sep) ? `${dir}refs` : `${dir}${sep}refs`;
}

/**
 * 笔记 frontmatter 里的**原文地址**，没有就是空串。
 *
 * 采集页写的是 `source`（Obsidian Web Clipper 的约定，另一条采集路径
 * capture_endpoint 也用它），更早的采集页和对话笔记写的是 `url`。
 *
 * **只认 http(s)**：对话笔记的 `source: deepseek` 是平台标记而不是地址，
 * 照着它开浏览器只会得到一条非法 URL。
 *
 * frontmatter 解析失败（畸形 YAML）不该让调用方崩掉 —— 返回空串，调用方
 * 表现为"没有这个按钮"。
 */
export function sourceUrlOf(content: string): string {
  // 走真正的 YAML 解析而不是正则：采集端给含 `:` 的 URL 加引号
  // （`source: "https://…"`），值还可能被折行 —— 正则版要么漏要么把引号
  // 留在地址里。splitFrontmatter 保证不抛异常。
  const { data } = splitFrontmatter(content);
  for (const key of ['source', 'url']) {
    const v = data[key];
    if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) return v.trim();
  }
  return '';
}
