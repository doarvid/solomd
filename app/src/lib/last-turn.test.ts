/**
 * last-turn.ts 的单测。显式 `.ts` 后缀导入，所以不需要 selftest.mjs 那层
 * resolve hook —— 直接跑（Node 原生类型擦除）：
 *
 *   node --test app/src/lib/last-turn.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lastTurn } from './last-turn.ts';

const CONV = [
  '# 第一个问题',
  '',
  '第一轮的回答。',
  '',
  '## References',
  '',
  '- [1] [A](https://a.example)',
  '',
  '# 第二个问题',
  '',
  '## 🤔 Thought Process',
  '',
  '想一下。',
  '',
  '---',
  '',
  '第二轮的正文，引用 [1]。',
  '',
  '## References',
  '',
  '- [1] [A](https://a.example)',
  '',
  '- [2] [B](https://b.example)',
  '',
].join('\n');

test('只留最后一轮，References 跟着重编', () => {
  const out = lastTurn(CONV);
  assert.ok(out.startsWith('# 第二个问题'), out.slice(0, 40));
  assert.ok(!out.includes('第一个问题'));
  assert.ok(!out.includes('第一轮的回答'));
  // 末尾的引用表还在，正文里的 [1] 才解析得出来；A 被这一轮引用到（编号
  // 恰好也是 1），所以留下。
  assert.ok(out.includes('- [1] [A](https://a.example)'));
});

test('只有一轮时原样返回', () => {
  const one = '# 唯一的问题\n\n回答。\n';
  assert.equal(lastTurn(one), one);
});

test('没有 h1（DOM 兜底的纯文本）原样返回', () => {
  const plain = '用户: 你好\n助手: 你好，有什么可以帮你？\n';
  assert.equal(lastTurn(plain), plain);
});

test('answer 里代码块的 # 注释不会被当成新一轮', () => {
  // 围栏落在**最后一个 h1 之后** —— 一旦被当成标题，回答就从代码块中间截断。
  // （闭合规范的三反引号围栏，逐行翻转 inFence 的实现也躲得过；真正分出差
  // 异的是下面 `~~~` 那条。）
  const src = [
    '# 唯一的问题',
    '',
    '看看这段：',
    '',
    '```bash',
    '# 这是注释，不是标题',
    'echo hi',
    '```',
    '',
    '以上。',
    '',
  ].join('\n');
  assert.equal(lastTurn(src), src);
});

test('~~~ 围栏里的 # 同理', () => {
  // 找 `^``` ` 的实现连 `~~~` 都不认，这里必然切错。
  const src = [
    '# 第一轮',
    '',
    '~~~',
    '# 仍在代码里',
    '~~~',
    '',
    '# 第二轮',
    '',
    '~~~',
    '# 第二轮里的注释',
    '~~~',
    '',
    '结尾。',
    '',
  ].join('\n');
  const out = lastTurn(src);
  assert.ok(out.startsWith('# 第二轮'), out.slice(0, 30));
  assert.ok(out.includes('# 第二轮里的注释'), '代码块要整段留下');
});

test('缩进代码块里的 # 不算标题', () => {
  const src = ['# 唯一的问题', '', '    # 四空格缩进是代码', '', '正文。', ''].join('\n');
  assert.equal(lastTurn(src), src);
});

test('引用块里的标题不是新一轮', () => {
  const src = [
    '# 第一轮',
    '',
    '> # 引用来的标题',
    '',
    '正文。',
    '',
  ].join('\n');
  assert.equal(lastTurn(src), src);
});

test('h2 不是轮次边界', () => {
  const src = ['# 第一轮', '', '## 小节', '', '内容。', ''].join('\n');
  assert.equal(lastTurn(src), src);
});

// --------------------------------------------------------------------------
// References 重编：注入脚本的编号是整个对话累加的，只切正文会让笔记底下
// 挂着前几轮的链接、正文编号还跳号。
// --------------------------------------------------------------------------

const TWO_TURNS_WITH_REFS = [
  '# 第一轮',
  '',
  '第一轮正文，引用 [1] 和 [2]。',
  '',
  '## References',
  '',
  '- [1] [甲](https://a.example)',
  '',
  '- [2] [乙](https://b.example)',
  '',
  '# 第二轮',
  '',
  '第二轮正文，只引用 [3]。',
  '',
  '## References',
  '',
  '- [1] [甲](https://a.example)',
  '',
  '- [2] [乙](https://b.example)',
  '',
  '- [3] [丙](https://c.example)',
  '',
].join('\n');

test('切片后 References 只留被引用的，编号从 1 重排', () => {
  const out = lastTurn(TWO_TURNS_WITH_REFS);
  assert.ok(out.includes('第二轮正文，只引用 [1]。'), out);
  assert.ok(!out.includes('甲'), '第一轮的引用条目要丢掉');
  assert.ok(out.includes('- [1] [丙](https://c.example)'));
  assert.equal(out.match(/^- \[\d+\]/gm)?.length, 1);
});

test('正文里的 markdown 链接 [1](url) 不被当成引用标记', () => {
  // 链接文字恰好是数字、且该编号真要重编时，只有标记改、链接不动。
  const src = [
    '# 第一轮',
    '',
    '看这个 [1](https://keep.example) 链接。',
    '',
    '## References',
    '',
    '- [1] [甲](https://a.example)',
    '',
    '# 第二轮',
    '',
    '正文 [2]，还有一个 [2](https://keep2.example)。',
    '',
    '## References',
    '',
    '- [1] [甲](https://a.example)',
    '',
    '- [2] [乙](https://b.example)',
    '',
  ].join('\n');
  const out = lastTurn(src);
  assert.ok(out.includes('[2](https://keep2.example)'), '链接文字是数字时不能被改掉');
  assert.ok(out.includes('正文 [1]，'), out);
  assert.ok(out.includes('- [1] [乙](https://b.example)'));
});

test('引用编号在列表里不存在时原样留着', () => {
  const src = [
    '# 第一轮',
    '',
    '正文 [99]，引用 [1]。',
    '',
    '## References',
    '',
    '- [1] [甲](https://a.example)',
    '',
    '# 第二轮',
    '',
    '只看这个 [7]，还有 [7](https://x.example)。',
    '',
    '## References',
    '',
    '- [1] [甲](https://a.example)',
    '',
  ].join('\n');
  const out = lastTurn(src);
  // 7 不在条目里，无从判断它是不是引用，保持不动。
  assert.ok(out.includes('只看这个 [7]'));
  assert.ok(out.includes('[7](https://x.example)'));
});

test('正文一条都没引用时不动 References', () => {
  const src = [
    '# 第一轮',
    '',
    '引用 [1]。',
    '',
    '## References',
    '',
    '- [1] [甲](https://a.example)',
    '',
    '# 第二轮',
    '',
    '这一轮没有任何标记。',
    '',
    '## References',
    '',
    '- [1] [甲](https://a.example)',
    '',
    '- [2] [乙](https://b.example)',
    '',
  ].join('\n');
  const out = lastTurn(src);
  assert.ok(out.includes('- [1] [甲](https://a.example)'));
  assert.ok(out.includes('- [2] [乙](https://b.example)'));
});

test('只有一轮时 References 原样保留', () => {
  const one = [
    '# 唯一的问题',
    '',
    '正文 [1]。',
    '',
    '## References',
    '',
    '- [1] [甲](https://a.example)',
    '',
    '- [7] [从未引用的](https://z.example)',
    '',
  ].join('\n');
  assert.equal(lastTurn(one), one);
});
