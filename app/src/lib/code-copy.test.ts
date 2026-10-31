import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatClipboardCodeText } from './code-copy.ts';
import { renderMarkdown } from './markdown.ts';
import { sanitizeRenderedHtml } from './sanitize-html.ts';
import { tabCaretMemory } from './scroll-memory.ts';
import { zh } from '../i18n/zh.ts';
import { en } from '../i18n/en.ts';

test('#486 — formatClipboardCodeText converts LF to CRLF on Windows for Win32 apps (通达信)', () => {
  const src = 'MA5:MA(C,5);\nMA10:MA(C,10);\nCROSS(MA5,MA10);';
  assert.equal(
    formatClipboardCodeText(src, true),
    'MA5:MA(C,5);\r\nMA10:MA(C,10);\r\nCROSS(MA5,MA10);',
  );
  // Existing CRLF is not doubled into CRCRLF
  assert.equal(
    formatClipboardCodeText('A\r\nB\nC', true),
    'A\r\nB\r\nC',
  );
  // Non-Windows keeps LF unchanged
  assert.equal(formatClipboardCodeText(src, false), src);
});

test('#486 — tabCaretMemory preserves anchorPos and anchorViewportTop across tab switches', () => {
  tabCaretMemory.delete('tab-486');
  tabCaretMemory.set('tab-486', {
    caret: 420,
    scrollTop: 1280,
    anchorPos: 420,
    anchorViewportTop: 184,
  });
  const snap = tabCaretMemory.get('tab-486');
  assert.ok(snap);
  assert.equal(snap.caret, 420);
  assert.equal(snap.scrollTop, 1280);
  assert.equal(snap.anchorPos, 420);
  assert.equal(snap.anchorViewportTop, 184);
  tabCaretMemory.delete('tab-486');
});

test('#504 — bare stock ticker codes (00700.HK, 600519.SH, 000001.SZ) are not linkified as URLs', () => {
  const html = renderMarkdown('持仓：00700.HK、600519.SH、000001.SZ，详见 https://solomd.app/docs');
  assert.ok(!html.includes('href="http://00700.HK"'), `unexpected 00700.HK link in: ${html}`);
  assert.ok(!html.includes('href="http://600519.SH"'), `unexpected 600519.SH link in: ${html}`);
  assert.ok(!html.includes('href="http://000001.SZ"'), `unexpected 000001.SZ link in: ${html}`);
  // Explicit protocol links are still auto-linked
  assert.ok(html.includes('href="https://solomd.app/docs"'), `expected explicit https link in: ${html}`);
});

test('#493 — rendered markdown and sanitized HTML images include referrerpolicy="no-referrer"', () => {
  const mdHtml = renderMarkdown('![gitee](https://gitee.com/user/repo/raw/master/img.png)');
  assert.ok(
    mdHtml.includes('referrerpolicy="no-referrer"'),
    `expected referrerpolicy="no-referrer" on markdown image: ${mdHtml}`,
  );
  const rawHtml = sanitizeRenderedHtml('<p><img src="https://gitee.com/a.png"></p>');
  assert.ok(
    rawHtml.includes('referrerpolicy="no-referrer"'),
    `expected referrerpolicy="no-referrer" on sanitized raw <img>: ${rawHtml}`,
  );
});

test('#494 — FileTree explorer i18n keys exist and are non-empty', () => {
  assert.ok(zh.explorer.clearRecentFolders && !zh.explorer.clearRecentFolders.includes('explorer.'));
  assert.ok(zh.explorer.expandSubtree && !zh.explorer.expandSubtree.includes('explorer.'));
  assert.ok(zh.explorer.collapseSubtree && !zh.explorer.collapseSubtree.includes('explorer.'));
  assert.ok(en.explorer.clearRecentFolders && !en.explorer.clearRecentFolders.includes('explorer.'));
  assert.ok(en.explorer.expandSubtree && !en.explorer.expandSubtree.includes('explorer.'));
  assert.ok(en.explorer.collapseSubtree && !en.explorer.collapseSubtree.includes('explorer.'));
});

test('#496 — Windows backslash image paths survive markdown-it without escaping', () => {
  const html = renderMarkdown('![win](E:\\photos\\img.png)\n\n```\n![fence](E:\\photos\\img.png)\n```');
  assert.ok(html.includes('src="E:/photos/img.png"'), `expected normalized forward-slash src in: ${html}`);
  assert.ok(html.includes('![fence](E:\\photos\\img.png)'), `expected code fence backslash preserved in: ${html}`);
});
