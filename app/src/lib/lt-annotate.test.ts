import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parser, GFM } from '@lezer/markdown';

import {
  PLACEHOLDER,
  blockIndexFor,
  collectBlocks,
  frontMatterEnd,
  frontMatterLanguage,
  packBatches,
  type LtSegment,
} from './lt-annotate.ts';

const md = parser.configure(GFM);

function blocks(doc: string) {
  const tree = md.parse(doc);
  return collectBlocks(tree, (a, b) => doc.slice(a, b), 0, doc.length, frontMatterEnd(doc));
}

/** What LanguageTool reads: text plus interpretAs for markup. */
function interpreted(segs: LtSegment[]): string {
  return segs.map((s) => s.text ?? s.interpretAs ?? '').join('');
}

function joined(segs: LtSegment[]): string {
  return segs.map((s) => s.text ?? s.markup ?? '').join('');
}

test('segments always concatenate back to the block source', () => {
  const doc = [
    '# A *heading* here',
    '',
    'Some **bold** and `code`, a [link](https://x.y "t") and ![img](a.png).',
    'Second line with [[Note|alias]] and [[Other]] plus $x^2$ math #tag.',
    '',
    '> quoted *text*',
    '> continues',
    '',
    '- item one',
    '- [ ] task two',
    '',
    '| a cell | b **cell** |',
    '|---|---|',
    '| c | d |',
  ].join('\n');
  const bs = blocks(doc);
  assert.ok(bs.length >= 6);
  for (const b of bs) {
    assert.equal(joined(b.segments), b.source, `block at ${b.from}`);
    assert.equal(doc.slice(b.from, b.to), b.source);
  }
});

test('markup is hidden and placeholders keep sentences readable', () => {
  const doc = 'Some **bold** and `code`, a [link](https://x.y) here.\nNext [[Note|alias]] and [[Other]] $x$ #tag end.';
  const [b] = blocks(doc);
  assert.equal(
    interpreted(b.segments),
    `Some bold and ${PLACEHOLDER}, a link here. Next alias and ${PLACEHOLDER} ${PLACEHOLDER} ${PLACEHOLDER} end.`,
  );
});

test('headings, quotes, lists and tasks drop their marks', () => {
  const doc = '## Title text\n\n> quoted line\n> second\n\n1. first item\n- [x] done task';
  const texts = blocks(doc).map((b) => interpreted(b.segments).trim());
  assert.deepEqual(texts, ['Title text', 'quoted line second', 'first item', 'done task']);
});

test('code blocks, html blocks and front matter are not checked', () => {
  const doc = [
    '---',
    'title: Teh draft',
    'lang: de_de',
    '---',
    '',
    '```js',
    'cnost x = 1;',
    '```',
    '',
    '    indented code',
    '',
    '<div>html block</div>',
    '',
    'Real prose.',
  ].join('\n');
  const bs = blocks(doc);
  assert.equal(bs.length, 1);
  assert.equal(bs[0].source, 'Real prose.');
  assert.equal(frontMatterLanguage(doc), 'de-DE');
});

test('front matter helpers', () => {
  assert.equal(frontMatterEnd('no front matter'), 0);
  assert.equal(frontMatterEnd('---\na: 1\n---\nbody'), '---\na: 1\n---\n'.length);
  assert.equal(frontMatterLanguage('---\nlanguage: "en-GB"\n---\n'), 'en-GB');
  assert.equal(frontMatterLanguage('---\nlang: auto\n---\n'), 'auto');
  assert.equal(frontMatterLanguage('---\ntitle: x\n---\n'), null);
});

test('blocks without letters are skipped', () => {
  assert.equal(blocks('`only code`\n\n$$\na+b\n$$\n\n---').length, 0);
});

test('range filter only returns intersecting blocks', () => {
  const doc = 'First para.\n\nSecond para.\n\nThird para.';
  const tree = md.parse(doc);
  const from = doc.indexOf('Second');
  const bs = collectBlocks(tree, (a, b) => doc.slice(a, b), from, from + 3);
  assert.deepEqual(bs.map((b) => b.source), ['Second para.']);
});

test('batches map match offsets back to their block', () => {
  const doc = 'Alpha one.\n\nBeta two.\n\nGamma three.';
  const bs = blocks(doc);
  const [batch] = packBatches(bs, 10_000);
  assert.equal(batch.blocks.length, 3);
  assert.equal(joined(batch.annotation), 'Alpha one.\n\nBeta two.\n\nGamma three.');
  const beta = joined(batch.annotation).indexOf('two');
  const i = blockIndexFor(batch, beta, 3);
  assert.equal(i, 1);
  assert.equal(batch.blocks[i].source.slice(beta - batch.starts[i], beta - batch.starts[i] + 3), 'two');
  // Straddling the separator → dropped.
  assert.equal(blockIndexFor(batch, 'Alpha one'.length, 4), -1);
  // Size cap splits batches.
  assert.equal(packBatches(bs, 12).length, 3);
});
