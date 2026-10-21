/**
 * #427 — "Copy as Word" (`copyAsWord`) HTML transformer.
 *
 * Pasting SoloMD's raw preview HTML directly into Microsoft Word / WPS Office
 * fails in four ways because external stylesheets are not carried on the
 * clipboard:
 *   1. KaTeX outputs both `<span class="katex-mathml"><math>…</math></span>`
 *      and `<span class="katex-html" aria-hidden="true">…</span>`. Without
 *      `katex.min.css` (`display: none` on `.katex-mathml`), Word pastes both
 *      trees — every formula appears twice (once as an equation and once as
 *      garbled span fragments). Keeping only `<math>` lets Word convert it
 *      into a native Office Math (OMML) equation.
 *   2. Fenced code blocks wrap each line in `<span class="cb-line">` and emit
 *      a `<div class="code-block__header">` with language badge + Copy button.
 *      Word pastes the button text and collapses `.cb-line` spans onto a
 *      single line unless explicit `<br>` breaks are inserted.
 *   3. Tables have no inline borders, so Word pastes borderless cells.
 *   4. `<input type="checkbox">` in task lists becomes a legacy ActiveX
 *      control in Word instead of `☑` / `☐`.
 */

const WORD_BASE_CSS = `
  body {
    font-family: Calibri, "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 11pt;
    line-height: 1.5;
    color: #1f1d1a;
  }
  h1, h2, h3, h4, h5, h6 {
    font-family: Calibri, "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #1f1d1a;
    font-weight: bold;
    line-height: 1.3;
  }
  h1 { font-size: 20pt; margin: 18pt 0 9pt 0; }
  h2 { font-size: 16pt; margin: 16pt 0 8pt 0; }
  h3 { font-size: 13.5pt; margin: 14pt 0 7pt 0; }
  h4 { font-size: 12pt; margin: 12pt 0 6pt 0; }
  h5, h6 { font-size: 11pt; margin: 10pt 0 5pt 0; }
  p { margin: 0 0 6pt 0; }
  blockquote {
    margin: 6pt 0 6pt 18pt;
    padding: 2pt 0 2pt 8pt;
    border-left: 3pt solid #ff9f40;
    color: #5e5b55;
  }
  pre {
    background: #f3efe7;
    color: #1f1d1a;
    border: 1px solid #e6e2d8;
    border-left: 3pt solid #ff9f40;
    padding: 8pt 10pt;
    font-family: "JetBrains Mono", Consolas, "Courier New", monospace;
    font-size: 10pt;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 8pt 0;
  }
  code {
    font-family: "JetBrains Mono", Consolas, "Courier New", monospace;
    font-size: 10pt;
    color: #8a4a00;
    background: #f3efe7;
    padding: 1pt 3pt;
  }
  pre code {
    color: #1f1d1a;
    background: transparent;
    padding: 0;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 6pt 0;
  }
  th, td {
    border: 1px solid #e6e2d8;
    padding: 4pt 6pt;
    vertical-align: top;
  }
  th {
    background: #ffe7cc;
    font-weight: bold;
  }
  hr {
    border: none;
    border-bottom: 1px solid #cccccc;
    margin: 12pt 0;
  }
`;

/**
 * Find every balanced `<tagName ...>...</tagName>` whose opening tag matches
 * `openTagRegex` and replace it with `replacer(innerHtml, openTag)`.
 * Handles arbitrarily nested tags of the same `tagName` (e.g. KaTeX's nested
 * `<span>` trees).
 */
function replaceBalancedElement(
  html: string,
  tagName: string,
  openTagRegex: RegExp,
  replacer: (innerHtml: string, openTag: string) => string,
): string {
  const openAnyRe = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi');
  const matcher = new RegExp(
    openTagRegex.source,
    openTagRegex.flags.includes('g') ? openTagRegex.flags : `${openTagRegex.flags}g`,
  );

  let out = '';
  let cursor = 0;

  while (cursor < html.length) {
    matcher.lastIndex = cursor;
    const match = matcher.exec(html);
    if (!match) {
      out += html.slice(cursor);
      break;
    }

    const startIdx = match.index;
    const openTag = match[0];
    const innerStart = startIdx + openTag.length;

    // Walk forward counting nested <tagName> and </tagName>
    let depth = 1;
    let scanPos = innerStart;
    let innerEnd = -1;
    let afterClose = -1;

    while (depth > 0 && scanPos < html.length) {
      openAnyRe.lastIndex = scanPos;
      closeRe.lastIndex = scanPos;
      const nextOpen = openAnyRe.exec(html);
      const nextClose = closeRe.exec(html);

      if (!nextClose) break;

      if (nextOpen && nextOpen.index < nextClose.index) {
        // Self-closing tag check
        if (!nextOpen[0].endsWith('/>')) {
          depth++;
        }
        scanPos = nextOpen.index + nextOpen[0].length;
      } else {
        depth--;
        if (depth === 0) {
          innerEnd = nextClose.index;
          afterClose = nextClose.index + nextClose[0].length;
        } else {
          scanPos = nextClose.index + nextClose[0].length;
        }
      }
    }

    if (innerEnd < 0) {
      // Unbalanced fallback: copy remaining string as-is
      out += html.slice(cursor);
      break;
    }

    out += html.slice(cursor, startIdx);
    const innerHtml = html.slice(innerStart, innerEnd);
    out += replacer(innerHtml, openTag);
    cursor = afterClose;
  }

  return out;
}

function ensureMathMlAttrs(mathHtml: string, displayBlock: boolean): string {
  return mathHtml.replace(/^<math\b([^>]*)>/i, (_full, attrs: string) => {
    let nextAttrs = attrs;
    if (!/\bxmlns\s*=/i.test(nextAttrs)) {
      nextAttrs += ' xmlns="http://www.w3.org/1998/Math/MathML"';
    }
    if (displayBlock && !/\bdisplay\s*=/i.test(nextAttrs)) {
      nextAttrs += ' display="block"';
    }
    return `<math${nextAttrs}>`;
  });
}

function styleTablesForWord(html: string): string {
  return html
    .replace(/<table(\b[^>]*?)>/gi, (_m, attrs: string) => {
      if (/\bstyle\s*=/i.test(attrs)) return `<table${attrs}>`;
      return `<table${attrs} style="border-collapse: collapse; width: 100%; margin: 6pt 0;">`;
    })
    .replace(/<th(\b[^>]*?)>/gi, (_m, attrs: string) => {
      const base = 'border: 1px solid #e6e2d8; padding: 4pt 6pt; background: #ffe7cc; font-weight: bold;';
      if (/\bstyle\s*=\s*"([^"]*)"/i.test(attrs)) {
        return `<th${attrs.replace(/\bstyle\s*=\s*"([^"]*)"/i, `style="${base} $1"`)}>`;
      }
      return `<th${attrs} style="${base}">`;
    })
    .replace(/<td(\b[^>]*?)>/gi, (_m, attrs: string) => {
      const base = 'border: 1px solid #e6e2d8; padding: 4pt 6pt;';
      if (/\bstyle\s*=\s*"([^"]*)"/i.test(attrs)) {
        return `<td${attrs.replace(/\bstyle\s*=\s*"([^"]*)"/i, `style="${base} $1"`)}>`;
      }
      return `<td${attrs} style="${base}">`;
    });
}

function toRoman(num: number): string {
  const pairs: Array<[number, string]> = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'],
    [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'],
    [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let n = Math.max(1, Math.floor(num));
  let out = '';
  for (const [val, sym] of pairs) {
    while (n >= val) {
      out += sym;
      n -= val;
    }
  }
  return out;
}

function toAlpha(num: number): string {
  let n = Math.max(1, Math.floor(num));
  let out = '';
  while (n > 0) {
    n--;
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

function formatOrderedMarker(index: number, depth: number): string {
  const mode = depth % 3;
  if (mode === 1) return `${toAlpha(index)}. `;
  if (mode === 2) return `${toRoman(index)}. `;
  return `${index}. `;
}

function formatBulletMarker(depth: number): string {
  const bullets = ['• ', '◦ ', '▪ '];
  return bullets[depth % bullets.length];
}

/**
 * #432 — Word / WPS Office's HTML clipboard importer converts `<ol>` / `<ul>`
 * into `mso-list` paragraphs with `margin-left: 0; text-indent: -18pt`, which:
 *   1. Pushes list numbers (`1.`, `2.`) 18pt outside the left page border;
 *   2. Numbers EVERY `<p>` inside a multi-paragraph `<li>` (turning `（1）` /
 *      `（2）` continuation lines into `2. （1）`, `3. （2）`);
 *   3. Frequently merges separate `<ol>` blocks into a single continuous list.
 *
 * Converting `<ol>` / `<ul>` into explicit `<p>` paragraphs with the same
 * indentation as `docx-export.ts` (`margin-left: ${(depth + 1) * 24}pt;
 * text-indent: -18pt` on the first paragraph of each item, and
 * `margin-left: ${(depth + 1) * 24}pt` without a marker on continuation
 * paragraphs/lines) keeps numbers inside the left border and preserves
 * `1, 2, 3` and `（1）（2）` sub-items identically to "Export as Word".
 */
function convertListsForWord(html: string, depth = 0): string {
  const listOpenRe = /<(ol|ul)\b[^>]*>/gi;
  let out = '';
  let cursor = 0;

  while (cursor < html.length) {
    listOpenRe.lastIndex = cursor;
    const match = listOpenRe.exec(html);
    if (!match) {
      out += html.slice(cursor);
      break;
    }

    const tagName = match[1].toLowerCase();
    const startIdx = match.index;
    const openTag = match[0];
    const innerStart = startIdx + openTag.length;

    const openAnyRe = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
    const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi');
    let nest = 1;
    let scanPos = innerStart;
    let innerEnd = -1;
    let afterClose = -1;

    while (nest > 0 && scanPos < html.length) {
      openAnyRe.lastIndex = scanPos;
      closeRe.lastIndex = scanPos;
      const nextOpen = openAnyRe.exec(html);
      const nextClose = closeRe.exec(html);
      if (!nextClose) break;
      if (nextOpen && nextOpen.index < nextClose.index) {
        if (!nextOpen[0].endsWith('/>')) nest++;
        scanPos = nextOpen.index + nextOpen[0].length;
      } else {
        nest--;
        if (nest === 0) {
          innerEnd = nextClose.index;
          afterClose = nextClose.index + nextClose[0].length;
        } else {
          scanPos = nextClose.index + nextClose[0].length;
        }
      }
    }

    if (innerEnd < 0) {
      out += html.slice(cursor);
      break;
    }

    out += html.slice(cursor, startIdx);
    const listInner = html.slice(innerStart, innerEnd);
    out += renderListItemsForWord(listInner, openTag, tagName === 'ol', depth);
    cursor = afterClose;
  }

  return out;
}

function renderListItemsForWord(
  listInner: string,
  listOpenTag: string,
  isOrdered: boolean,
  depth: number,
): string {
  const startMatch = listOpenTag.match(/\bstart\s*=\s*["']?(\d+)/i);
  let counter = startMatch ? parseInt(startMatch[1], 10) : 1;
  if (!Number.isFinite(counter) || counter < 1) counter = 1;

  const indentPt = (depth + 1) * 24;
  const firstStyle = `margin:3pt 0 3pt ${indentPt}pt;text-indent:-18pt;`;
  const contStyle = `margin:3pt 0 3pt ${indentPt}pt;`;

  const paragraphs: string[] = [];

  replaceBalancedElement(listInner, 'li', /<li\b[^>]*>/i, (liInner, liOpenTag) => {
    const valMatch = liOpenTag.match(/\bvalue\s*=\s*["']?(\d+)/i);
    if (isOrdered && valMatch) {
      const v = parseInt(valMatch[1], 10);
      if (Number.isFinite(v) && v >= 1) counter = v;
    }
    const itemIndex = counter++;
    const isTask = /\btask-list-item\b/i.test(liOpenTag);

    // Extract nested <ol> / <ul> blocks with placeholders so we can process
    // this item's own text lines first and emit nested lists in position.
    const nestedBlocks: string[] = [];
    const withPlaceholders = replaceNestedListsWithPlaceholders(liInner, (subHtml) => {
      const idx = nestedBlocks.length;
      nestedBlocks.push(convertListsForWord(subHtml, depth + 1));
      return `\u0000NESTED_LIST_${idx}\u0000`;
    });

    // Unwrap <p>...</p> into <br>-separated segments, then split on <br>
    const unwrapped = withPlaceholders
      .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, '$1<br>')
      .replace(/(?:<br\s*\/?>\s*)+$/i, '');

    const rawLines = unwrapped.split(/<br\s*\/?>/i);
    let emittedFirst = false;

    for (const rawLine of rawLines) {
      // Split out any nested list placeholders embedded in this segment
      const parts = rawLine.split(/(\u0000NESTED_LIST_\d+\u0000)/);
      for (const part of parts) {
        const phMatch = /^\u0000NESTED_LIST_(\d+)\u0000$/.exec(part);
        if (phMatch) {
          paragraphs.push(nestedBlocks[parseInt(phMatch[1], 10)]);
          continue;
        }
        const trimmed = part.trim();
        if (!trimmed) continue;
        if (!emittedFirst) {
          emittedFirst = true;
          const hasBallot = /^[☑☐]\s/.test(trimmed);
          const marker = isTask || hasBallot
            ? ''
            : isOrdered
            ? formatOrderedMarker(itemIndex, depth)
            : formatBulletMarker(depth);
          paragraphs.push(
            `<p class="word-list-item" data-list-type="${isOrdered ? 'ol' : 'ul'}" data-list-start="${itemIndex}" style="${firstStyle}">${marker}${trimmed}</p>`,
          );
        } else {
          paragraphs.push(
            `<p class="word-list-cont" style="${contStyle}">${trimmed}</p>`,
          );
        }
      }
    }

    return '';
  });

  return paragraphs.join('\n');
}

function replaceNestedListsWithPlaceholders(
  html: string,
  onSublist: (subHtml: string) => string,
): string {
  const listOpenRe = /<(ol|ul)\b[^>]*>/gi;
  let out = '';
  let cursor = 0;

  while (cursor < html.length) {
    listOpenRe.lastIndex = cursor;
    const match = listOpenRe.exec(html);
    if (!match) {
      out += html.slice(cursor);
      break;
    }

    const tagName = match[1].toLowerCase();
    const startIdx = match.index;
    const openTag = match[0];
    const innerStart = startIdx + openTag.length;

    const openAnyRe = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
    const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi');
    let nest = 1;
    let scanPos = innerStart;
    let afterClose = -1;

    while (nest > 0 && scanPos < html.length) {
      openAnyRe.lastIndex = scanPos;
      closeRe.lastIndex = scanPos;
      const nextOpen = openAnyRe.exec(html);
      const nextClose = closeRe.exec(html);
      if (!nextClose) break;
      if (nextOpen && nextOpen.index < nextClose.index) {
        if (!nextOpen[0].endsWith('/>')) nest++;
        scanPos = nextOpen.index + nextOpen[0].length;
      } else {
        nest--;
        if (nest === 0) {
          afterClose = nextClose.index + nextClose[0].length;
        } else {
          scanPos = nextClose.index + nextClose[0].length;
        }
      }
    }

    if (afterClose < 0) {
      out += html.slice(cursor);
      break;
    }

    out += html.slice(cursor, startIdx);
    out += onSublist(html.slice(startIdx, afterClose));
    cursor = afterClose;
  }

  return out;
}

export function buildWordClipboardHtml(rawHtml: string): string {
  if (!rawHtml) return '';

  let html = styleTablesForWord(rawHtml);

  // 1. Strip interactive toolbar / header chrome inside code blocks & heading anchors.
  html = replaceBalancedElement(
    html,
    'div',
    /<div\b[^>]*\bclass="[^"]*\bcode-block__header\b[^"]*"[^>]*>/i,
    () => '',
  );
  html = replaceBalancedElement(
    html,
    'button',
    /<button\b[^>]*\bclass="[^"]*\b(?:code-block__copy|code-copy-button)\b[^"]*"[^>]*>/i,
    () => '',
  );
  html = replaceBalancedElement(
    html,
    'a',
    /<a\b[^>]*\bclass="[^"]*\bheading-anchor\b[^"]*"[^>]*>/i,
    () => '',
  );

  // 2. KaTeX: strip `.katex-html` visual spans and promote `<math>` so Word
  //    converts MathML into native Office Math without duplicating text.
  html = replaceBalancedElement(
    html,
    'span',
    /<span\b[^>]*\bclass="[^"]*\bkatex-display\b[^"]*"[^>]*>/i,
    (inner) => {
      const mathMatch = inner.match(/<math\b[\s\S]*?<\/math>/i);
      if (mathMatch) {
        const math = ensureMathMlAttrs(mathMatch[0], true);
        return `<p align="center" style="text-align:center;margin:8pt 0;">${math}</p>`;
      }
      return replaceBalancedElement(
        inner,
        'span',
        /<span\b[^>]*\bclass="[^"]*\bkatex-html\b[^"]*"[^>]*>/i,
        () => '',
      );
    },
  );

  html = replaceBalancedElement(
    html,
    'span',
    /<span\b[^>]*\bclass="[^"]*\bkatex\b[^"]*"[^>]*>/i,
    (inner) => {
      const mathMatch = inner.match(/<math\b[\s\S]*?<\/math>/i);
      if (mathMatch) {
        return ensureMathMlAttrs(mathMatch[0], false);
      }
      return replaceBalancedElement(
        inner,
        'span',
        /<span\b[^>]*\bclass="[^"]*\bkatex-html\b[^"]*"[^>]*>/i,
        () => '',
      );
    },
  );

  // 3. Fenced code blocks: remove `.cb-ln` line numbers and join `.cb-line`
  //    spans with explicit `<br>` line breaks so Word preserves line breaks.
  html = replaceBalancedElement(html, 'pre', /<pre\b[^>]*>/i, (preInner) => {
    let cleaned = replaceBalancedElement(
      preInner,
      'span',
      /<span\b[^>]*\bclass="[^"]*\bcb-ln\b[^"]*"[^>]*>/i,
      () => '',
    );

    const lines: string[] = [];
    replaceBalancedElement(
      cleaned,
      'span',
      /<span\b[^>]*\bclass="[^"]*\bcb-line\b[^"]*"[^>]*>/i,
      (lineInner) => {
        lines.push(lineInner);
        return '';
      },
    );

    if (lines.length > 0) {
      const joined = lines.join('<br>');
      if (/<code\b[^>]*>/i.test(cleaned)) {
        cleaned = replaceBalancedElement(
          cleaned,
          'code',
          /<code\b[^>]*>/i,
          (_codeInner, codeOpen) => `${codeOpen}${joined}</code>`,
        );
      } else {
        cleaned = joined;
      }
    }

    const preStyle =
      'background:#f3efe7;color:#1f1d1a;border:1px solid #e6e2d8;border-left:3pt solid #ff9f40;padding:8pt 10pt;font-family:"JetBrains Mono",Consolas,"Courier New",monospace;font-size:10pt;line-height:1.45;white-space:pre-wrap;word-break:break-word;margin:8pt 0;';
    return `<pre style="${preStyle}">${cleaned}</pre>`;
  });

  // 4. Task-list checkboxes -> plain Unicode ballot boxes (`☑` / `☐`).
  html = html.replace(/<input\b[^>]*\btype=["']checkbox["'][^>]*>/gi, (tag) =>
    /\bchecked\b/i.test(tag) ? '☑ ' : '☐ ',
  );

  // 5. Ordered & bullet lists (#427, #432): convert `<ol>` / `<ul>` into
  //    explicit hanging-indent `<p>` paragraphs matching `docx-export.ts` so
  //    Word never pushes numbers outside the left border or scrambles `（1）（2）`
  //    continuation lines.
  html = convertListsForWord(html, 0);

  // 6. Split `<br>` before parenthesized list lines (`（1）`, `(1)`, `①`) in
  //    regular paragraphs into separate `<p>` paragraphs so Word formats each
  //    numbered sub-clause cleanly.
  html = replaceBalancedElement(html, 'p', /<p\b[^>]*>/i, (pInner, pOpen) => {
    if (!/<br\s*\/?>/i.test(pInner)) return `${pOpen}${pInner}</p>`;
    const segments = pInner.split(/<br\s*\/?>/i);
    if (
      segments.length > 1 &&
      segments.some((s) => /^\s*(?:[（(]\d+[)）]|[①-⑳])/.test(s.replace(/<[^>]+>/g, '')))
    ) {
      return segments
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => `${pOpen}${s}</p>`)
        .join('\n');
    }
    return `${pOpen}${pInner}</p>`;
  });

  return wrapWordDocument(html);
}

function wrapWordDocument(fragmentHtml: string): string {
  return [
    '<!DOCTYPE html>',
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns:m="http://schemas.microsoft.com/office/2004/12/omml">',
    '<head>',
    '<meta charset="utf-8">',
    `<style>${WORD_BASE_CSS}</style>`,
    '</head>',
    '<body>',
    '<!--StartFragment-->',
    fragmentHtml,
    '<!--EndFragment-->',
    '</body>',
    '</html>',
  ].join('\n');
}
