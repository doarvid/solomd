import { ref } from 'vue';
import { checkForUpdate, openReleaseUrl } from '../lib/check-update';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';

/** Shared so the Settings button and Help → Check for Updates show one state. */
const checking = ref(false);

/**
 * "Check for updates now" — Settings → Advanced and, since bug/C1, the Help
 * menu. One implementation so the two can never report differently.
 */
export function useUpdateCheck() {
  const toasts = useToastsStore();
  const { t } = useI18n();

  async function manualCheckUpdate(): Promise<void> {
    if (checking.value) return;
    checking.value = true;
    try {
      const r = await checkForUpdate();
      if (r.error) {
        // Both solomd.app proxy + GitHub direct failed (offline / DNS / etc).
        // Don't lie to the user with "up to date" — show a real error.
        toasts.error(t('settings.updateCheckFailed'));
      } else if (r.hasUpdate) {
        toasts.success(t('settings.updateAvailable', { version: r.latest || '' }));
        await openReleaseUrl(r.url);
      } else {
        toasts.info(t('settings.upToDate'));
      }
    } catch (e) {
      toasts.error(String(e));
    } finally {
      checking.value = false;
    }
  }

  return { checking, manualCheckUpdate };
}
