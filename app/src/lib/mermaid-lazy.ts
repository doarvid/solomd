/**
 * Mermaid, loaded the first time a diagram actually needs rendering.
 *
 * It used to be a static import in five modules, which put its ~1 MB of
 * parser and renderer into the entry chunk — paid on every cold start, by
 * every user, including the ones whose notes contain no diagrams at all.
 * Windows felt it worst: WebView2 has to compile the whole entry chunk
 * before the first paint.
 *
 * `initialize` is still last-call-wins on a single shared instance, exactly
 * as it was when each module reached for the singleton directly.
 *
 * Rendering always goes through `safeRender` below. Left to itself, mermaid
 * draws its "Syntax error in text" bomb into a `<div id="d<id>">` appended to
 * `document.body` and, on a parse error, throws *before* removing it. That
 * stray node sat under the app shell for good: the next scroll-into-view
 * scrolled `<body>` and pushed the tab bar and toolbar off-screen until a
 * restart. Every caller already shows its own inline error, so mermaid is
 * told never to render one (`suppressErrorRendering`), it draws into a
 * throw-away off-screen host we own, and whatever it leaves behind is
 * removed whether the render succeeded or not.
 */
import type mermaidNS from 'mermaid';

type Mermaid = typeof mermaidNS;
type MermaidConfig = Parameters<Mermaid['initialize']>[0];
type RenderResult = Awaited<ReturnType<Mermaid['render']>>;

/** The only part of mermaid our callers use, made safe to fail. */
export interface SafeMermaid {
  render(id: string, code: string): Promise<RenderResult>;
}

/** The subset of mermaid that `safeRender` drives (lets tests pass a fake). */
export interface MermaidRenderer {
  render(id: string, code: string, container?: Element): Promise<RenderResult>;
}

let loading: Promise<Mermaid> | null = null;
let renderSeq = 0;

export function loadMermaid(): Promise<Mermaid> {
  if (!loading) loading = import('mermaid').then((m) => m.default);
  return loading;
}

/** Remove every temporary node mermaid may have created for `id`. */
export function removeMermaidLeftovers(id: string, doc: Document = document): void {
  for (const tmp of [`d${id}`, `i${id}`]) {
    doc.getElementById(tmp)?.remove();
  }
  // A bare `<svg id="<id>">` directly under <body> is a leftover too.
  // Rendered output lives in our own wrappers (`.mermaid-block` etc.).
  const svg = doc.getElementById(id);
  if (svg && svg.parentElement === doc.body) svg.remove();
}

/**
 * #276 — Mermaid v11 treats `@` inside an unquoted `[...]` label as the new
 * `A@{ shape: ... }` syntax and `(` / `)` as a nested shape delimiter, failing
 * with an inscrutable parser error. Wrapping those unquoted labels in `"..."`
 * restores the Mermaid v10 behaviour users expect.
 */
const UNQUOTED_BRACKET_LABEL_RE = /([^\s\[>-]\s*\[)(?!["\[/\\()])([^\]\n]*[@()][^\]\n]*)(\])/g;

export function quoteUnquotedMermaidLabels(code: string): string {
  return code.replace(UNQUOTED_BRACKET_LABEL_RE, (_m, open: string, body: string, close: string) => {
    const escaped = body.replace(/"/g, '&quot;');
    return `${open}"${escaped}"${close}`;
  });
}

export function formatMermaidError(err: unknown, code?: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  if (code && /\[[^\]"\n]*[@()][^\]"\n]*\]/.test(code) && !raw.includes('A["')) {
    return `${raw}\nHint: Wrap node labels containing "@" or "()" in quotes, e.g. A["label @ info"]`;
  }
  return raw;
}

/**
 * Render into a host that is in the document (mermaid measures text with
 * getBBox, which needs layout) but out of flow and invisible, then drop it.
 */
export async function safeRender(
  mermaid: MermaidRenderer,
  id: string,
  code: string,
  doc: Document = document,
): Promise<RenderResult> {
  // Callers number their ids per component, so two split panes previewing
  // the same note both asked for `mmd-1` at once: the first render's cleanup
  // then removed the second one's work-in-progress `#dmmd-1` and it failed
  // with "element.firstChild is null". A page-wide suffix keeps every render
  // (and the `#id` selectors inside its SVG) distinct.
  const renderId = `${id}-r${++renderSeq}`;
  const host = doc.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.setAttribute('data-mermaid-scratch', '1');
  const width = Math.max(320, doc.body?.clientWidth || 1000);
  host.setAttribute(
    'style',
    `position:fixed;left:-100000px;top:0;width:${width}px;` +
      'visibility:hidden;pointer-events:none;overflow:hidden;',
  );
  doc.body.appendChild(host);
  try {
    return await mermaid.render(renderId, code, host);
  } catch (firstErr) {
    // #276 — if the diagram failed to parse and contains unquoted `@` or `()`
    // inside `[...]` node labels, retry once with those labels quoted.
    const quoted = quoteUnquotedMermaidLabels(code);
    if (quoted !== code) {
      removeMermaidLeftovers(renderId, doc);
      host.innerHTML = '';
      const retryId = `${id}-r${++renderSeq}`;
      try {
        return await mermaid.render(retryId, quoted, host);
      } catch {
        removeMermaidLeftovers(retryId, doc);
      }
    }
    const msg = formatMermaidError(firstErr, code);
    if (firstErr instanceof Error && msg !== firstErr.message) {
      firstErr.message = msg;
    }
    throw firstErr instanceof Error ? firstErr : new Error(msg);
  } finally {
    host.remove();
    removeMermaidLeftovers(renderId, doc);
  }
}

/** Load (once) and configure. Callers are all async already. */
export async function initMermaid(config: MermaidConfig): Promise<SafeMermaid> {
  const mermaid = await loadMermaid();
  mermaid.initialize({ ...config, suppressErrorRendering: true });
  return { render: (id, code) => safeRender(mermaid, id, code) };
}

/**
 * #462 — Wire Mermaid interactive tooltips & click callbacks on a rendered
 * diagram container, and ensure SVG nodes with `[title]` attributes also have
 * a native `<svg:title>` child so browser hover tooltips work reliably across
 * all diagram types and security levels.
 */
export function bindMermaidInteractions(
  container: Element,
  bindFunctions?: ((el: Element) => void) | null,
): void {
  try {
    bindFunctions?.(container);
  } catch {
    /* ignore d3 binding errors on detached/partial nodes */
  }
  const doc = container.ownerDocument ?? document;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  for (const el of Array.from(container.querySelectorAll('[title]'))) {
    const tip = el.getAttribute('title')?.trim();
    if (!tip) continue;
    const hasTitleChild = Array.from(el.children).some(
      (c) => c.tagName.toLowerCase() === 'title',
    );
    if (!hasTitleChild) {
      const titleEl = doc.createElementNS(SVG_NS, 'title');
      titleEl.textContent = tip;
      el.insertBefore(titleEl, el.firstChild);
    }
  }
}
