/**
 * Dev harness for the text PDF ("导出为 PDF（文字）") — open
 * `/print-harness.html` from the Vite dev server and print the page (Chromium's
 * print-to-PDF is the engine WebView2 prints with on Windows).
 *
 * It mounts the same overlay `exportPdfPrint` mounts (`mountPrintOverlay`), with
 * the app's real stylesheets, over a document long enough to need several
 * pages and holding a table that runs across page boundaries. Two things are
 * checked by printing it (#337):
 *   - the print is as many pages as the document, not one;
 *   - a table split across pages repeats its header row on the next page.
 *
 * Query params: `?rows=N` table length (default 120), `?pdf=a4` to apply a
 * user-touched A4 page setup instead of the webview default, `?win=1` to add
 * the Windows header/footer-suppressing page frame, `?toc=1` for the
 * table-of-contents page (#347), `?fixture=wide` for a table wider than the
 * page (#370).
 * `window.__printHarness` reports the overlay's height when ready.
 */
import '../styles/cjk-font.css';
import '../styles/main.css';
import '../styles/hljs-theme.css';
import 'katex/dist/katex.min.css';
// Preview.vue's unscoped <style> block carries the `.preview-content` skin the
// overlay uses; importing the SFC is what injects it, as it does in the app.
import '../components/Preview.vue';
import { renderMarkdown } from '../lib/markdown';
import {
  buildPrintStyle,
  buildWindowsPrintFrameStyle,
  resolvePdfOptions,
  withPdfToc,
} from '../lib/pdf-options';
import { defaultPdfDefaults } from '../stores/settings';
import { mountPrintOverlay } from '../lib/print-overlay';
import {
  decoratePrintToc,
  fillTocPageNumbers,
  printableBox,
  withPrintPagination,
} from '../lib/print-pages';
import { wideTableFixture } from './wide-table-fixture';

const params = new URLSearchParams(location.search);
const rows = Number(params.get('rows') || 120);

function fixture(): string {
  // `?fixture=wide` — a table wider than the page (#370).
  if (params.get('fixture') === 'wide') return wideTableFixture();
  const parts: string[] = ['# 打印分页测试 / Print pagination\n'];
  for (let i = 1; i <= 6; i++) {
    parts.push(
      `## ${i}. 段落\n\n` +
        '试算会把同一笔交易的两条流水放在一起比对，「应计」来自渠道，「实收」来自银行账单。'.repeat(6) +
        '\n',
    );
  }
  parts.push('## 长表格 / Long table\n');
  parts.push('| 序号 | 名称 | 说明 |\n| --- | --- | --- |');
  for (let r = 1; r <= rows; r++) {
    parts.push(`| ${r} | 条目 ${r} | 第 ${r} 行的说明文字，用来占满单元格宽度 row ${r} |`);
  }
  parts.push('\n## 结尾 / End\n\nLAST-LINE-MARKER');
  return parts.join('\n');
}

const opts = resolvePdfOptions(defaultPdfDefaults(), fixture(), params.get('pdf') === 'a4');
const source = params.get('toc') === '1' ? withPdfToc(fixture()) : fixture();
const css = [
  buildPrintStyle(opts),
  params.get('win') === '1' ? buildWindowsPrintFrameStyle(opts) : '',
].filter(Boolean).join('\n');
const mounted = mountPrintOverlay(renderMarkdown(source), 'light', css);

(window as any).__printHarness = {
  ready: true,
  overlayHeight: mounted.content.getBoundingClientRect().height,
};

// `?pages=1` — the simulated pagination and the TOC page numbers (#347), done
// the way exportPdfPrint does them, to compare with the printed PDF:
// `__printHarness.pagination.toc` lists "page title" per TOC entry.
if (params.get('pages') === '1') {
  const box = printableBox(opts.pageSizeMm, opts.marginMm);
  const nav = decoratePrintToc(mounted.content, params.get('lang') === 'en' ? 'Contents' : '目录');
  if (box) {
    (window as any).__printHarness.pagination = withPrintPagination(
      mounted.overlay,
      mounted.content,
      box,
      (p) => {
        if (nav) fillTocPageNumbers(nav, mounted.content, p.pageOf);
        return {
          pages: p.pages,
          headings: Array.from(mounted.content.querySelectorAll('h1, h2, h3')).map(
            (h) => `${p.pageOf(h)} ${h.textContent?.trim()}`,
          ),
          box,
        };
      },
    );
    (window as any).__printHarness.pagination.toc = nav
      ? Array.from(nav.querySelectorAll('a.md-toc__link')).map(
          (a) =>
            `${a.querySelector('.md-toc__page')?.textContent} ${a.querySelector('.md-toc__text')?.textContent?.trim()}`,
        )
      : [];
  }
}
