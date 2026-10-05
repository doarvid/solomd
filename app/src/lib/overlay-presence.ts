/**
 * A shared count of how many app-level floating layers are open.
 *
 * Why this exists: a native child webview is a separate OS surface that paints
 * ABOVE the app's HTML. Whenever a menu, popover or modal opens over a pane
 * hosting one, the webview covers it and the menu becomes unusable.
 *
 * App.vue can only see the overlays whose state lives there (command palette,
 * settings, the sidebar menu). Everything else keeps its open/closed state
 * locally — FileTree's context menu, the editor menu, the various popovers —
 * and a component cannot reach into another component's refs. So each such
 * overlay registers itself here and App.vue watches the total.
 *
 * One line to adopt:
 *
 *     useOverlayPresence(computed(() => ctx.value !== null));
 *
 * Prefer this over a per-overlay prop drilled down from App.vue, which would
 * have to be threaded through every intermediate component.
 */
import { computed, onScopeDispose, readonly, ref, watch, type ComputedRef, type Ref } from 'vue';

const depth = ref(0);

/** Open floating layers across the whole app. Read-only; use the composable. */
export const overlayDepth = readonly(depth);

/**
 * Register `isOpen` with the shared count. Cleans up on scope dispose so a
 * component unmounting while its menu is open does not leak a permanent +1
 * (which would hide the webview forever).
 */
export function useOverlayPresence(isOpen: Ref<boolean> | ComputedRef<boolean>) {
  // `counted` tracks whether THIS registration currently has a +1 in `depth`,
  // rather than comparing against watch's previous value. The obvious version
  //
  //     watch(isOpen, (open, wasOpen) => {
  //       if (open === wasOpen) return;
  //       depth.value += open ? 1 : -1;
  //     }, { immediate: true });
  //
  // is wrong: on the immediate call Vue passes `undefined` as the previous
  // value, so a closed overlay fails the guard, takes the -1 branch, and
  // decrements. With several overlays registered, depth went negative — and
  // since the browser webview shows only when depth is exactly 0, it never
  // showed at all.
  let counted = false;
  watch(
    isOpen,
    (open) => {
      if (open === counted) return;
      counted = open;
      depth.value += open ? 1 : -1;
    },
    // `sync`, not the default `pre`: the count gates whether a native webview
    // is allowed on screen, and the reader is a requestAnimationFrame loop
    // that must see the current answer. With the default, the update lands a
    // microtask later, so a frame could read a stale count — and the tests
    // would be timing-dependent for no good reason.
    { immediate: true, flush: 'sync' },
  );

  onScopeDispose(() => {
    if (counted) depth.value -= 1;
  });
}

/** Convenience for the common "this ref is non-null while open" shape. */
export function useOverlayPresenceOf<T>(
  source: Ref<T | null> | ComputedRef<T | null>,
): void {
  useOverlayPresence(computed(() => source.value != null));
}

/**
 * For overlays the host renders with `v-if`, where mounting IS opening (e.g.
 * EditorContextMenu). Counts 1 while the component is alive.
 */
export function useOverlayLayer(): void {
  depth.value += 1;
  onScopeDispose(() => {
    depth.value -= 1;
  });
}
