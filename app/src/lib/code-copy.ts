/**
 * code-copy.ts — the shared "copy this code block" affordance.
 *
 * v4.3 issue #195 gave the preview pane a one-click copy button on every
 * fenced code block. The two *editing* surfaces that also render code
 * blocks never got one:
 *
 *   - the CodeMirror live-edit (WYSIWYG) mode, and
 *   - the Windows plain-block live editor (Editor.vue's `plain-block`
 *     renderer — see reference: Windows ships a second editor).
 *
 * In those modes the only way to copy code was to drag-select it, which
 * hands you the *source* text: the ``` fence lines and, for a block nested
 * in a list, the container's leading indentation. Users pasting into a
 * terminal or an IDE then have to strip that by hand. This module holds
 * the pieces every surface shares so the three of them behave identically:
 *
 *   - `copyPlainText`  — clipboard write with a browser fallback.
 *   - `dedentFenced`   — CommonMark's "strip up to the opening fence's own
 *                        indentation" rule, for the CM live-edit path.
 *   - `dedentIndented` — common-prefix strip for 4-space indented blocks.
 *   - `attachCodeCopyButtons` — the DOM-side button for HTML-rendered code
 *                        (preview pane + plain-block live editor). The
 *                        markdown renderer has already removed the fence
 *                        and the container indent there, so this path
 *                        copies `textContent` verbatim — dedenting it
 *                        would corrupt blocks whose every line is
 *                        legitimately indented (YAML fragments etc.).
 */

import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { isWindowsDesktop } from './platform';

/**
 * Normalize line endings for clipboard plain text (#486).
 * Traditional Windows desktop apps (e.g. 通达信 formula editor, classic Win32
 * edit controls) require CRLF (`\r\n`) in `CF_UNICODETEXT` / `text/plain` and
 * collapse bare LF (`\n`) into a single line.
 */
export function formatClipboardCodeText(text: string, windows = isWindowsDesktop()): string {
  if (!windows) return text;
  return text.replace(/\r?\n/g, '\r\n');
}

/**
 * Write `text` to the system clipboard. Prefers the Tauri clipboard plugin
 * (works on every platform we ship, including the WebView2 build where
 * `navigator.clipboard` is gated on a secure context) and falls back to the
 * web API so the same code path is drivable from a plain browser during
 * self-tests.
 */
export async function copyPlainText(text: string): Promise<void> {
  const payload = formatClipboardCodeText(text);
  try {
    await writeText(payload);
  } catch (err) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(payload);
      return;
    }
    throw err;
  }
}

/** Leading run of spaces/tabs on `line`. */
function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

/**
 * Strip at most `indent` (the opening fence's own indentation) from the
 * start of every line — exactly what a CommonMark renderer does to the
 * body of an indented fence. Lines that are indented *further* keep the
 * extra indentation, because that's real code structure.
 */
export function dedentFenced(text: string, indent: string): string {
  if (!indent) return text;
  return text
    .split('\n')
    .map((line) => {
      let i = 0;
      while (i < indent.length && i < line.length && line[i] === indent[i]) i += 1;
      return line.slice(i);
    })
    .join('\n');
}

/**
 * Strip the longest whitespace prefix common to every non-blank line. Used
 * for 4-space indented code blocks, where the indentation IS the fence and
 * carries no meaning of its own.
 */
export function dedentIndented(text: string): string {
  let prefix: string | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const ws = leadingWhitespace(line);
    if (prefix === null) {
      prefix = ws;
    } else {
      let i = 0;
      while (i < prefix.length && i < ws.length && prefix[i] === ws[i]) i += 1;
      prefix = prefix.slice(0, i);
    }
    if (prefix === '') return text;
  }
  if (!prefix) return text;
  const cut = prefix.length;
  return text
    .split('\n')
    .map((line) => (line.trim() ? line.slice(cut) : line.replace(/^[ \t]+/, '')))
    .join('\n');
}

export interface CodeCopyOptions {
  /** Button label, e.g. `t('toolbar.copy')`. */
  label: string;
  /** Reported when the clipboard write throws. */
  onError?: (err: unknown) => void;
}

/**
 * Give every `<pre><code>` inside `host` a copy button. Idempotent: blocks
 * already wrapped in a `.code-block-shell` are skipped, so it's safe to
 * call after every re-render.
 *
 * The button lives *outside* `<pre>` so it stays pinned while long code
 * scrolls horizontally, and it copies `textContent` so syntax-highlight
 * spans and the optional line-number gutter (a `::before` counter) never
 * reach the clipboard.
 */
export function attachCodeCopyButtons(
  host: HTMLElement,
  { label, onError }: CodeCopyOptions,
): void {
  const blocks = host.querySelectorAll<HTMLElement>('pre > code');
  for (const code of Array.from(blocks)) {
    const pre = code.parentElement as HTMLElement | null;
    if (!pre || pre.parentElement?.classList.contains('code-block-shell')) continue;

    const shell = document.createElement('div');
    shell.className = 'code-block-shell';
    pre.replaceWith(shell);
    shell.appendChild(pre);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy-button';
    button.textContent = label;
    button.title = label;
    button.setAttribute('aria-label', label);
    // The plain-block live editor turns a block into a textarea on click —
    // stop the event here so copying doesn't also drop the user into edit
    // mode. Harmless in the preview pane, which has no such handler.
    button.addEventListener('mousedown', (ev) => ev.stopPropagation());
    button.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try {
        await copyPlainText(code.textContent || '');
        button.textContent = '✓';
        window.setTimeout(() => {
          if (button.isConnected) button.textContent = label;
        }, 1200);
      } catch (err) {
        onError?.(err);
      }
    });
    shell.appendChild(button);
  }
}
