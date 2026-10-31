/**
 * Tests for embedding local images into exported HTML (`image-resolve.ts`).
 *
 * An exported .html is a standalone file: the `http://asset.localhost/…` URLs
 * that make images work inside the webview resolve nowhere else, which is how
 * a shared note ended up with two broken figures. The bytes have to travel
 * with the file.
 *
 * Run with: `node --test app/src/lib/image-resolve.test.ts`
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Explicit `.ts` extension: Node's ESM resolver needs it, and tsconfig excludes
// `*.test.ts` from vue-tsc. See the build-conventions note in repo memory.
import {
  inlineLocalImages,
  resolveImagePath,
  rewriteImageUrls,
  type BinaryReader,
} from './image-resolve.ts';

const NOTE = 'D:/notes/结算/月度对账.md';

/** An SVG whose bytes we can recognise again after base64. */
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function fakeDisk(files: Record<string, Uint8Array | string>) {
  const reads: string[] = [];
  const read: BinaryReader = async (path) => {
    reads.push(path);
    const entry = files[path];
    if (entry === undefined) return null;
    return typeof entry === 'string' ? new TextEncoder().encode(entry) : entry;
  };
  return { read, reads };
}

function decodeDataUrl(url: string): { mime: string; bytes: Uint8Array } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  assert.ok(match, `not a base64 data URL: ${url.slice(0, 40)}`);
  return { mime: match[1], bytes: new Uint8Array(Buffer.from(match[2], 'base64')) };
}

const srcOf = (html: string): string => /<img[^>]*src="([^"]*)"/.exec(html)?.[1] ?? '';

test('a relative image path is embedded with the file bytes', async () => {
  const { read, reads } = fakeDisk({ 'D:/notes/结算/diagram.svg': SVG });
  const html = await inlineLocalImages(
    '<p><img src="diagram.svg" alt="对账"></p>',
    null,
    NOTE,
    read,
  );

  assert.deepEqual(reads, ['D:/notes/结算/diagram.svg']);
  const { mime, bytes } = decodeDataUrl(srcOf(html));
  assert.equal(mime, 'image/svg+xml');
  assert.equal(new TextDecoder().decode(bytes), SVG);
  // The rest of the tag survives.
  assert.match(html, /alt="对账"/);
  assert.doesNotMatch(html, /asset\.localhost|tauri\.localhost/);
});

test('percent-encoded and spaced paths resolve, then embed', async () => {
  const imagePath = 'D:/notes/结算/screenshots/progress chart.png';
  const { read, reads } = fakeDisk({ [imagePath]: PNG });
  const html = await inlineLocalImages(
    '<img src="screenshots/progress%20chart.png">',
    null,
    NOTE,
    read,
  );

  assert.deepEqual(reads, [imagePath]);
  const { mime, bytes } = decodeDataUrl(srcOf(html));
  assert.equal(mime, 'image/png');
  assert.deepEqual([...bytes], [...PNG]);
});

test('an image folder from front matter is honoured', async () => {
  const { read, reads } = fakeDisk({ 'D:/notes/结算/assets/fig.webp': PNG });
  const html = await inlineLocalImages('<img src="fig.webp">', 'assets', NOTE, read);
  assert.deepEqual(reads, ['D:/notes/结算/assets/fig.webp']);
  assert.equal(decodeDataUrl(srcOf(html)).mime, 'image/webp');
});

test('the same image twice is read once', async () => {
  const { read, reads } = fakeDisk({ 'D:/notes/结算/a.svg': SVG });
  const html = await inlineLocalImages(
    '<img src="a.svg"><img src="./a.svg">',
    null,
    NOTE,
    read,
  );
  assert.equal(reads.length, 1);
  assert.equal((html.match(/data:image\/svg\+xml;base64,/g) ?? []).length, 2);
});

test('remote, data, blob and already-asset sources are left alone', async () => {
  const { read, reads } = fakeDisk({});
  const html = [
    '<img src="https://example.com/a.png">',
    '<img src="data:image/png;base64,AAAA">',
    '<img src="blob:http://localhost/xyz">',
    '<img src="http://asset.localhost/D%3A%2Fnotes%2Fa.png">',
  ].join('');
  assert.equal(await inlineLocalImages(html, null, NOTE, read), html);
  assert.deepEqual(reads, []);
});

test('an unreadable file or unknown type keeps the original src', async () => {
  const { read, reads } = fakeDisk({ 'D:/notes/结算/photo.psd': PNG });
  const missing = '<img src="gone.png">';
  assert.equal(await inlineLocalImages(missing, null, NOTE, read), missing);
  // Unknown extension: don't even open the file.
  assert.equal(await inlineLocalImages('<img src="photo.psd">', null, NOTE, read), missing.replace('gone.png', 'photo.psd'));
  assert.deepEqual(reads, ['D:/notes/结算/gone.png']);
});

test('markup between and after images is preserved byte for byte', async () => {
  const { read } = fakeDisk({ 'D:/notes/结算/a.svg': SVG, 'D:/notes/结算/b.svg': SVG });
  const html = await inlineLocalImages(
    '<h2>标题</h2>\n<img src="a.svg" title="a">\n<p>文字 &amp; 更多</p>\n<div><img src="b.svg"></div>\n',
    null,
    NOTE,
    read,
  );
  assert.match(html, /^<h2>标题<\/h2>\n<img src="data:image\/svg\+xml;base64,[^"]*" title="a">\n<p>文字 &amp; 更多<\/p>\n<div><img src="data:image\/svg\+xml;base64,[^"]*"><\/div>\n$/);
});

test('html without images is returned untouched', async () => {
  const { read, reads } = fakeDisk({});
  const html = '<p>没有图片</p>';
  assert.equal(await inlineLocalImages(html, null, NOTE, read), html);
  assert.deepEqual(reads, []);
});

test('Android SAF relative and shared-storage image paths resolve cleanly (#476)', async () => {
  const safNote = 'saf:primary:MyNotes/笔记.md';
  assert.equal(
    resolveImagePath('./assets/pic.png', null, safNote),
    'saf:primary:MyNotes/assets/pic.png',
  );
  assert.equal(
    resolveImagePath('../other/pic.png', null, 'saf:primary:MyNotes/sub/笔记.md'),
    'saf:primary:MyNotes/other/pic.png',
  );
  assert.equal(
    resolveImagePath('pic.png', null, 'saf:primary:笔记.md'),
    'saf:primary:pic.png',
  );
  assert.equal(
    resolveImagePath('/storage/emulated/0/MyNotes/assets/pic.png', null, safNote),
    'saf:primary:MyNotes/assets/pic.png',
  );

  const rewritten = rewriteImageUrls('<img src="./assets/pic.png">', null, safNote);
  assert.match(rewritten, /data-solomd-local-src="saf:primary:MyNotes\/assets\/pic\.png"/);
});
