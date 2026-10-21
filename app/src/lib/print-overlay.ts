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

export function mountPrintOverlay(
  bodyHtml: string,
  printTheme: PrintTheme,
  styleCss: string,
  customCss?: string,
): MountedPrintOverlay {
  let overlay = document.getElementById('solomd-print-overlay') as HTMLDivElement | null;
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'solomd-print-overlay';
    document.body.appendChild(overlay);
  }
  // KaTeX styling comes from the bundle — `main.ts` imports
  // `katex/dist/katex.min.css` and its selectors (`.katex`, `.katex-display`)
  // are global, so the overlay picks them up even though it lives outside
  // `#app`. This used to <link> katex.min.css off jsDelivr, which meant every
  // print silently hit the network: math came out unstyled with no
  // connection, and an offline-first app with no telemetry leaked a request
  // per print.
  overlay.innerHTML = `<div class="solomd-print-content preview-content">${bodyHtml}</div>`;
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
  const combinedCss = [styleCss, activeCustomCss].filter(Boolean).join('\n');

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
