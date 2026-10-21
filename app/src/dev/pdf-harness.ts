/**
 * Dev harness for the PDF export's pagination — open `/pdf-harness.html` from
 * the Vite dev server (`pnpm --dir app dev`, or `npm --prefix app run dev`).
 *
 * It renders a long, adversarial markdown document through the *real* export
 * pipeline (`capturePdfRaster`), then answers the only question that matters:
 * does a page boundary ever land on a row with ink in it? A boundary with ink
 * on both sides is a sheared line of text — the "导出 PDF 跨页被截断" bug.
 *
 * It reports jsPDF's own cut lines (the old behaviour) next to the ones the
 * export now chooses, and draws a strip of each page break so the difference
 * is visible, not just asserted.
 */
import { capturePdfRaster, buildHtml2PdfOptions } from '../lib/pdf-export';
import { buildPagedCanvas, isCleanRowData } from '../lib/pdf-paginate';
import type { ResolvedPdfOptions } from '../lib/pdf-options';
import { wideTableFixture } from './wide-table-fixture';

const statusEl = document.getElementById('status') as HTMLElement;
const reportEl = document.getElementById('report') as HTMLElement;
const evidenceEl = document.getElementById('evidence') as HTMLElement;

/** A4 with the app's default 10mm side / 10+12mm vertical margins. */
const PDF_OPTS: ResolvedPdfOptions = {
  pageSizeMm: { width: 210, height: 297 },
  pageSizeLabel: 'A4',
  marginMm: { top: 10, right: 10, bottom: 12, left: 10 },
  fontFamily: '',
  fontSizePt: 11,
  footer: false,
  codeTheme: 'preview',
  toc: false,
};

/** Height of the strip drawn around each page break, in raster pixels. */
const STRIP = 90;

const ctx2d = (canvas: HTMLCanvasElement): CanvasRenderingContext2D => canvas.getContext('2d')!;

/**
 * Whether row `y` carries *text* ink: a pixel darker than any background,
 * border or rule the export draws (the lightest text colour is the quote grey
 * #6a6560). Not "any non-uniform row" — a table's column borders make every
 * row inside a table non-uniform, and a cut between two table rows would then
 * read as a shear although no glyph is touched (#337).
 */
function rowHasInk(canvas: HTMLCanvasElement, y: number): boolean {
  if (y < 0 || y >= canvas.height) return false;
  const d = ctx2d(canvas).getImageData(0, y, canvas.width, 1).data;
  for (let i = 0; i < d.length; i += 4) {
    if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 140) return true;
  }
  return false;
}

/** A boundary is sheared when ink sits on both sides of it — a sliced glyph. */
function isSheared(canvas: HTMLCanvasElement, y: number): boolean {
  return rowHasInk(canvas, y - 1) && rowHasInk(canvas, y);
}

/**
 * A document that stays just as hostile to fixed-height slicing as the ones
 * users reported: long CJK prose with inline code, list items that run across
 * the boundary, a code block and a table.
 */
function fixture(repeats: number): string {
  const blocks: string[] = ['# 结算对账说明 / Settlement reconciliation\n'];
  for (let i = 1; i <= repeats; i++) {
    blocks.push(`
## ${i}. 渠道流水与银行入账

试算会把同一笔交易的两条流水放在一起比对，「应计」来自渠道，「实收」来自银行账单。
下面几条是最常见的差异原因，每一条都要能追到原始流水：

- Stripe 流水中 \`currency=CNY\` 的金额主体为 \`requires_payment_method\`（尚未完成支付），
  因此不计入收入；这类流水在 \`status\` 字段上停留的时间通常不超过 24 小时。
- 银行入账头寸的日期与 Stripe 的 \`created\` 时间相差一个自然日时，归属期会被算到次日；
  这是会计期间差异，不是错账，冲销会让账更乱。
- 手续费在渠道侧先行扣除、银行侧按净额入账，所以两边永远对不上毛额，只能对净额。

> 备注：\`payout\` 到账之后，还要 T+1 才会出现在银行流水里，所以月末最后两天的
> 流水一定要留出观察窗口，否则会被误判成漏账。

\`\`\`ts
export function reconcile(rows: Row[]): Row[] {
  return rows.filter((row) => row.status === 'settled' && row.currency === 'CNY');
}
\`\`\`

| 字段 | 含义 | 备注 |
| --- | --- | --- |
| \`amount\` | 以最小货币单位计 | CNY 用「分」 |
| \`fee\` | 渠道手续费 | 含税，不参与分成 |
| \`status\` | 渠道状态 | 与银行状态不同源 |

正文段落用来把版面推到下一页：${'这一段是用于撑满版面的说明文字，重复出现以便让文档跨出多页。'.repeat(4)}
`);
  }
  // A single unbroken paragraph longer than a page. The pagebreak plugin's
  // `avoid` list can do nothing here — the block cannot be pushed to a page it
  // would fit in — so the boundary lands wherever the fixed grid puts it, which
  // is exactly where the old export sheared a line in half.
  blocks.push(`
## 附录：一段没有空行的长正文

${'对账口径必须逐笔可追溯，任何无法落到原始流水的差额都要单独挂账并写明原因。'.repeat(90)}
`);
  return blocks.join('\n');
}

interface BoundaryCheck {
  /** jsPDF's own boundary, in raster rows. */
  nominal: number;
  /** Where the export cuts instead. */
  cut: number;
  /** Rows given up to reach a line with no ink. */
  moved: number;
  /**
   * Measured on the raster the receiving side actually gets: the raw raster for
   * jsPDF's boundaries, the re-paginated one for ours.
   */
  sheared: boolean;
  /** Blank rows directly above the boundary — a page-break pad leaves many. */
  blankAbove: number;
  /** Blank rows directly below it. */
  blankBelow: number;
}

function px(value: number): string {
  return `${value}px (${((value / 96) * 25.4).toFixed(1)}mm)`;
}

/** Consecutive rows with no ink, walking `step` away from `from`. */
function blankRun(canvas: HTMLCanvasElement, from: number, step: 1 | -1): number {
  let count = 0;
  for (let y = from; y >= 0 && y < canvas.height; y += step) {
    if (rowHasInk(canvas, y)) break;
    count++;
  }
  return count;
}

/**
 * Rows whose last two pixel columns carry ink: content that ran into the edge
 * of the raster. The page column is pinned to the printable width, so this
 * means the layout was wider than the paper and got clipped.
 */
function rowsTouchingRightEdge(canvas: HTMLCanvasElement): number {
  const ctx = ctx2d(canvas);
  const row = ctx.getImageData(canvas.width - 2, 0, 2, canvas.height).data;
  let rows = 0;
  for (let y = 0; y < canvas.height; y++) {
    if (!isCleanRowData(row.subarray(y * 8, y * 8 + 8))) rows++;
  }
  return rows;
}

/**
 * A strip of the page break around `y`, drawn at 2x with a hairline on the
 * boundary row, so a sheared glyph is obvious at a glance.
 */
function strip(
  canvas: HTMLCanvasElement,
  y: number,
  boundary: number,
  label: string,
): HTMLCanvasElement {
  const zoom = 2;
  const top = Math.max(0, y - STRIP);
  const rows = Math.min(canvas.height, y + STRIP) - top;
  const out = document.createElement('canvas');
  out.width = canvas.width * zoom;
  out.height = rows * zoom + 22;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#fbfaf6';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, top, canvas.width, rows, 0, 22, out.width, rows * zoom);
  ctx.fillStyle = '#1f1d1a';
  ctx.font = '14px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillText(label, 8, 16);
  ctx.fillStyle = 'rgba(192, 43, 43, 0.9)';
  ctx.fillRect(0, (boundary - top) * zoom + 22, out.width, 1);
  return out;
}

function table(rows: BoundaryCheck[]): string {
  const body = rows
    .map(
      (r) =>
        `<tr><td>${px(r.nominal)}</td><td>${px(r.cut)}</td><td>${r.moved}px</td>` +
        `<td>${r.blankAbove} / ${r.blankBelow}</td><td class="${r.sheared ? 'bad' : 'ok'}">${
          r.sheared ? 'YES — a line of text is cut in half' : 'no'
        }</td></tr>`,
    )
    .join('');
  return (
    '<table><thead><tr><th>boundary</th><th>cut at</th><th>given up</th>' +
    '<th>blank above / below</th><th>sheared?</th></tr></thead>' +
    `<tbody>${body}</tbody></table>`
  );
}

/** Page count of a single-page-image PDF, straight out of the byte stream. */
async function countPdfPages(blob: Blob): Promise<number> {
  const text = new TextDecoder('latin1').decode(new Uint8Array(await blob.arrayBuffer()));
  return (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

interface HarnessConfig {
  label: string;
  opts: ResolvedPdfOptions;
  /** How many fixture blocks to render — drives how many pages we get. */
  blocks: number;
}

const A4 = { width: 210, height: 297 };
const A5 = { width: 148, height: 210 };

function preset(
  label: string,
  pageSizeLabel: string,
  size: { width: number; height: number },
  mm: number,
  blocks: number,
): HarnessConfig {
  return {
    label,
    blocks,
    opts: {
      pageSizeMm: size,
      pageSizeLabel,
      marginMm: { top: mm, right: mm, bottom: mm + 2, left: mm },
      fontFamily: '',
      fontSizePt: 11,
      footer: false,
      codeTheme: 'preview',
      toc: false,
    },
  };
}

/**
 * The page setups worth checking: default, a narrow printable width, a small page.
 *
 * The first one is long enough for the drift between jsPDF's raster-page grid
 * and the CSS-pixel grid the pagebreak plugin pads with to add up past a line's
 * leading — that is where the old export starts shearing lines in a document.
 */
const CONFIGS: HarnessConfig[] = [
  preset('A4 · 10mm margins', 'A4', A4, 10, 9),
  preset('A4 · 25mm margins', 'A4', A4, 25, 9),
  preset('A5 · 15mm margins', 'A5', A5, 15, 9),
];

export interface HarnessReport {
  status: 'ok' | 'failed';
  label: string;
  pageHeightPx: number;
  searchUpPx: number;
  raster: { width: number; height: number; rightEdgeRows: number };
  jsPdfBoundaries: BoundaryCheck[];
  exportBoundaries: BoundaryCheck[];
  pdf: { pages: number; expectedPages: number; bytes: number; gridAligned: boolean };
  error?: string;
}

/** Free a canvas' backing store as soon as the numbers are in. */
function release(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

async function run(
  config: HarnessConfig,
  withEvidence: boolean,
  markdown?: string,
): Promise<HarnessReport> {
  const capture = await capturePdfRaster(markdown ?? fixture(config.blocks), 'harness', config.opts);
  try {
    const raw = capture.canvas;
    if (!raw) throw new Error('html2pdf did not hand back a raster');
    const { pageHeightPx, searchUpPx, lineHeightPx } = capture;
    const pageCount = Math.ceil(raw.height / pageHeightPx);

    // What the export used to produce: jsPDF slicing this very raster at a
    // fixed page height. Measured on the raw raster, so the "before" numbers
    // are exactly what the old code would have handed the user.
    const jsPdfBoundaries: BoundaryCheck[] = [];
    for (let page = 1; page < pageCount; page++) {
      const nominal = Math.floor(page * pageHeightPx);
      jsPdfBoundaries.push({
        nominal,
        cut: nominal,
        moved: 0,
        sheared: isSheared(raw, nominal),
        blankAbove: blankRun(raw, nominal - 1, -1),
        blankBelow: blankRun(raw, nominal, 1),
      });
    }

    // What it produces now.
    const paged = buildPagedCanvas(raw, pageHeightPx, searchUpPx, lineHeightPx);
    if (!paged) throw new Error('buildPagedCanvas produced nothing');
    const exportBoundaries: BoundaryCheck[] = paged.breaks.map((cut, i) => {
      const boundary = (i + 1) * pageHeightPx;
      return {
        nominal: jsPdfBoundaries[i]?.nominal ?? boundary,
        cut,
        moved: boundary - cut,
        sheared: isSheared(paged.canvas, boundary),
        blankAbove: blankRun(paged.canvas, boundary - 1, -1),
        blankBelow: blankRun(paged.canvas, boundary, 1),
      };
    });

    // Evidence strips need both rasters, so draw them before anything is freed.
    evidenceEl.replaceChildren();
    if (withEvidence) {
      exportBoundaries.forEach((check, i) => {
        const boundary = (i + 1) * pageHeightPx;
        evidenceEl.append(
          strip(
            raw,
            check.nominal,
            check.nominal,
            `BEFORE · jsPDF's own cut at ${px(check.nominal)}${check.sheared ? ' — SHEARED' : ''}`,
          ),
          strip(
            paged.canvas,
            boundary,
            boundary,
            `AFTER · cut at ${px(check.cut)}, gave up ${check.moved}px`,
          ),
        );
      });
    }

    const rightEdgeRows = rowsTouchingRightEdge(raw);
    const rasterSize = { width: raw.width, height: raw.height };
    capture.useCanvas(paged.canvas);
    const blob = await capture.finish();
    window.__pdfHarnessLastPdf = blob;
    const pages = await countPdfPages(blob);
    const expectedPages = paged.breaks.length + 1;
    const gridAligned = pages === expectedPages;
    const shearedBefore = jsPdfBoundaries.filter((c) => c.sheared).length;
    const shearedAfter = exportBoundaries.filter((c) => c.sheared).length;
    release(raw);
    release(paged.canvas);

    const report: HarnessReport = {
      status: shearedAfter || !gridAligned ? 'failed' : 'ok',
      label: config.label,
      pageHeightPx,
      searchUpPx,
      raster: { ...rasterSize, rightEdgeRows },
      jsPdfBoundaries,
      exportBoundaries,
      pdf: { pages, expectedPages, bytes: blob.size, gridAligned },
    };

    if (withEvidence) {
      reportEl.innerHTML = `
        <div>${config.label} · page height ${pageHeightPx}px · search window ${searchUpPx}px ·
          ${pageCount} raster pages · ${rightEdgeRows} rows run into the right edge</div>
        <h2>jsPDF's own cut lines (the old export)</h2>
        ${table(jsPdfBoundaries)}
        <div><strong>${shearedBefore}</strong> of ${jsPdfBoundaries.length} boundaries sheared a line of text</div>
        <h2>Cuts chosen by the export now</h2>
        ${table(exportBoundaries)}
        <div><strong>${shearedAfter}</strong> of ${exportBoundaries.length} boundaries sheared a line of text</div>
        <div>PDF: ${pages} pages (the grid predicted ${expectedPages}) ·
          ${(blob.size / 1024).toFixed(0)} KB ·
          ${gridAligned ? 'jsPDF sliced exactly our pages' : 'GRID MISALIGNED — the raster is not page-sized'}</div>
      `;
      statusEl.textContent =
        report.status === 'ok'
          ? `PASS — ${config.label}: ${exportBoundaries.length} page breaks, none on ink (${shearedBefore} used to be sheared)`
          : `FAIL — ${config.label}: ${shearedAfter} page breaks on ink, grid aligned: ${gridAligned}`;
      statusEl.style.borderLeftColor = report.status === 'ok' ? '#1a7f37' : '#c02b2b';
    }
    return report;
  } finally {
    capture.dispose();
  }
}

/** Every page setup, for comparing where the old slicing actually cut a line. */
async function scan(): Promise<HarnessReport[]> {
  const out: HarnessReport[] = [];
  for (const config of CONFIGS) out.push(await run(config, false));
  return out;
}

/**
 * The same measurement for a document of your own — a browser page can't read
 * a note off disk, so the caller hands the markdown over (with any local images
 * already inlined as `data:` URLs, which is what the app's own export does).
 */
async function runDocument(markdown: string, label: string): Promise<HarnessReport> {
  return await run({ ...CONFIGS[0], label }, true, markdown);
}

declare global {
  interface Window {
    __pdfHarness?: HarnessReport | { status: 'failed'; error: string };
    __pdfHarnessRun?: (
      config: HarnessConfig,
      withEvidence: boolean,
      markdown?: string,
    ) => Promise<HarnessReport>;
    /** The PDF the last run produced, to save and inspect (#370). */
    __pdfHarnessLastPdf?: Blob;
    __pdfHarnessScan?: () => Promise<HarnessReport[]>;
    __pdfHarnessDocument?: (markdown: string, label: string) => Promise<HarnessReport>;
    /** The html2pdf options the export builds, for inspection. */
    __pdfHarnessOptions?: () => unknown;
  }
}

window.__pdfHarnessRun = run;
window.__pdfHarnessScan = scan;
window.__pdfHarnessDocument = runDocument;
(window as any).__pdfHarnessWideTable = () => runDocument(wideTableFixture(), 'wide table (#370)');
window.__pdfHarnessOptions = () => buildHtml2PdfOptions('probe', PDF_OPTS);

run(CONFIGS[0], true).then(
  (report) => {
    window.__pdfHarness = report;
  },
  (error: unknown) => {
    statusEl.textContent = `FAIL — ${String(error)}`;
    statusEl.style.borderLeftColor = '#c02b2b';
    window.__pdfHarness = { status: 'failed', error: String(error) };
  },
);
