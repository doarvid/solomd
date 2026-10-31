/**
 * What a click on a rendered Markdown link does — shared by the preview and
 * the Windows live-edit blocks, so neither can ever let the webview follow
 * the link itself. Following it replaced the whole SoloMD UI with the web
 * page (and on Windows left no way out but right-click → Back).
 *
 *   - wikilink            → resolved in-app (`solomd:wiki-open`)
 *   - `#heading`          → left to the browser (in-page jump)
 *   - http(s) / mailto    → the system browser
 *   - a relative path     → opened against the current file (`openLinkedFile`)
 */
import { openUrl } from '@tauri-apps/plugin-opener';
import { useFiles } from '../composables/useFiles';

/**
 * Handle a click that landed on (or inside) `anchor`. Returns true when the
 * click was consumed — the caller's event has been prevented.
 */
export function openRenderedLink(anchor: Element, e: Event, filePath?: string | null): boolean {
  // Wikilink (F1, v2.0): intercept and dispatch resolution to App.vue.
  if (anchor.classList.contains('md-wikilink')) {
    const target = anchor.getAttribute('data-wikilink-target') || '';
    if (!target) return false;
    e.preventDefault();
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent('solomd:wiki-open', { detail: { target } }));
    return true;
  }
  const href =
    anchor.getAttribute('href') ||
    anchor.getAttribute('xlink:href') ||
    anchor.getAttributeNS?.('http://www.w3.org/1999/xlink', 'href') ||
    null;
  if (!href) return false;
  // Allow in-page anchor jumps (#heading)
  if (href.startsWith('#')) return false;
  e.preventDefault();
  e.stopPropagation();
  // External URL: open in system browser
  if (/^(https?|mailto|tel):/i.test(href)) {
    openUrl(href).catch((err) => {
      console.warn('[link] openUrl failed:', href, err);
    });
    return true;
  }
  // Relative path: resolve against current file's directory. #163-followup —
  // route through openLinkedFile so a link to a PDF / Office / etc. opens with
  // the OS default app (when openLinkedFilesExternally is on) instead of being
  // converted to Markdown; md / text / images still open in-app.
  if (filePath) {
    const resolved = resolveRelativePath(filePath, href);
    useFiles().openLinkedFile(resolved, { bypassNewWindow: true }).catch((err) => {
      console.warn('[link] openLinkedFile failed:', resolved, err);
    });
  }
  return true;
}

/**
 * #116 — resolve a relative markdown link against the current file's path.
 * Robust to (a) Windows back-slash separators, (b) percent-encoded hrefs
 * (CJK filenames / spaces are URL-encoded by the renderer), and (c) `../` /
 * `./` traversal. The result is emitted in the base path's separator style so
 * the Rust side opens it on every platform.
 */
export function resolveRelativePath(basePath: string, href: string): string {
  // Strip any #fragment / ?query the anchor may carry, then decode.
  let rel = href.replace(/[#?].*$/, '');
  try {
    rel = decodeURIComponent(rel);
  } catch {
    /* malformed encoding — fall back to the raw href */
  }
  const winStyle = basePath.includes('\\') && !basePath.includes('/');
  const sepCh = winStyle ? '\\' : '/';
  // #138 — a UNC path (`\\server\share\…`, or WSL's `\\wsl$\Ubuntu\…` /
  // `\\wsl.localhost\…`) starts with a DOUBLE separator. Splitting on
  // `[\\/]+` collapses that pair into one match, so a naive join emits a
  // single leading `\` — an invalid path that Rust's `fs::read` rejects with
  // os error 3. Detect it and restore the second leading separator.
  const isUnc = /^[\\/]{2}/.test(basePath);
  // Directory segments of the current file (drop the file name itself).
  const segs = basePath.split(/[\\/]+/);
  segs.pop();
  for (const part of rel.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segs.length > 1) segs.pop();
      continue;
    }
    segs.push(part);
  }
  const joined = segs.join(sepCh);
  return isUnc ? sepCh + joined : joined;
}
