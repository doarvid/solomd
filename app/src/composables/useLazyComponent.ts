import { computed, markRaw, nextTick, ref, shallowRef, watch, type Component, type ComputedRef, type ShallowRef } from 'vue';

/**
 * Startup trim: a dialog that is closed at launch shouldn't cost a module
 * evaluation, a component setup, and its CSS on the critical mount path.
 *
 * `useLazyComponent(loader, wanted)` loads the component the first time
 * `wanted()` becomes true and keeps it mounted from then on — exactly the
 * always-mounted lifecycle these dialogs had before, just starting later.
 *
 * The returned `open` is NOT simply `wanted()`: on the first request the
 * component is mounted with `open === false` and flipped to `true` on the next
 * tick. Every dialog here reacts to `props.open` with a non-immediate
 * `watch` (focus the input, reset the query, register Escape, DsModal's focus
 * trap…), and those watchers only fire on a change — mounting a dialog
 * already open would silently skip them.
 */
export function useLazyComponent(
  loader: () => Promise<{ default: Component }>,
  wanted: () => boolean,
): { component: ShallowRef<Component | null>; open: ComputedRef<boolean> } {
  const component = shallowRef<Component | null>(null);
  const ready = ref(false);
  let loading = false;
  let loaded = false;
  watch(
    wanted,
    (on) => {
      if (!on || loaded || loading) return;
      loading = true;
      loader()
        .then(async (mod) => {
          component.value = markRaw(mod.default);
          loaded = true;
          await nextTick();
          ready.value = true;
        })
        .catch((e) => {
          console.error('[lazy] component failed to load', e);
        })
        .finally(() => {
          loading = false;
        });
    },
    { immediate: true },
  );
  const open = computed(() => ready.value && wanted());
  return { component, open };
}
