/**
 * The DOM the text PDF ("导出为 PDF（文字）") prints from.
 *
 * `exportPdfPrint` mounts a print-only overlay next to `#app`, flips the body
 * into print mode and asks the native print sheet to snapshot the page. The
 * mounting lives here, free of Tauri and the stores, so `print-harness.html`
 * can build exactly the same DOM and print it through a real Chromium — the
 * engine WebView2 uses — to count pages (#337).
 */

import { buildExportCustomCss, getActiveCustomCss } from './custom-theme';

export type PrintTheme = 'light' | 'dark' | 'follow';

export interface MountedPrintOverlay {
  overlay: HTMLDivElement;
  /** The `.solomd-print-content` div holding the rendered markdown. */
  content: HTMLElement;
  /** Remove every trace of print mode. Safe to call more than once. */
  cleanup(): void;
}

const PRINT_CODE_NUMBER_CSS = `
.solomd-print-content.cb-wrap-on pre {
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: break-word;
  overflow-x: visible;
}
.solomd-print-content.cb-numbered-on pre.cb-numbered {
  counter-reset: cb-line;
  padding-left: 0;
}
.solomd-print-content.cb-numbered-on pre.cb-numbered code {
  display: block;
  white-space: normal;
}
.solomd-print-content.cb-numbered-on pre.cb-numbered code .cb-line {
  counter-increment: cb-line;
  display: block;
  padding-left: 3.4em;
  position: relative;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: break-word;
}
.solomd-print-content.cb-numbered-on pre.cb-numbered code .cb-line::before {
  content: counter(cb-line);
  position: absolute;
  left: 0;
  width: 2.6em;
  padding-right: 0.6em;
  text-align: right;
  color: var(--text-faint, #6e7781);
  border-right: 1px solid var(--border, #d0d7de);
  user-select: none;
  -webkit-user-select: none;
}
`;

export interface PrintOverlayOptions {
  codeBlockLineNumbers?: boolean;
  codeBlockWrap?: boolean;
}

export function mountPrintOverlay(
  bodyHtml: string,
  printTheme: PrintTheme,
  styleCss: string,
  customCss?: string,
  opts?: PrintOverlayOptions,
): MountedPrintOverlay {
  let overlay = document.getElementById('solomd-print-overlay') as HTMLDivElement | null;
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'solomd-print-overlay';
    document.body.appendChild(overlay);
  }
  const extraClasses = [
    opts?.codeBlockLineNumbers ? 'cb-numbered-on' : '',
    opts?.codeBlockWrap ? 'cb-wrap-on' : '',
  ]
    .filter(Boolean)
    .join(' ');
  overlay.innerHTML = `<div class="${['solomd-print-content', 'preview-content', extraClasses].filter(Boolean).join(' ')}">${bodyHtml}</div>`;
  // Print palette, independent of the app theme. The overlay sits outside
  // #app but still inherits :root's tokens, so a dark theme used to put a
  // dark code slab on paper. `follow` adds no class and keeps that.
  overlay.classList.remove('print-theme-light', 'print-theme-dark');
  if (printTheme !== 'follow') overlay.classList.add(`print-theme-${printTheme}`);
  document.body.classList.add('solomd-printing');
  document.body.classList.toggle('solomd-printing--dark', printTheme === 'dark');
  // The shell is `height: 100%; overflow: hidden` all the way up (html, body,
  // #app) so the app never scrolls as a page. Paper is the one place that has
  // to: printed under those rules the document is one page tall and
  // everything past it is clipped — "只能打印 1 页" (#337). The @media print
  // rules in main.css release them while this class is on <html>.
  document.documentElement.classList.add('solomd-printing');

  const activeCustomCss = buildExportCustomCss(
    customCss !== undefined ? customCss : getActiveCustomCss(),
    '#solomd-print-overlay, .solomd-print-content',
  );
  const combinedCss = [
    opts?.codeBlockLineNumbers || opts?.codeBlockWrap ? PRINT_CODE_NUMBER_CSS : '',
    styleCss,
    activeCustomCss,
  ]
    .filter(Boolean)
    .join('\n');

  let styleEl: HTMLStyleElement | null = null;
  if (combinedCss) {
    styleEl = document.createElement('style');
    styleEl.id = 'solomd-print-style';
    styleEl.textContent = combinedCss;
    document.head.appendChild(styleEl);
  }

  const mounted = overlay;
  return {
    overlay: mounted,
    content: mounted.querySelector<HTMLElement>('.solomd-print-content')!,
    cleanup() {
      document.body.classList.remove('solomd-printing', 'solomd-printing--dark');
      document.documentElement.classList.remove('solomd-printing');
      mounted.remove();
      styleEl?.remove();
    },
  };
}
