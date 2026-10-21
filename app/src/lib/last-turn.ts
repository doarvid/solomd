/**
 * 从一份 DeepSeek 对话 markdown 里切出**最后一轮**。
 *
 * capture_script.js 组装出来的结构是「每次提问一个 h1，后面跟深度思考、
 * 正文和末尾统一的 References」，所以"最后一轮" = 最后一个 h1 到结尾。
 *
 * 为什么是解析而不是逐行找 `^# `：
 * 正文里出现 `# 注释` 太常见了（回答贴一段 shell / python），而 ``` 和
 * 缩进代码块里的 `#` 不是标题。更狠的是**未闭合的 ```** —— 那之后整篇都
 * 是代码，靠"看到 ``` 就翻转 inFence"的写法会把真正的最后一个 h1 当成
 * 代码里的内容而漏掉，切回第一轮。交给 markdown-it 就没有这些判断：
 * 它按 CommonMark 的分块规则给出每个标题在**源码里的行号**。
 *
 * 用独立的 MarkdownIt 实例而不是 lib/markdown.ts 那个：那个是渲染管线
 * （katex / highlight.js / dompurify），这里只要分块结构，不该把渲染的
 * 一堆依赖和模块级状态拖进保存路径。
 */
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt();

const REF_HEADING = '## References';
const REF_ENTRY = /^- \[(\d+)\]\s+(.*)$/;
/**
 * 引用标记 `[N]`，但**不匹配 `[N](`** —— 那是 markdown 链接的文字部分
 * （`[1](https://…)` 是个正常的链接，不是引用标记），改掉它就把链接弄坏了。
 */
const MARK = /\[(\d+)\](?!\()/g;

/**
 * 返回 `source` 里最后一个顶层 h1 起的内容；没有 h1 就原样返回。
 *
 * `level === 0` 是把引用块 / 列表项里的标题排除掉 —— 那层级的 `# x` 是
 * 被引用的内容，不是新一轮提问。
 */
export function lastTurn(source: string): string {
  const lines = source.split('\n');
  let start = 0;
  for (const t of md.parse(source, {})) {
    if (t.type === 'heading_open' && t.tag === 'h1' && t.level === 0 && t.map) {
      start = t.map[0];
    }
  }
  // start === 0：本来就只有一轮（或没有 h1），没必要复制一遍。
  // 整篇都在时 References 也是完整的，不用重编。
  return start === 0 ? source : renumberReferences(lines.slice(start).join('\n'));
}

/**
 * 按正文**真正引用到**的编号重写 References。
 *
 * 注入脚本的编号是**整个对话**累加的（`ReferenceCollector.next` 跨轮递增），
 * 所以只切正文不重编的话，留下的是这样的东西：正文只引用了 8 条，底下却
 * 挂着 26 条（另外 18 条属于被丢掉的前几轮），而且正文里的编号从 `[1]` 直接
 * 跳到 `[11]` 再跳到 `[21]` —— 一条"只存最后一轮"的笔记，读起来像引用坏了。
 *
 * 保留原有顺序，编号从 1 重新排；正文里认不出来的编号（不属于任何条目的）
 * 原样留着，不做无依据的猜测。
 */
function renumberReferences(section: string): string {
  const lines = section.split('\n');
  // 最后一个 References 块 —— 脚本总是把它放在文末。
  let head = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === REF_HEADING) {
      head = i;
      break;
    }
  }
  if (head < 0) return section;

  const entries = new Map<number, string>();
  for (const line of lines.slice(head + 1)) {
    const m = REF_ENTRY.exec(line);
    if (m) entries.set(Number(m[1]), m[2]);
  }
  if (entries.size === 0) return section;

  const body = lines.slice(0, head);
  const cited = new Set<number>();
  for (const line of body) {
    for (const m of line.matchAll(MARK)) {
      const n = Number(m[1]);
      if (entries.has(n)) cited.add(n);
    }
  }
  // 正文一条都没引用上：保持原样，全删掉反而会让所有标记悬空。
  if (cited.size === 0) return section;

  // 旧编号 → 新编号，按旧编号升序 = 保持原有排列。
  const map = new Map<number, number>();
  for (const old of [...cited].sort((a, b) => a - b)) map.set(old, map.size + 1);
  const renumber = (s: string) =>
    s.replace(MARK, (whole, d: string) => {
      const next = map.get(Number(d));
      return next === undefined ? whole : `[${next}]`;
    });

  const out = body.map(renumber);
  out.push(REF_HEADING, '');
  for (const [old, next] of [...map.entries()].sort((a, b) => a[1] - b[1])) {
    out.push(`- [${next}] ${entries.get(old)}`);
  }
  out.push('');
  return out.join('\n');
}
