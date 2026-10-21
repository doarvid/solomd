import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deleteWord, selectLine, selectWord, shiftHeading, type Range, type TextEdit } from './editor-commands.ts';

/** `|` marks the selection ends (one `|` = a bare caret). */
function parse(marked: string): { doc: string; from: number; to: number } {
  const first = marked.indexOf('|');
  const rest = marked.slice(first + 1);
  const second = rest.indexOf('|');
  const doc = second < 0 ? marked.replace('|', '') : marked.slice(0, first) + rest.replace('|', '');
  return { doc, from: first, to: second < 0 ? first : first + second };
}
function show(doc: string, from: number, to: number): string {
  return from === to
    ? doc.slice(0, from) + '|' + doc.slice(from)
    : doc.slice(0, from) + '|' + doc.slice(from, to) + '|' + doc.slice(to);
}
function sel(marked: string, fn: (d: string, f: number, t: number) => Range | null): string | null {
  const { doc, from, to } = parse(marked);
  const r = fn(doc, from, to);
  return r ? show(doc, r.from, r.to) : null;
}
function edit(marked: string, fn: (d: string, f: number, t: number) => TextEdit | null): string | null {
  const { doc, from, to } = parse(marked);
  const e = fn(doc, from, to);
  if (!e) return null;
  const out = doc.slice(0, e.from) + e.insert + doc.slice(e.to);
  return show(out, e.selFrom, e.selTo);
}

test('select word: inside, at either edge, and nothing between spaces', () => {
  assert.equal(sel('one tw|o three', selectWord), 'one |two| three');
  assert.equal(sel('one |two three', selectWord), 'one |two| three');
  assert.equal(sel('one two| three', selectWord), 'one |two| three');
  assert.equal(sel('one  |  two', selectWord), null);
});

test('select word: a selection grows to the words it touches', () => {
  assert.equal(sel('one t|wo th|ree', selectWord), 'one |two three| four'.replace(' four', ''));
});

test('select word: CJK picks a word, not the whole clause', () => {
  const r = sel('我们使用中文|输入法写作', selectWord);
  assert.ok(r, 'a CJK word is found');
  const picked = r!.split('|')[1];
  assert.ok(picked.length >= 1 && picked.length < 9, `picked "${picked}"`);
});

test('select word never crosses a line break', () => {
  assert.equal(sel('alpha\n|beta', selectWord), 'alpha\n|beta|');
  assert.equal(sel('alpha|\nbeta', selectWord), '|alpha|\nbeta');
});

test('delete word takes one neighbouring space with it', () => {
  assert.equal(edit('a wo|rd here', deleteWord), 'a |here');
  assert.equal(edit('wo|rd here', deleteWord), '|here');
  assert.equal(edit('a wo|rd.', deleteWord), 'a|.');
  assert.equal(edit('a wo|rd', deleteWord), 'a|');
  assert.equal(edit('a  |  b', deleteWord), null);
});

test('select line: the line without its break, then line by line', () => {
  assert.equal(sel('one\ntw|o\nthree', selectLine), 'one\n|two|\nthree');
  assert.equal(sel('one\n|two|\nthree', selectLine), 'one\n|two\nthree|');
  // At the last line it stays put.
  assert.equal(sel('one\n|two|', selectLine), 'one\n|two|');
  // A partial selection spanning lines covers those lines whole.
  assert.equal(sel('o|ne\ntw|o\nthree', selectLine), '|one\ntwo|\nthree');
});

test('heading promote / demote walk the levels and are inverses', () => {
  const up = (m: string) => edit(m, (d, f, t) => shiftHeading(d, f, t, 'promote'));
  const down = (m: string) => edit(m, (d, f, t) => shiftHeading(d, f, t, 'demote'));
  assert.equal(up('### Ti|tle'), '## Ti|tle');
  assert.equal(up('# Ti|tle'), null);
  assert.equal(up('Plain te|xt'), '###### Plain te|xt');
  assert.equal(down('## Ti|tle'), '### Ti|tle');
  assert.equal(down('###### Ti|tle'), 'Ti|tle');
  assert.equal(down('Plain te|xt'), null);
});

test('convert to paragraph drops the marker; caret inside the marker lands at the text', () => {
  const para = (m: string) => edit(m, (d, f, t) => shiftHeading(d, f, t, 'paragraph'));
  assert.equal(para('## Ti|tle'), 'Ti|tle');
  assert.equal(para('#|# Title'), '|Title');
  assert.equal(para('Already plain|'), null);
});

test('heading commands leave lists, quotes, fences and blank lines alone', () => {
  const up = (m: string) => edit(m, (d, f, t) => shiftHeading(d, f, t, 'promote'));
  assert.equal(up('- ite|m'), null);
  assert.equal(up('> quo|te'), null);
  assert.equal(up('```\n# not a he|ading\n```'), null);
  // A selection over several lines shifts each heading line.
  assert.equal(up('|## A\n\ntext\n### B|'), '|# A\n\n###### text\n## B|');
});
