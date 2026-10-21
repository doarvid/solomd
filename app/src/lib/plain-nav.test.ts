import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  docParagraphStarts,
  nextParagraphStart,
  paragraphRangeInBlock,
  paragraphStartsInBlock,
  prevParagraphStart,
  selectionEnds,
} from './plain-nav.ts';

// Blocks as splitPlainMarkdownBlocks produces them for:
//   # Title\n\nOne two\nthree\n\n- a\n- b\n  more\n\n```js\n- x\n```\n
const doc = '# Title\n\nOne two\nthree\n\n- a\n- b\n  more\n\n```js\n- x\n```';
function blocksOf(src: string) {
  // Good enough for the fixture: blank lines separate blocks, and a blank line
  // is a block of its own.
  const out: { start: number; text: string }[] = [];
  let pos = 0;
  for (const chunk of src.split(/(\n\n)/)) {
    if (chunk === '\n\n') {
      out.push({ start: pos + 1, text: '' });
      pos += 2;
      continue;
    }
    out.push({ start: pos, text: chunk });
    pos += chunk.length;
  }
  return out;
}
const blocks = blocksOf(doc);
const at = (s: string) => doc.indexOf(s);

test('fixture blocks line up with the document', () => {
  for (const b of blocks) assert.equal(doc.slice(b.start, b.start + b.text.length), b.text);
});

test('paragraph starts: one per block, one per list item, none for blanks or inside fences', () => {
  assert.deepEqual(paragraphStartsInBlock(''), []);
  assert.deepEqual(paragraphStartsInBlock('   '), []);
  assert.deepEqual(paragraphStartsInBlock('One two\nthree'), [0]);
  assert.deepEqual(paragraphStartsInBlock('- a\n- b\n  more'), [0, 4]);
  assert.deepEqual(paragraphStartsInBlock('1. a\n2) b'), [0, 5]);
  assert.deepEqual(paragraphStartsInBlock('```js\n- x\n```'), [0]);
  assert.deepEqual(paragraphStartsInBlock('$$\n- x\n$$'), [0]);
  assert.deepEqual(docParagraphStarts(blocks), [0, at('One'), at('- a'), at('- b'), at('```')]);
});

test('Ctrl+Up goes to the current paragraph start, then the previous one', () => {
  const starts = docParagraphStarts(blocks);
  assert.equal(prevParagraphStart(starts, at('three')), at('One'));
  assert.equal(prevParagraphStart(starts, at('One')), 0);
  assert.equal(prevParagraphStart(starts, 0), 0);
  assert.equal(prevParagraphStart(starts, at('more')), at('- b'));
  // From a blank line between paragraphs: the paragraph above.
  assert.equal(prevParagraphStart(starts, at('- a') - 1), at('One'));
});

test('Ctrl+Down goes to the next paragraph start, the end after the last', () => {
  const starts = docParagraphStarts(blocks);
  assert.equal(nextParagraphStart(starts, 0, doc.length), at('One'));
  assert.equal(nextParagraphStart(starts, at('two'), doc.length), at('- a'));
  assert.equal(nextParagraphStart(starts, at('- a'), doc.length), at('- b'));
  assert.equal(nextParagraphStart(starts, at('```'), doc.length), doc.length);
  assert.equal(nextParagraphStart(starts, doc.length, doc.length), doc.length);
  assert.equal(nextParagraphStart([], 3, 10), 10);
});

test('triple-click range: whole paragraph, a list item, one line of code', () => {
  assert.deepEqual(paragraphRangeInBlock('One two\nthree', 10), { from: 0, to: 13 });
  const list = '- a\n- b\n  more';
  assert.deepEqual(paragraphRangeInBlock(list, 1), { from: 0, to: 3 });
  assert.deepEqual(paragraphRangeInBlock(list, list.indexOf('more')), { from: 4, to: list.length });
  const code = '```js\nlet a\nlet b\n```';
  assert.deepEqual(paragraphRangeInBlock(code, code.indexOf('let b') + 2), { from: 12, to: 17 });
  assert.deepEqual(paragraphRangeInBlock('', 0), { from: 0, to: 0 });
  assert.deepEqual(paragraphRangeInBlock('abc', 99), { from: 0, to: 3 });
});

test('selection ends follow the textarea direction', () => {
  assert.deepEqual(selectionEnds(2, 5, 'forward'), { anchor: 2, head: 5 });
  assert.deepEqual(selectionEnds(2, 5, 'none'), { anchor: 2, head: 5 });
  assert.deepEqual(selectionEnds(2, 5, 'backward'), { anchor: 5, head: 2 });
});
