/**
 * Dedupe rules for the bookmark → note direction.
 *
 * Kept out of the store so the "did the workspace move?" regressions are
 * testable without Tauri. The important rule: matching is by note title, not
 * by the note's current folder — folder paths change when the user
 * reorganizes, bookmark folder snapshots do not.
 */

export interface DedupeIndex {
  /** Normalized front-matter `url:` of captured notes. */
  capturedUrls: Set<string>;
  /** Normalized URLs already linked from any note body. */
  noteLinkedUrls: Set<string>;
  /** `noteTitleKey()` of every captured note. */
  capturedTitles: Set<string>;
}

export interface BookmarkCandidate {
  title: string;
  normalized_url: string;
}

/** Rough mirror of `capture_store::safe_filename` for dedupe comparisons. */
export function safeStem(title: string): string {
  let s = title
    .replace(/[\x00-\x1f]/g, ' ')
    .replace(/[<>:"/\\|?*]/g, '-');
  s = s.split(/\s+/).filter(Boolean).join(' ');
  s = s.replace(/^[.\-\s]+|[.\-\s]+$/g, '');
  if (s.length > 120) s = s.slice(0, 120).trimEnd();
  return s || 'untitled';
}

/**
 * A mirror bookmark is named `<note stem> · <host>` by the write direction.
 * Return both the full title and the stem-only prefix so a note can be
 * recognised whether or not the suffix survived.
 */
export function titleKeys(title: string): string[] {
  const keys = new Set<string>([safeStem(title).toLowerCase()]);
  const cut = title.lastIndexOf(' · ');
  if (cut > 0) {
    const tail = title.slice(cut + 3).trim().toLowerCase();
    // Only strip a ` · <host>` suffix, not a separator inside the real title.
    if (/^[a-z0-9.-]+$/.test(tail) && tail.includes('.')) {
      keys.add(safeStem(title.slice(0, cut)).toLowerCase());
    }
  }
  return [...keys];
}

/** Capture suffixes (`-2`, `-3`, …) are dedupe noise. */
export function noteTitleKey(stem: string): string {
  return safeStem(stem.replace(/-\d+$/, '')).toLowerCase();
}

export function shouldCapture(entry: BookmarkCandidate, index: DedupeIndex): boolean {
  if (index.capturedUrls.has(entry.normalized_url)) return false;
  if (index.noteLinkedUrls.has(entry.normalized_url)) return false;
  if (titleKeys(entry.title).some((key) => index.capturedTitles.has(key))) return false;
  return true;
}
