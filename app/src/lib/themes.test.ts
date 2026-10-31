import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { activeLineExtension, cmThemeFor, themeFamily } from './themes.ts';
import type { Theme } from '../types.ts';

const ALL_THEMES: Theme[] = [
  'light',
  'dark',
  'github-light',
  'solarized-light',
  'solarized-dark',
  'nord',
  'dracula',
  'monokai',
];

describe('themes & activeLineExtension (#477)', () => {
  it('activeLineExtension(true) and (false) build valid CodeMirror themes without throwing', () => {
    const stateOn = EditorState.create({
      doc: '# Hello\n\nWorld',
      extensions: [activeLineExtension(true)],
    });
    assert.equal(stateOn.doc.lines, 3);

    const stateOff = EditorState.create({
      doc: '# Hello\n\nWorld',
      extensions: [activeLineExtension(false)],
    });
    assert.equal(stateOff.doc.lines, 3);
  });

  it('all built-in themes and custom theme variants combine cleanly with activeLineExtension(true)', () => {
    for (const theme of ALL_THEMES) {
      for (const custom of [false, true]) {
        const state = EditorState.create({
          doc: '# Title\n- item 1\n- item 2',
          extensions: [cmThemeFor(theme, custom), activeLineExtension(true)],
        });
        assert.equal(state.doc.lines, 3);
      }
      assert.ok(themeFamily(theme) === 'light' || themeFamily(theme) === 'dark');
    }
  });
});
