import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractExternalLinks, dirOf } from './external-links.ts';

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
