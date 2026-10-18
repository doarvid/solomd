<script setup lang="ts">
/**
 * Settings → Integrations → browser bookmark sync.
 *
 * There is no folder picker anymore: the browser's managed `SoloMD/` folder is
 * the only surface. Bookmarks the user drops there are captured into notes
 * (mirroring its subfolders under the workspace root), and every note link is
 * written back into the same folder.
 */
import { computed, onMounted, ref } from 'vue';

import { useI18n } from '../i18n';
import { isMobile } from '../lib/platform';
import { useSettingsStore } from '../stores/settings';
import { useBookmarkSyncStore } from '../stores/bookmarkSync';
import { useWorkspaceStore } from '../stores/workspace';

const { t } = useI18n();
const settings = useSettingsStore();
const workspace = useWorkspaceStore();
const sync = useBookmarkSyncStore();

const scanning = ref(false);

const sourceNames = computed(() => {
  const catalog = sync.catalog;
  if (!catalog) return [];
  return catalog.sources.map((s) => `${s.browser} · ${s.profile}`);
});

const canSync = computed(
  () => settings.bookmarkSyncEnabled && !!workspace.currentFolder && !isMobile(),
);

function toggleEnabled() {
  settings.bookmarkSyncEnabled = !settings.bookmarkSyncEnabled;
  settings.persist();
  if (settings.bookmarkSyncEnabled) {
    void sync.refreshCatalog();
    sync.syncNow();
  }
}

function setIntervalMinutes(event: Event) {
  const value = Number((event.target as HTMLSelectElement).value);
  if (!Number.isFinite(value) || value <= 0) return;
  settings.bookmarkSyncIntervalMinutes = value;
  settings.persist();
}

async function scan() {
  scanning.value = true;
  try {
    await sync.refreshCatalog();
  } finally {
    scanning.value = false;
  }
}

onMounted(() => {
  if (settings.bookmarkSyncEnabled) void scan();
});

const statusLine = computed(() => {
  if (sync.running) {
    const phase =
      sync.phase === 'writing'
        ? t('settings.bookmarkSync.syncingWrite')
        : t('settings.bookmarkSync.syncingRead');
    if (sync.phase === 'reading' && sync.total > 0) {
      return `${phase} ${sync.done}/${sync.total}`;
    }
    return phase;
  }
  if (sync.lastRunAt) {
    const at = new Date(sync.lastRunAt).toLocaleTimeString();
    return `${t('settings.bookmarkSync.lastRun')} ${at}`;
  }
  return t('settings.bookmarkSync.never');
});

const writeSummary = computed(() => {
  const report = sync.writeReport;
  if (!report) return '';
  const written = report.unchanged
    ? t('settings.bookmarkSync.writeUnchanged')
    : t('settings.bookmarkSync.writeWritten', { count: report.written_profiles.length });
  const running = report.skipped_profiles.filter((p) => p.reason === 'running').length;
  return running > 0
    ? `${written} · ${t('settings.bookmarkSync.writeWaiting', { count: running })}`
    : written;
});
</script>

<template>
  <section class="bsync" data-cat="integrations">
    <h3 class="bsync__heading">{{ t('settings.bookmarkSync.heading') }}</h3>

    <label class="bsync__row">
      <input
        type="checkbox"
        :checked="settings.bookmarkSyncEnabled"
        @change="toggleEnabled"
      />
      {{ t('settings.bookmarkSync.enable') }}
    </label>
    <p class="bsync__hint">{{ t('settings.bookmarkSync.enableHint') }}</p>

    <template v-if="settings.bookmarkSyncEnabled">
      <div class="bsync__row bsync__row--between">
        <span class="bsync__label">
          {{ t('settings.bookmarkSync.sources') }}
          <span class="bsync__muted">
            {{ t('settings.bookmarkSync.sourceCount', { count: sourceNames.length }) }}
          </span>
        </span>
        <button class="bsync__btn" :disabled="scanning" @click="scan">
          {{ scanning ? t('settings.bookmarkSync.scanning') : t('settings.bookmarkSync.rescan') }}
        </button>
      </div>
      <p v-if="sourceNames.length === 0" class="bsync__hint">
        {{ t('settings.bookmarkSync.noSources') }}
      </p>
      <p v-else class="bsync__hint bsync__hint--mono">
        {{ sourceNames.join('  ·  ') }}
      </p>
      <p class="bsync__hint">{{ t('settings.bookmarkSync.treeHint') }}</p>

      <label class="bsync__row">
        {{ t('settings.bookmarkSync.interval') }}
        <select
          class="bsync__select"
          :value="String(settings.bookmarkSyncIntervalMinutes)"
          @change="setIntervalMinutes"
        >
          <option value="15">{{ t('settings.bookmarkSync.minutes', { count: 15 }) }}</option>
          <option value="30">{{ t('settings.bookmarkSync.minutes', { count: 30 }) }}</option>
          <option value="60">{{ t('settings.bookmarkSync.minutes', { count: 60 }) }}</option>
        </select>
      </label>

      <div class="bsync__row bsync__row--between">
        <button class="bsync__btn" :disabled="!canSync || sync.running" @click="sync.syncNow()">
          {{ sync.running ? t('settings.bookmarkSync.syncing') : t('settings.bookmarkSync.syncNow') }}
        </button>
        <span class="bsync__muted">{{ statusLine }}</span>
      </div>

      <p v-if="sync.running && sync.total > 0" class="bsync__hint">
        {{
          t('settings.bookmarkSync.progress', {
            captured: sync.captured,
            skipped: sync.skipped,
            failed: sync.failed,
          })
        }}
      </p>
      <p v-if="writeSummary" class="bsync__hint">{{ writeSummary }}</p>
      <p v-if="sync.lastError" class="bsync__hint bsync__hint--error">{{ sync.lastError }}</p>
      <p v-if="!workspace.currentFolder" class="bsync__hint">
        {{ t('settings.bookmarkSync.noWorkspace') }}
      </p>
    </template>

    <p class="bsync__hint">{{ t('settings.bookmarkSync.mirrorHint') }}</p>
    <p class="bsync__hint">{{ t('settings.bookmarkSync.noteSafety') }}</p>
    <p class="bsync__hint">{{ t('settings.bookmarkSync.managedWarning') }}</p>
  </section>
</template>

<style scoped>
.bsync {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bsync__heading {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin: 18px 0 6px;
}
.bsync__row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.bsync__row--between {
  justify-content: space-between;
}
.bsync__label {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
}
.bsync__hint {
  font-size: 11px;
  color: var(--text-faint);
  margin: 0;
  line-height: 1.5;
}
.bsync__hint--mono {
  font-family: var(--font-mono, monospace);
  word-break: break-all;
}
.bsync__hint--error {
  color: var(--danger);
}
.bsync__muted {
  font-size: 11px;
  color: var(--text-muted);
}
.bsync__select {
  padding: 3px 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: 4px;
  font: inherit;
  font-size: 11px;
}
.bsync__btn {
  font-size: 11px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: 4px;
  cursor: pointer;
}
.bsync__btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
