/**
 * Keep the webview's own right-click menu out of the app chrome.
 *
 * WebView2 (and WebKit in some builds) shows a browser menu — Back, Reload,
 * Save as, Print — on any right-click nobody handled: menu bar, toolbar, tab
 * strip, status bar, sidebar blanks, preview, reading view, slideshow. In a
 * desktop app that menu is wrong at best, and "Reload" throws away unsaved
 * state. Components that offer a menu of their own (editor, file tree, tabs,
 * sidebar) call preventDefault in their handlers, which bubble before this
 * document-level listener runs.
 *
 * The system menu is still wanted where it does real work, so it is let
 * through for:
 *  - editable targets (inputs, textareas, contenteditable, CodeMirror):
 *    Cut / Copy / Paste and spelling suggestions;
 *  - a non-empty page selection (e.g. copying from the preview);
 *  - images (Copy image).
 * Touch / pen presses and phones are left alone — long-press selection
 * menus come through `contextmenu` there too.
 */

const KEEP_NATIVE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], .cm-editor, img';

export function shouldSuppressNativeMenu(event: MouseEvent, selectionText: string): boolean {
  if (event.defaultPrevented) return false;
  const pointer = (event as PointerEvent).pointerType;
  if (pointer === 'touch' || pointer === 'pen') return false;
  const target = event.target as Element | null;
  const el = target && (target.nodeType === 1 ? target : (target as Node).parentElement);
  if (el && typeof el.closest === 'function' && el.closest(KEEP_NATIVE)) return false;
  if (selectionText.trim()) return false;
  return true;
}

export function installNativeMenuGuard(opts: { mobile: boolean; dev: boolean }): void {
  // Dev builds keep the menu for "Inspect".
  if (opts.mobile || opts.dev) return;
  document.addEventListener('contextmenu', (event) => {
    const text = window.getSelection()?.toString() ?? '';
    if (shouldSuppressNativeMenu(event, text)) event.preventDefault();
  });
}
