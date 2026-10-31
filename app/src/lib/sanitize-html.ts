/**
 * HTML sanitizer for everything we render out of Markdown (#304).
 *
 * WHY THIS EXISTS
 * ---------------
 * `md` is configured with `html: true` because people legitimately embed
 * inline HTML in notes (`<details>`, `<sub>`, `<img style="zoom:50%">`, raw
 * `<table>` blocks emitted by PDF→Markdown tools). That also means a *note we
 * did not write* — a shared vault, a file downloaded from the internet, a note
 * synced from a colleague — can smuggle `<script>` / `onerror=` / `javascript:`
 * into the rendered HTML, which the preview injects with `innerHTML`.
 *
 * In a browser that would be plain XSS. Inside the Tauri webview it is worse:
 * the page has `window.__TAURI_INTERNALS__.invoke`, so script running here can
 * call the app's own Rust commands — read and write arbitrary files, run the
 * image-upload shell command template, exfiltrate AI keys. "Open someone
 * else's .md" must not be equivalent to "run their code", so every string that
 * reaches `innerHTML` / `v-html` goes through `sanitizeRenderedHtml()` first.
 *
 * Defence in depth: the CSP in `src-tauri/tauri.conf.json` blocks inline
 * script even if a mutation-XSS trick slips past this sanitizer.
 *
 * WHAT MUST SURVIVE
 * -----------------
 * The sanitizer sees our *own* generated markup too, so it is configured to
 * keep it byte-for-byte usable:
 *   • KaTeX  — `<span class="katex">` + a MathML subtree
 *              (`<math><semantics>…<annotation encoding="application/x-tex">`).
 *              `semantics` / `annotation` are NOT in DOMPurify's default
 *              MathML allow-list, so they are added back explicitly.
 *              `annotation-xml` is deliberately NOT added: it is an HTML
 *              integration point and a classic mXSS vector.
 *   • mermaid / tldraw — the fence stays `<pre><code class="language-mermaid">`
 *              so the post-processors still find it; the SVG that mermaid
 *              produces is injected afterwards (mermaid runs with
 *              `securityLevel: 'strict'`, i.e. its own DOMPurify pass).
 *              Inline `<svg>` written by hand is kept too, but without
 *              `<script>`, `<use>`, `<foreignObject>` or animation elements.
 *   • highlight.js — `<span class="hljs-keyword">` and our `<span class="cb-line">`
 *              wrappers: `class` is allowed.
 *   • our plumbing — `data-source-line`, `data-line`, `data-wikilink-target`,
 *              `id` anchors from markdown-it-anchor / footnotes.
 */

import DOMPurify, { type Config, type DOMPurify as DOMPurifyInstance } from 'dompurify';

/**
 * Extends DOMPurify's default URI allow-list with the schemes this app
 * actually resolves. Local images/links are rewritten to `asset:` /
 * `http://asset.localhost` / `file://` AFTER rendering (see `image-resolve.ts`),
 * but users also type `file:///…` and Windows drive paths (`C:\pics\a.png`)
 * straight into Markdown, and those must not be scrubbed.
 *
 * The important part is what stays out: `javascript:`, `vbscript:` and
 * `data:text/html` never match, so `<a href="javascript:…">` loses its href.
 */
const ALLOWED_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|asset|tauri|file):|[a-z]:[\\/]|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

/** Attributes we must add on top of the html/svg/mathMl profiles. */
const EXTRA_ATTRS = [
  // KaTeX MathML
  'encoding',
  'xmlns',
  // <a target="_blank"> written by hand
  'target',
  // iframe embeds (see the hook below)
  'allow',
  'allowfullscreen',
  'frameborder',
  'scrolling',
  'sandbox',
  'referrerpolicy',
];

const PURIFY_CONFIG: Config = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  // `semantics` / `annotation`: KaTeX MathML (see header comment).
  // `iframe`: video embeds are a long-standing Markdown habit; the hook below
  // restricts them to remote http(s) documents inside a sandbox.
  ADD_TAGS: ['semantics', 'annotation', 'iframe'],
  ADD_ATTR: EXTRA_ATTRS,
  ALLOWED_URI_REGEXP,
  // Never allow these, whatever a profile says.
  FORBID_TAGS: ['script', 'noscript', 'object', 'embed', 'base', 'meta', 'link', 'form'],
  // `srcdoc` is an iframe's own HTML document — it would re-introduce
  // everything we just stripped. `ping`, `formaction` are request-forgery.
  FORBID_ATTR: ['srcdoc', 'ping', 'formaction', 'form'],
  // Keep `<div>`-ish wrappers; we only ever want the body fragment back.
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
};

/** Lazily-created private DOMPurify instance.
 *
 *  Private on purpose: mermaid bundles DOMPurify too and, with a single
 *  hoisted copy, `addHook` on the shared default instance would also fire
 *  inside mermaid's own sanitize pass. `DOMPurify(window)` mints an isolated
 *  instance whose hooks are ours alone. */
let purifier: DOMPurifyInstance | null = null;

function getPurifier(): DOMPurifyInstance | null {
  if (purifier) return purifier;
  if (typeof window === 'undefined' || typeof window.document === 'undefined') return null;
  const instance = DOMPurify(window);
  if (!instance.isSupported) return null;

  instance.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (typeof el.getAttribute !== 'function') return;

    // Belt and braces: DOMPurify's allow-lists contain no `on*` attribute, but
    // this is the single class of attribute that turns markup into code, so we
    // re-check it explicitly instead of trusting one list.
    for (const attr of Array.from(el.attributes || [])) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }

    const tag = el.tagName?.toLowerCase();

    if (tag === 'iframe') {
      // Only remote documents, never `file:`/`asset:`/`tauri:` — an iframe of
      // a same-origin app URL would get the webview's IPC surface back.
      const src = el.getAttribute('src') || '';
      if (!/^https?:\/\//i.test(src)) {
        el.remove();
        return;
      }
      // Cross-origin already, but pin it down: no top-level navigation, no
      // downloads, no pointer lock.
      el.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-presentation');
      el.setAttribute('referrerpolicy', 'no-referrer');
    }

    if (tag === 'img') {
      // #493 — prevent WebView2 from sending `Referer: http://tauri.localhost/`
      // to external image hosts (e.g. Gitee) that reject non-matching referrers
      // with HTTP 403.
      el.setAttribute('referrerpolicy', 'no-referrer');
    }

    // `target="_blank"` without `rel` is a reverse-tabnabbing hole.
    if (tag === 'a' && el.getAttribute('target')) {
      el.setAttribute('rel', 'noopener noreferrer');
    }
  });

  purifier = instance;
  return purifier;
}

/**
 * Conservative fallback for DOM-less contexts (node unit tests, the
 * `vite --ssr` probe harness). It is NOT the security boundary — the webview
 * always has a DOM and therefore always takes the DOMPurify path — but it
 * keeps `renderMarkdown()` from handing raw `<script>` to a non-browser caller
 * that pipes the result somewhere else.
 *
 * Attribute scrubbing runs *inside tag matches only*. Doing it over the whole
 * string would eat `onclick=` written inside a fenced code block — markdown-it
 * escapes every `<` that came from text, so anything matching `<tag …>` here is
 * real markup, never code-block content (the code-fidelity tests in
 * `code-block-fidelity.test.ts` exist to keep that promise). The known blind
 * spot is an attribute value containing a literal `>`, which truncates the tag
 * match; DOMPurify has no such limitation, which is why the browser never uses
 * this path.
 */
function fallbackStrip(html: string): string {
  return html
    // Elements whose content must go with them.
    .replace(/<\s*(script|iframe|object|embed|noscript|template)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    // …and any stray opener/closer of the same kinds.
    .replace(/<\s*\/?\s*(script|iframe|object|embed|link|meta|base)\b[^>]*>/gi, '')
    .replace(/<[a-zA-Z][^>]*>/g, (tag) =>
      tag
        // on<event>= handlers, quoted or bare
        .replace(/\son[a-z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        // javascript:/vbscript:/data:text/html targets
        .replace(
          /((?:href|src|xlink:href|action|formaction|background|poster)\s*=\s*)(["']?)\s*(?:javascript|vbscript|data:text\/html)[^"'\s>]*\2/gi,
          '$1$2#$2',
        )
        // #493 — ensure raw HTML <img> tags carry referrerpolicy="no-referrer"
        .replace(/^<img\b(?![^>]*\breferrerpolicy\s*=)/i, '<img referrerpolicy="no-referrer"'),
    );
}

/**
 * Sanitize rendered Markdown HTML before it reaches `innerHTML` / `v-html`.
 * Returns a string that is safe to inject in the app webview.
 */
export function sanitizeRenderedHtml(html: string): string {
  if (!html) return '';
  const instance = getPurifier();
  if (!instance) return fallbackStrip(html);
  return instance.sanitize(html, PURIFY_CONFIG);
}
