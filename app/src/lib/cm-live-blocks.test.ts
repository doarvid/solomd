/**
 * Regression tests for #457: the block-decoration scans (raw HTML blocks,
 * <img> lines, tables, math) must stay inert INSIDE fenced code.
 *
 * The scans are line-based; a ```vue fence whose template holds
 * `<div>…</div>` had its middle replaced by an HtmlBlockWidget and rendered
 * as real HTML in live edit (the preview was always fine — markdown-it keeps
 * fence content literal). Same reveal model as ever: cursor inside the block
 * reveals source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';

import { liveBlocksExtension } from './cm-live-blocks.ts';

interface Found {
  from: number;
  to: number;
  widgetName: string;
}

/** All block-widget decorations with cursor parked on `cursorLine` (1-based). */
function widgets(doc: string, cursorLine = 1): Found[] {
  const anchor = doc.split('\n').slice(0, cursorLine - 1).join('\n').length + (cursorLine > 1 ? 1 : 0);
  const state = EditorState.create({
    doc,
    // The fence guard reads the lezer tree (FencedCode nodes), so the state
    // needs the same markdown language the editor runs.
    extensions: [
      markdown({ base: markdownLanguage, addKeymap: false }),
      liveBlocksExtension(),
    ],
    selection: { anchor },
  });
  const found: Found[] = [];
  for (const set of state.facet(EditorView.decorations)) {
    set.between(0, doc.length, (from, to, deco) => {
      const widget = (deco.spec as { widget?: { constructor: { name: string } } }).widget;
      if (widget) found.push({ from, to, widgetName: widget.constructor.name });
    });
  }
  return found;
}

const lineOf = (doc: string, pos: number) => doc.slice(0, pos).split('\n').length;

test('a <div> pair inside a ```vue fence is left alone (#457)', () => {
  const doc = [
    '```vue',
    '<script setup>',
    'const a = 1;',
    '</script>',
    '',
    '<template>',
    '  <div class="app">',
    '    <p>hi</p>',
    '  </div>',
    '</template>',
    '```',
  ].join('\n');
  // line 10 = "  </div>" (last line of the fenced div pair)
  const lastFenceLine = 10;
  const hits = widgets(doc).filter((w) => lineOf(doc, w.from) <= lastFenceLine);
  assert.deepEqual(hits, [], `fence interior was replaced: ${JSON.stringify(hits)}`);
});

test('the same <div> pair outside a fence still collapses to HtmlBlockWidget', () => {
  const doc = ['intro', '', '<div class="app">', '  <p>hi</p>', '</div>', ''].join('\n');
  const hits = widgets(doc).filter((w) => w.widgetName === 'HtmlBlockWidget');
  assert.equal(hits.length, 1, 'raw HTML block should still collapse');
  assert.equal(lineOf(doc, hits[0].from), 3);
  assert.equal(lineOf(doc, hits[0].to), 5);
});

test('cursor inside the raw HTML block still reveals its source', () => {
  const doc = ['<div class="app">', '  <p>hi</p>', '</div>', ''].join('\n');
  const hits = widgets(doc, 2).filter((w) => w.widgetName === 'HtmlBlockWidget');
  assert.deepEqual(hits, []);
});

test('a GFM table inside a fence is not replaced by TableWidget', () => {
  const doc = [
    '```text',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '```',
  ].join('\n');
  const hits = widgets(doc).filter((w) => w.widgetName === 'TableWidget');
  assert.deepEqual(hits, []);
});

test('a table outside a fence still collapses to TableWidget', () => {
  const doc = ['intro', '', '| a | b |', '|---|---|', '| 1 | 2 |', ''].join('\n');
  const hits = widgets(doc).filter((w) => w.widgetName === 'TableWidget');
  assert.equal(hits.length, 1);
});

test('a table inside a blockquote collapses to TableWidget in live edit (#480)', () => {
  const doc = [
    'intro',
    '',
    '> | Header | Header |',
    '> | --- | --- |',
    '> | cell | cell |',
    '',
  ].join('\n');
  const hits = widgets(doc).filter((w) => w.widgetName === 'TableWidget');
  assert.equal(hits.length, 1);
  assert.equal(lineOf(doc, hits[0].from), 3);
  assert.equal(lineOf(doc, hits[0].to), 5);
});

test('block math inside a fence is not replaced by MathWidget', () => {
  const doc = ['```text', '$$', 'E=mc^2', '$$', '```', ''].join('\n');
  const hits = widgets(doc).filter((w) => w.widgetName === 'MathWidget');
  assert.deepEqual(hits, []);
});

test('a ```mermaid fence outside other fences still renders', () => {
  const doc = ['intro', '', '```mermaid', 'graph TD; A-->B;', '```', ''].join('\n');
  const hits = widgets(doc).filter((w) => w.widgetName === 'MermaidWidget');
  assert.equal(hits.length, 1);
});

test('an unclosed fence keeps everything after it inert', () => {
  const doc = ['```html', '<div class="app">', '  <p>hi</p>', '</div>', ''].join('\n');
  const hits = widgets(doc).filter((w) => w.widgetName === 'HtmlBlockWidget');
  assert.deepEqual(hits, []);
});

test('a fence indented inside list items is still a fence to the scans', () => {
  const doc = [
    '- outer:',
    '    - inner:',
    '        ```vue',
    '        <div class="app">',
    '        </div>',
    '        ```',
  ].join('\n');
  const hits = widgets(doc).filter((w) => w.widgetName === 'HtmlBlockWidget');
  assert.deepEqual(hits, []);
});
