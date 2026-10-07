import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractExternalLinks, dirOf, refsDirOf, sourceUrlOf } from './external-links.ts';

const hrefs = (md: string) => extractExternalLinks(md).map((l) => l.href);

test('picks up markdown links with their text', () => {
  const got = extractExternalLinks('见 [DeepSeek 文档](https://api-docs.deepseek.com/zh-cn/)。');
  assert.equal(got.length, 1);
  assert.equal(got[0].href, 'https://api-docs.deepseek.com/zh-cn/');
  assert.equal(got[0].text, 'DeepSeek 文档');
});

test('picks up bare urls', () => {
  assert.deepEqual(hrefs('参考 https://example.com/a 这篇'), ['https://example.com/a']);
});

test('skips images', () => {
  // 图片地址不是可采集的文章，收进来只会污染列表。
  assert.deepEqual(hrefs('![截图](https://example.com/a.png)'), []);
});

test('skips non-http schemes and anchors', () => {
  assert.deepEqual(hrefs('[mail](mailto:a@b.com)'), []);
  assert.deepEqual(hrefs('[本地](#section)'), []);
  assert.deepEqual(hrefs('[相对](./other.md)'), []);
});

test('skips internal wikilinks', () => {
  assert.deepEqual(hrefs('见 [[某篇笔记]] 和 [[另一篇|别名]]'), []);
});

test('deduplicates the same url written two ways', () => {
  // markdown 链接和裸 URL 指向同一地址时只留一条。
  const got = hrefs('[X](https://example.com/a) 以及 https://example.com/a');
  assert.deepEqual(got, ['https://example.com/a']);
});

test('a bare url upgrades the text of an already-seen link', () => {
  // 先出现裸 URL（没有文字），后面出现带文字的链接 —— 标题应该被补上。
  const got = extractExternalLinks('https://example.com/a 然后 [好标题](https://example.com/a)');
  assert.equal(got.length, 1);
  assert.equal(got[0].text, '好标题');
});

test('strips trailing sentence punctuation from bare urls', () => {
  // 中文写作里 URL 后面直接跟句号，不剥掉的话这条链接永远抓不到。
  assert.deepEqual(hrefs('见 https://example.com/a。'), ['https://example.com/a']);
  assert.deepEqual(hrefs('see https://example.com/a, then'), ['https://example.com/a']);
});

test('keeps meaningful punctuation inside a url', () => {
  assert.deepEqual(
    hrefs('https://example.com/search?q=a&b=c#frag'),
    ['https://example.com/search?q=a&b=c#frag'],
  );
});

test('handles several links across lines', () => {
  const md = [
    '# 标题',
    '- [一](https://a.example/1)',
    '- [二](https://b.example/2)',
    '',
    '正文 https://c.example/3',
  ].join('\n');
  assert.deepEqual(hrefs(md), ['https://a.example/1', 'https://b.example/2', 'https://c.example/3']);
});

test('a document with no links yields nothing', () => {
  assert.deepEqual(extractExternalLinks('# 纯文字\n\n没有任何链接。'), []);
});

test('does not hang or double-count on adjacent links', () => {
  assert.deepEqual(hrefs('[a](https://a.example/)[b](https://b.example/)'), [
    'https://a.example/',
    'https://b.example/',
  ]);
});

test('dirOf returns the parent directory', () => {
  assert.equal(dirOf('/Users/x/vault/note.md'), '/Users/x/vault');
  assert.equal(dirOf('/Users/x/vault/sub/note.md'), '/Users/x/vault/sub');
});

test('dirOf handles windows separators', () => {
  assert.equal(dirOf('C:\\Users\\x\\vault\\note.md'), 'C:\\Users\\x\\vault');
});

test('dirOf returns empty when there is no parent', () => {
  // 这些情况下没有可用的目标目录，调用方应该拒绝采集而不是写到根上。
  assert.equal(dirOf('note.md'), '');
  assert.equal(dirOf(''), '');
});

// --- sourceUrlOf：顶部工具栏「在浏览器打开」靠它决定出不出场 ---

test('sourceUrlOf 读 source，采集页就是这个键', () => {
  const md = '---\ntitle: 网页\nsource: "https://x.example/a"\n---\n\n正文\n';
  assert.equal(sourceUrlOf(md), 'https://x.example/a');
});

test('sourceUrlOf 退回读 url —— 更早的采集页和对话笔记只有这个键', () => {
  const md = '---\ntitle: 对话\nsource: deepseek\nurl: https://chat.deepseek.com/a/chat/s/1\n---\n';
  // `source: deepseek` 是平台标记不是地址，必须跳过它拿 url。
  assert.equal(sourceUrlOf(md), 'https://chat.deepseek.com/a/chat/s/1');
});

test('sourceUrlOf 只认 http(s)', () => {
  assert.equal(sourceUrlOf('---\nsource: deepseek\n---\n'), '');
  assert.equal(sourceUrlOf('---\nsource: file:///etc/passwd\n---\n'), '');
  assert.equal(sourceUrlOf('---\nsource: 42\n---\n'), '');
});

test('sourceUrlOf 对没有 frontmatter / 畸形 frontmatter 返回空串', () => {
  assert.equal(sourceUrlOf('# 普通笔记\n'), '');
  assert.equal(sourceUrlOf(''), '');
  // 只认开头的块：正文里出现 `source:` 不算。
  assert.equal(sourceUrlOf('正文\n\nsource: https://x.example/a\n'), '');
});

test('sourceUrlOf 脱掉 YAML 给 URL 加的引号', () => {
  assert.equal(sourceUrlOf("---\nsource: 'https://x.example/a'\n---\n"), 'https://x.example/a');
  assert.equal(sourceUrlOf('---\nsource: https://x.example/a\n---\n'), 'https://x.example/a');
});

// --- refsDirOf：引用页落在哪一层由开 tab 的场景决定 ---

test('refsDirOf 把 refs 拼在目录后面', () => {
  assert.equal(refsDirOf('/vault/notes'), '/vault/notes/refs');
});

test('refsDirOf 跟随原路径的分隔符风格', () => {
  // Windows 上 dirOf 给的是反斜杠路径，拼 `/` 会变成混用分隔符。
  assert.equal(refsDirOf('C:\\Users\\x\\vault'), 'C:\\Users\\x\\vault\\refs');
});

test('refsDirOf 不重复补分隔符', () => {
  assert.equal(refsDirOf('/vault/notes/'), '/vault/notes/refs');
});

test('refsDirOf 对空目录返回空串，调用方据此拒绝采集', () => {
  assert.equal(refsDirOf(''), '');
});
