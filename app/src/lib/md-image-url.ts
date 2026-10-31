/**
 * Make a local image path safe to use as a Markdown link destination.
 *
 * CommonMark does not allow spaces in a bare destination, so
 * `![](D:/Program Files/img.png)` is not an image at all: markdown-it renders
 * the whole thing as literal text (#345). The same happens with an unbalanced
 * `(` or `)`. Every image SoloMD writes into a note — pasted, dropped,
 * uploaded-with-local-fallback, or inserted from a file picker — goes through
 * this function, so an image folder under "Program Files", a note called
 * "My Note" (→ `My Note.assets/`), or a Windows user name with a space all
 * produce links that render.
 *
 * Percent-encoding rather than `<...>`: the rendered `src` is identical either
 * way, but the live-edit image-line detector and other editors (Typora writes
 * `%20` too) only understand the encoded form. Every place that turns a
 * rendered `src` back into a file path decodes it exactly once
 * (`image-resolve.ts`), which is why `%` itself is encoded as well: a file
 * literally named `100%.png` must come back as `100%.png`, not be mangled by
 * that decode.
 *
 * Only characters that break the destination are touched; letters, CJK and
 * `/` stay readable. A remote URL is already URL-encoded, so only its
 * whitespace is touched (an image host can hand back a key with a space in it).
 */
export function encodeImageDestination(path: string): string {
  if (/^(https?|data|blob|asset|tauri):/i.test(path)) return path.replace(/\s/g, '%20');
  return path
    .replace(/%/g, '%25')
    .replace(/\s/g, (c) => (c === ' ' ? '%20' : encodeURIComponent(c)))
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E');
}

/** `![alt](path)` with the path made safe by {@link encodeImageDestination}. */
export function markdownImage(path: string, alt = ''): string {
  return `![${alt}](${encodeImageDestination(path)})`;
}

export interface ParsedImageAltSize {
  alt: string;
  width: string | null;
  height: string | null;
}

const ALT_SIZE_RE = /^(.*?)\|\s*(\d{1,4}(?:%|px)?)(?:\s*[x×]\s*(\d{1,4}(?:%|px)?))?\s*$/i;

function normalizeImageDimension(dim: string): string {
  const trimmed = dim.trim();
  return /^\d+$/.test(trimmed) ? `${trimmed}px` : trimmed.toLowerCase();
}

/**
 * #446 — Parse optional Obsidian/Markdown pipe size syntax at the end of an
 * image's alt text: `![alt|50%](url)`, `![|300](url)`, `![alt|400x300](url)`.
 */
export function parseImageAltSize(rawAlt: string): ParsedImageAltSize {
  const m = ALT_SIZE_RE.exec(rawAlt);
  if (!m) {
    return { alt: rawAlt, width: null, height: null };
  }
  return {
    alt: m[1].trimEnd(),
    width: normalizeImageDimension(m[2]),
    height: m[3] ? normalizeImageDimension(m[3]) : null,
  };
}

const MD_IMAGE_RESIZE_RE = /^(\s*!\[)([^\]]*)(\]\([^\n]+\)\s*)$/;
const HTML_IMG_TAG_RE = /<img\b([^>]*?)(\/?)>/i;

/**
 * #446 — Update the display width of a Markdown image (`![alt](url)` ->
 * `![alt|50%](url)`) or HTML `<img ...>` line. Passing `'100%'` or `''`
 * restores the natural/default 100% size by removing the size override.
 * Returns the updated line text, or `null` if the line is not an image line.
 */
export function resizeMarkdownImageLine(line: string, size: string): string | null {
  const normalizedSize = size.trim();
  const isReset = !normalizedSize || normalizedSize === '100%';
  const mdMatch = MD_IMAGE_RESIZE_RE.exec(line);
  if (mdMatch) {
    const baseAlt = parseImageAltSize(mdMatch[2]).alt;
    const nextAlt = isReset
      ? baseAlt
      : baseAlt
        ? `${baseAlt}|${normalizedSize}`
        : `|${normalizedSize}`;
    return `${mdMatch[1]}${nextAlt}${mdMatch[3]}`;
  }

  const htmlMatch = HTML_IMG_TAG_RE.exec(line);
  if (htmlMatch) {
    let attrs = htmlMatch[1]
      .replace(/\s+width\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s+height\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    if (/\bstyle\s*=\s*"([^"]*)"/i.test(attrs)) {
      attrs = attrs.replace(/\bstyle\s*=\s*"([^"]*)"/i, (_m, styleBody: string) => {
        const cleaned = styleBody
          .replace(/(?:^|;)\s*(?:width|height|zoom)\s*:[^;]*/gi, '')
          .replace(/^;\s*|\s*;$/g, '')
          .trim();
        if (isReset) return cleaned ? `style="${cleaned}"` : '';
        const dim = normalizeImageDimension(normalizedSize);
        return `style="${cleaned ? `${cleaned}; ` : ''}width: ${dim};"`;
      });
    } else if (!isReset) {
      const dim = normalizeImageDimension(normalizedSize);
      attrs = `${attrs.trimEnd()} width="${dim.endsWith('px') ? dim.slice(0, -2) : dim}" style="width: ${dim};"`;
    }
    const cleanAttrs = attrs.replace(/\s{2,}/g, ' ').trim();
    const selfClose = htmlMatch[2] ? ' /' : '';
    return line.replace(
      HTML_IMG_TAG_RE,
      `<img${cleanAttrs ? ` ${cleanAttrs}` : ''}${selfClose}>`,
    );
  }

  return null;
}

