export type Language = 'markdown' | 'plaintext';
// `liveEdit` (v2.3) renders markdown formatting inline inside the editor —
// Typora / Obsidian Live Preview style. The editor IS the only pane in
// this mode; there is no separate preview column.
//
// `reading` (v2.4) is a full-bleed serif preview without any editor chrome:
// no toolbar, no file tree, no status bar — just the centered prose, like
// a book page. Toggled via Cmd+Shift+R / the toolbar's view-mode cycle,
// auto-applies on iOS when the `readingByDefaultOnMobile` setting is on.
export type ViewMode = 'edit' | 'preview' | 'split' | 'liveEdit' | 'reading';
export type Theme =
  | 'light'
  | 'dark'
  | 'nord'
  | 'solarized-light'
  | 'solarized-dark'
  | 'monokai'
  | 'github-light'
  | 'dracula';

export interface Tab {
  id: string;
  filePath?: string;
  fileName: string;
  content: string;
  savedContent: string;
  encoding: string;
  language: Language;
  hadBom: boolean;
  // Line-ending of the file on disk. CodeMirror normalizes everything to
  // LF internally, so we track the original here and re-apply on save —
  // otherwise a Windows file (CRLF) would silently become LF the moment
  // the user touches the editor (and the dirty flag would lock in even
  // without edits because content drifts from savedContent).
  lineEnding?: 'lf' | 'crlf';
  showOutline?: boolean;

  // Embedded browser tab (知识检索入口). Absent (undefined) means an ordinary
  // file tab — every persisted tab from an older build therefore migrates
  // correctly with no data change. See lib/tab-kind.ts for why the check is
  // centralised rather than inlined at the four call sites that need it.
  //
  // A browser tab is never dirty (both content fields stay empty), never has
  // a filePath, and is never written to disk. The editor path is bypassed for
  // it in PaneContent.vue, and the save / close / workspace-switch paths in
  // lib/browser-tab-guards.ts.
  kind?: 'file' | 'browser';
  /** Browser tabs only: the address currently loaded. */
  url?: string;
  /** Browser tabs only: absolute directory the capture writes into. */
  captureDir?: string;
  /**
   * Browser tabs only: where this tab's **引用页** go, decided when the tab is
   * opened (see `newBrowserTab`).
   *
   * `captureDir` 是"这次研究的目录"（对话笔记落这里），引用页落在哪一层
   * 取决于场景：关联链接（反链）是"给这篇笔记收一批引用"，收在 `D/refs/`
   * 免得几十篇引用页把笔记目录淹掉；打开浏览器读当前文档原文是"给这篇
   * 文档留一份"，就该落在文档自己的目录。两者不共用 `captureDir`，因为
   * 同一个 tab 的对话和引用页本来就该落在不同层。
   *
   * 会话恢复出来的老 tab 没有这个字段，读的时候回退到 `<captureDir>/refs`
   * —— 那正是老版本的行为。
   */
  refsDir?: string;
  /**
   * Browser tabs only: the note this tab was opened from ("关联链接" panel).
   * Carried so that capturing the page from the browser toolbar still writes
   * the `[[wikilink]]` back to that note — the panel's own capture button
   * passes the same value, and without it the same capture through the
   * browser would quietly lose the backlink.
   */
  sourceTitle?: string;
}

export interface FileReadResult {
  content: string;
  encoding: string;
  language: Language;
  had_bom: boolean;
}

// ---- Tile layout (split editor) ----

export type SplitDirection = 'horizontal' | 'vertical';

export interface TileLeaf {
  type: 'leaf';
  id: string;
  activeTabId: string;
}

export interface TileBranch {
  type: 'branch';
  id: string;
  direction: SplitDirection;
  sizes: [number, number]; // percentages summing to 100
  children: [TileNode, TileNode];
}

export type TileNode = TileLeaf | TileBranch;
