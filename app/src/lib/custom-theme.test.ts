import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExportCustomCss } from './custom-theme';

test('buildExportCustomCss returns empty string when rawCss is empty (#439)', () => {
  assert.equal(buildExportCustomCss(''), '');
  assert.equal(buildExportCustomCss('   ', '.pdf-page'), '');
});

test('buildExportCustomCss mirrors :root and body rules onto export container selector (#439)', () => {
  const raw = [
    ':root, :root[data-theme="light"] {',
    '  --bg: #fdf6e3;',
    '  --text: #657b83;',
    '}',
    'body {',
    '  font-size: 17px;',
    '}',
  ].join('\n');

  const out = buildExportCustomCss(raw, '.pdf-page');
  assert.ok(out.includes(raw));
  assert.ok(out.includes('.pdf-page {'));
  assert.ok(out.includes('--bg: #fdf6e3;'));
  assert.ok(out.includes('font-size: 17px;'));
});
