/**
 * Pure geometry for the Agent panel's bottom dock.
 *
 * Stored heights and the rendered height differ: CSS caps the dock at 70% of
 * the viewport, so a height saved on a taller window must not be used as the
 * origin of a resize drag or the handle goes dead until the drag crosses the
 * cap. These helpers keep the math testable outside the component.
 */

export const AGENT_DOCK_MIN = 160;
export const AGENT_DOCK_MAX = 2000;
export const AGENT_DOCK_DEFAULT = 320;

/** Persisted value: finite, rounded, 160..2000; garbage falls back to 320. */
export function clampStoredDockHeight(px: unknown): number {
  // `Number(null)` is 0 and `Number(true)` is 1 — missing/garbage must not
  // silently become a real height.
  if (typeof px !== 'number' && typeof px !== 'string') return AGENT_DOCK_DEFAULT;
  if (typeof px === 'string' && px.trim() === '') return AGENT_DOCK_DEFAULT;
  const n = Number(px);
  if (!Number.isFinite(n)) return AGENT_DOCK_DEFAULT;
  return Math.max(AGENT_DOCK_MIN, Math.min(AGENT_DOCK_MAX, Math.round(n)));
}

/** Largest height the drag may produce on this viewport (70%, never below min). */
export function dockHeightCap(viewportHeight: number): number {
  return Math.max(AGENT_DOCK_MIN, Math.round(viewportHeight * 0.7));
}

/** What the user actually sees — the origin a resize drag must start from. */
export function resizeOriginHeight(stored: number, viewportHeight: number): number {
  return Math.min(clampStoredDockHeight(stored), dockHeightCap(viewportHeight));
}

/** Drag result: up (negative deltaY) = taller, clamped to the viewport cap. */
export function nextDockHeight(
  origin: number,
  deltaY: number,
  viewportHeight: number,
): number {
  const next = origin - deltaY;
  return Math.max(AGENT_DOCK_MIN, Math.min(next, dockHeightCap(viewportHeight)));
}

/** The sidebar may be configured on the left; the drop zone follows it. */
export function sidebarDropSide(outlineSide: 'left' | 'right'): 'left' | 'right' {
  return outlineSide === 'left' ? 'left' : 'right';
}
