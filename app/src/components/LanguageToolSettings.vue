<script setup lang="ts">
/**
 * Settings → Writing → Grammar & style (LanguageTool).
 *
 * Mode picker (off / local server / Premium / free public API), connection
 * test, Premium credentials (the API key goes straight to the OS keychain via
 * `languagetool_set_api_key` and is never read back into the WebView), and
 * the checking options sent with every request.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore, type LtMode } from '../stores/settings';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';
import { IS_APP_STORE_BUILD } from '../lib/app-build';
import { ltDetect, ltErrorMessage, ltHealth, wireConfig, type LtLanguage } from '../lib/languagetool';

const settings = useSettingsStore();
const toasts = useToastsStore();
const { t } = useI18n();

const modes = computed<{ id: LtMode; label: string }[]>(() => [
  { id: 'off', label: t('languagetool.modeOff') },
  { id: 'local', label: t('languagetool.modeLocal') },
  ...(IS_APP_STORE_BUILD ? [] : [{ id: 'premium' as const, label: t('languagetool.modePremium') }]),
  { id: 'public', label: t('languagetool.modePublic') },
]);

const localUrl = ref(settings.ltLocalUrl);
const username = ref(settings.ltUsername);
const apiKey = ref('');
const hasKey = ref(false);
const testing = ref(false);
const status = ref<{ ok: boolean; text: string } | null>(null);
const languages = ref<LtLanguage[]>([]);

async function refreshHasKey() {
  try {
    hasKey.value = await invoke<boolean>('languagetool_has_api_key');
  } catch {
    hasKey.value = false;
  }
}

async function test(quiet = false) {
  const wire = wireConfig();
  if (!wire) {
    status.value = null;
    return;
  }
  testing.value = true;
  try {
    const st = await ltDetect(wire);
    if (st.languages.length) languages.value = st.languages;
    status.value = st.ok
      ? { ok: true, text: t('languagetool.connected', { count: st.languages.length }) }
      : { ok: false, text: ltErrorMessage(st.error ?? 'lt:unreachable') };
    if (!quiet && st.ok) toasts.success(status.value.text);
  } finally {
    testing.value = false;
  }
}

function setMode(mode: LtMode) {
  settings.setLanguageTool({ ltMode: mode });
  status.value = null;
  if (mode !== 'off') void test(true);
}

function saveLocalUrl() {
  const url = localUrl.value.trim() || 'http://localhost:8081';
  localUrl.value = url;
  if (url === settings.ltLocalUrl) return;
  settings.setLanguageTool({ ltLocalUrl: url });
  void test(true);
}

function saveUsername() {
  const u = username.value.trim();
  if (u === settings.ltUsername) return;
  settings.setLanguageTool({ ltUsername: u });
}

async function saveKey() {
  saveUsername();
  try {
    await invoke('languagetool_set_api_key', { key: apiKey.value });
    apiKey.value = '';
    await refreshHasKey();
    settings.setLanguageTool({});
    await test();
  } catch (e) {
    toasts.error(String(e));
  }
}

async function clearKey() {
  try {
    await invoke('languagetool_clear_api_key');
    await refreshHasKey();
    settings.setLanguageTool({});
    status.value = null;
  } catch (e) {
    toasts.error(String(e));
  }
}

// Status from editors (the server went away mid-session) shows here too.
watch(ltHealth, (h) => {
  if (h === 'error' && status.value?.ok) status.value = null;
});

onMounted(() => {
  void refreshHasKey();
  if (settings.ltMode !== 'off') void test(true);
});
</script>

<template>
  <section class="lt">
    <h3 class="lt__heading">{{ t('languagetool.heading') }}</h3>
    <div class="lt__row">
      <span class="lt__label">{{ t('languagetool.mode') }}</span>
      <select
        class="lt__select"
        :value="settings.ltMode"
        @change="setMode(($event.target as HTMLSelectElement).value as LtMode)"
      >
        <option v-for="m in modes" :key="m.id" :value="m.id">{{ m.label }}</option>
      </select>
    </div>
    <p class="lt__hint">{{ t('languagetool.intro') }}</p>

    <template v-if="settings.ltMode !== 'off'">
      <p v-if="settings.ltMode !== 'local'" class="lt__hint lt__hint--warn">
        {{ t('languagetool.privacyRemote') }}
      </p>

      <template v-if="settings.ltMode === 'local'">
        <div class="lt__row">
          <span class="lt__label">{{ t('languagetool.serverUrl') }}</span>
          <input
            v-model="localUrl"
            type="text"
            class="lt__input lt__input--mono"
            placeholder="http://localhost:8081"
            spellcheck="false"
            @change="saveLocalUrl"
            @keydown.enter="saveLocalUrl"
          />
        </div>
        <p class="lt__hint">{{ t('languagetool.localHint') }}</p>
        <code class="lt__cmd">java -cp languagetool-server.jar org.languagetool.server.HTTPServer --port 8081 --allow-origin</code>
      </template>

      <template v-if="settings.ltMode === 'premium'">
        <div class="lt__row">
          <span class="lt__label">{{ t('languagetool.username') }}</span>
          <input
            v-model="username"
            type="email"
            class="lt__input"
            autocomplete="off"
            spellcheck="false"
            @change="saveUsername"
          />
        </div>
        <div class="lt__row">
          <span class="lt__label">{{ t('languagetool.apiKey') }}</span>
          <input
            v-model="apiKey"
            type="password"
            class="lt__input lt__input--mono"
            autocomplete="off"
            spellcheck="false"
            :placeholder="hasKey ? t('languagetool.apiKeySaved') : ''"
            @keydown.enter="apiKey && saveKey()"
          />
          <button class="lt__btn" :disabled="!apiKey.trim()" @click="saveKey">{{ t('languagetool.save') }}</button>
          <button v-if="hasKey" class="lt__btn" @click="clearKey">{{ t('languagetool.clear') }}</button>
        </div>
        <p class="lt__hint">{{ t('languagetool.premiumHint') }}</p>
      </template>

      <div class="lt__row">
        <button class="lt__btn" :disabled="testing" @click="test()">
          {{ testing ? t('languagetool.testing') : t('languagetool.test') }}
        </button>
        <span v-if="status" class="lt__pill" :class="status.ok ? 'lt__pill--ok' : 'lt__pill--err'">
          {{ status.text }}
        </span>
      </div>

      <div class="lt__row">
        <span class="lt__label">{{ t('languagetool.language') }}</span>
        <select
          class="lt__select"
          :value="settings.ltLanguage"
          @focus="!languages.length && test(true)"
          @change="settings.setLanguageTool({ ltLanguage: ($event.target as HTMLSelectElement).value })"
        >
          <option value="auto">{{ t('languagetool.autoDetect') }}</option>
          <option
            v-if="settings.ltLanguage !== 'auto' && !languages.some((l) => l.longCode === settings.ltLanguage)"
            :value="settings.ltLanguage"
          >{{ settings.ltLanguage }}</option>
          <option v-for="l in languages" :key="l.longCode" :value="l.longCode">{{ l.name }} · {{ l.longCode }}</option>
        </select>
      </div>
      <div v-if="settings.ltLanguage === 'auto'" class="lt__row">
        <span class="lt__label">{{ t('languagetool.preferredVariants') }}</span>
        <input
          type="text"
          class="lt__input lt__input--mono"
          placeholder="en-GB,de-DE"
          spellcheck="false"
          :value="settings.ltPreferredVariants"
          @change="settings.setLanguageTool({ ltPreferredVariants: ($event.target as HTMLInputElement).value.trim() })"
        />
      </div>
      <div class="lt__row">
        <span class="lt__label">{{ t('languagetool.motherTongue') }}</span>
        <select
          class="lt__select"
          :value="settings.ltMotherTongue"
          @focus="!languages.length && test(true)"
          @change="settings.setLanguageTool({ ltMotherTongue: ($event.target as HTMLSelectElement).value })"
        >
          <option value="">—</option>
          <option
            v-if="settings.ltMotherTongue && !languages.some((l) => l.longCode === settings.ltMotherTongue)"
            :value="settings.ltMotherTongue"
          >{{ settings.ltMotherTongue }}</option>
          <option v-for="l in languages" :key="l.longCode" :value="l.longCode">{{ l.name }} · {{ l.longCode }}</option>
        </select>
      </div>
      <p class="lt__hint">{{ t('languagetool.languageHint') }}</p>

      <div class="lt__row">
        <span class="lt__label">{{ t('languagetool.level') }}</span>
        <select
          class="lt__select"
          :value="settings.ltLevel"
          @change="settings.setLanguageTool({ ltLevel: ($event.target as HTMLSelectElement).value as 'default' | 'picky' })"
        >
          <option value="default">{{ t('languagetool.levelDefault') }}</option>
          <option value="picky">{{ t('languagetool.levelPicky') }}</option>
        </select>
      </div>

      <label class="lt__check">
        <input
          type="checkbox"
          :checked="settings.ltCheckWholeDoc"
          @change="settings.setLanguageTool({ ltCheckWholeDoc: !settings.ltCheckWholeDoc })"
        />
        {{ t('languagetool.wholeDoc') }}
      </label>

      <div v-if="settings.ltDisabledRules.length || settings.ltUserWords.length" class="lt__row">
        <span v-if="settings.ltDisabledRules.length" class="lt__hint" :title="settings.ltDisabledRules.join(', ')">
          {{ t('languagetool.disabledRules', { count: settings.ltDisabledRules.length }) }}
        </span>
        <button v-if="settings.ltDisabledRules.length" class="lt__link" @click="settings.setLanguageTool({ ltDisabledRules: [] })">
          {{ t('languagetool.reset') }}
        </button>
        <span v-if="settings.ltUserWords.length" class="lt__hint" :title="settings.ltUserWords.join(', ')">
          {{ t('languagetool.userWords', { count: settings.ltUserWords.length }) }}
        </span>
        <button v-if="settings.ltUserWords.length" class="lt__link" @click="settings.setLanguageTool({ ltUserWords: [] })">
          {{ t('languagetool.reset') }}
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.lt {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.lt__heading {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin: 18px 0 0;
}
.lt__row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.lt__label {
  min-width: 120px;
  font-size: 12px;
  color: var(--text-muted, var(--text));
}
.lt__input,
.lt__select {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: 4px;
  font: inherit;
  font-size: 12px;
}
.lt__select {
  flex: 0 1 260px;
}
.lt__input--mono {
  font-family: 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace;
}
.lt__btn {
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  padding: 5px 12px;
  font: inherit;
  font-size: 12px;
  border-radius: 4px;
  cursor: pointer;
}
.lt__btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.lt__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.lt__link {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.lt__pill {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
}
.lt__pill--ok {
  background: color-mix(in srgb, #22c55e 18%, transparent);
  color: #16a34a;
}
.lt__pill--err {
  background: color-mix(in srgb, #ef4444 16%, transparent);
  color: #dc2626;
}
.lt__check {
  font-size: 12px;
}
.lt__hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-faint);
  line-height: 1.5;
}
.lt__hint--warn {
  color: var(--text-muted, var(--text-faint));
}
.lt__cmd {
  display: block;
  padding: 4px 8px;
  border-radius: 4px;
  background: var(--bg-elev);
  font-size: 10.5px;
  overflow-wrap: anywhere;
  user-select: all;
}
</style>
