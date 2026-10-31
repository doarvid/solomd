import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectTypedFormat, hintKey } from './format-hint.ts';

const at = (line: string) => detectTypedFormat(line, line.slice(-1));

test('fires only when the construct is complete', () => {
  assert.equal(at('a **'), null);
  assert.equal(at('a **word*'), null);
  assert.equal(at('a **word**'), 'bold');
  assert.equal(at('这是**重点**'), 'bold');
});

test('italic is not confused with bold', () => {
  assert.equal(at('an *aside*'), 'italic');
  assert.equal(at('2 * 3 *'), null); // arithmetic, space-padded
});

test('strike, highlight, inline code, link', () => {
  assert.equal(at('~~gone~~'), 'strike');
  assert.equal(at('==marked=='), 'highlight');
  assert.equal(at('run `npm i`'), 'code');
  assert.equal(at('see [docs]('), 'link');
  assert.equal(at('f('), null);
});

test('a fence is a code block, not inline code', () => {
  assert.equal(at('```'), 'codeblock');
  assert.equal(at('``'), null);
});

test('line prefixes, only at the start of the line', () => {
  assert.equal(at('## '), 'h2');
  assert.equal(at('> '), 'quote');
  assert.equal(at('- '), 'ul');
  assert.equal(at('1. '), 'ol');
  assert.equal(at('- [ ] '), 'task');
  assert.equal(at('text - '), null);
  assert.equal(at('C# '), null);
});

test('six heading levels share one lesson', () => {
  assert.equal(hintKey('h1'), 'heading');
  assert.equal(hintKey('h4'), 'heading');
  assert.equal(hintKey('bold'), 'bold');
});
