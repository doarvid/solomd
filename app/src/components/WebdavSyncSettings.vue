<script setup lang="ts">
import { ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../stores/settings';
import { useWorkspaceStore } from '../stores/workspace';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';

const settings = useSettingsStore();
const workspace = useWorkspaceStore();
const toasts = useToastsStore();
const { t } = useI18n();

const testing = ref(false);
const pushing = ref(false);
const pulling = ref(false);
const statusText = ref('');
const statusKind = ref<'ok' | 'err' | ''>('');

function saveConfig() {
  settings.persist();
}

function applyPreset(url: string) {
  settings.webdavUrl = url;
  if (!settings.webdavRemotePath) {
    settings.webdavRemotePath = '/SoloMD';
  }
  settings.webdavEnabled = true;
  settings.persist();
}

async function testConnection() {
  testing.value = true;
  statusText.value = '';
  statusKind.value = '';
  try {
    const res = await invoke<string>('webdav_test_connection', {
      url: settings.webdavUrl,
      username: settings.webdavUsername,
      password: settings.webdavPassword,
      remotePath: settings.webdavRemotePath || '/SoloMD',
    });
    statusText.value = res;
    statusKind.value = 'ok';
    toasts.success(res);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    statusText.value = msg;
    statusKind.value = 'err';
    toasts.error(msg);
  } finally {
    testing.value = false;
  }
}

async function pushWorkspace() {
  if (!workspace.currentFolder) {
    toasts.warning(t('menubar.openFolder'));
    return;
  }
  pushing.value = true;
  statusText.value = '';
  try {
    const res = await invoke<{ uploaded: number; message: string }>('webdav_push_workspace', {
      workspace: workspace.currentFolder,
      url: settings.webdavUrl,
      username: settings.webdavUsername,
      password: settings.webdavPassword,
      remotePath: settings.webdavRemotePath || '/SoloMD',
    });
    statusText.value = res.message;
    statusKind.value = 'ok';
    toasts.success(res.message);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    statusText.value = msg;
    statusKind.value = 'err';
    toasts.error(msg);
  } finally {
    pushing.value = false;
  }
}

async function pullWorkspace() {
  if (!workspace.currentFolder) {
    toasts.warning(t('menubar.openFolder'));
    return;
  }
  pulling.value = true;
  statusText.value = '';
  try {
    const res = await invoke<{ downloaded: number; message: string }>('webdav_pull_workspace', {
      workspace: workspace.currentFolder,
      url: settings.webdavUrl,
      username: settings.webdavUsername,
      password: settings.webdavPassword,
      remotePath: settings.webdavRemotePath || '/SoloMD',
    });
    statusText.value = res.message;
    statusKind.value = 'ok';
    toasts.success(res.message);
    window.dispatchEvent(new CustomEvent('solomd:remote-pulled'));
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    statusText.value = msg;
    statusKind.value = 'err';
    toasts.error(msg);
  } finally {
    pulling.value = false;
  }
}
</script>

<template>
  <section class="settings__section webdav-sync">
    <h4 class="settings__heading">WebDAV Sync (坚果云 / Nextcloud / AList / NAS)</h4>
    <p class="settings__hint">
      {{
        settings.language === 'zh'
          ? '通过标准 WebDAV 协议同步当前笔记文件夹（支持坚果云、Nextcloud、ownCloud、AList/OpenList、群晖 NAS 等）。'
          : 'Sync your workspace folder over WebDAV (Nutstore / 坚果云, Nextcloud, ownCloud, AList/OpenList, Synology NAS).'
      }}
    </p>

    <label class="settings__row">
      <span>{{ settings.language === 'zh' ? '启用 WebDAV 同步' : 'Enable WebDAV Sync' }}</span>
      <input
        v-model="settings.webdavEnabled"
        type="checkbox"
        @change="saveConfig"
      />
    </label>

    <div class="webdav-sync__presets">
      <span class="webdav-sync__preset-label">
        {{ settings.language === 'zh' ? '快捷填入：' : 'Quick preset:' }}
      </span>
      <button
        type="button"
        class="settings__btn-secondary"
        @click="applyPreset('https://dav.jianguoyun.com/dav')"
      >
        坚果云 (Nutstore)
      </button>
      <button
        type="button"
        class="settings__btn-secondary"
        @click="applyPreset('https://your-domain.com/remote.php/dav/files/USERNAME')"
      >
        Nextcloud
      </button>
      <button
        type="button"
        class="settings__btn-secondary"
        @click="applyPreset('http://127.0.0.1:5244/dav')"
      >
        AList / OpenList
      </button>
    </div>

    <div class="webdav-sync__grid">
      <label class="webdav-sync__field">
        <span>{{ settings.language === 'zh' ? 'WebDAV 服务器地址 (URL)' : 'WebDAV Server URL' }}</span>
        <input
          v-model="settings.webdavUrl"
          type="url"
          class="settings__input"
          placeholder="https://dav.jianguoyun.com/dav"
          @change="saveConfig"
        />
      </label>

      <label class="webdav-sync__field">
        <span>{{ settings.language === 'zh' ? '远程同步目录' : 'Remote Folder Path' }}</span>
        <input
          v-model="settings.webdavRemotePath"
          type="text"
          class="settings__input"
          placeholder="/SoloMD"
          @change="saveConfig"
        />
      </label>

      <label class="webdav-sync__field">
        <span>{{ settings.language === 'zh' ? '账号 / 用户名' : 'Username' }}</span>
        <input
          v-model="settings.webdavUsername"
          type="text"
          class="settings__input"
          placeholder="user@example.com"
          autocomplete="off"
          @change="saveConfig"
        />
      </label>

      <label class="webdav-sync__field">
        <span>{{ settings.language === 'zh' ? '应用密码 / 授权码' : 'Password / App Password' }}</span>
        <input
          v-model="settings.webdavPassword"
          type="password"
          class="settings__input"
          placeholder="••••••••••••"
          autocomplete="new-password"
          @change="saveConfig"
        />
      </label>
    </div>

    <div class="webdav-sync__actions">
      <button
        type="button"
        class="settings__btn-secondary"
        :disabled="testing || !settings.webdavUrl"
        @click="testConnection"
      >
        {{
          testing
            ? (settings.language === 'zh' ? '连接测试中…' : 'Testing…')
            : (settings.language === 'zh' ? '测试 WebDAV 连接' : 'Test Connection')
        }}
      </button>
      <button
        type="button"
        class="settings__btn-secondary"
        :disabled="pushing || !settings.webdavUrl"
        @click="pushWorkspace"
      >
        {{
          pushing
            ? (settings.language === 'zh' ? '上传中…' : 'Uploading…')
            : (settings.language === 'zh' ? 'WebDAV 上传同步 (Push)' : 'WebDAV Push (Upload)')
        }}
      </button>
      <button
        type="button"
        class="settings__btn-secondary"
        :disabled="pulling || !settings.webdavUrl"
        @click="pullWorkspace"
      >
        {{
          pulling
            ? (settings.language === 'zh' ? '下载中…' : 'Downloading…')
            : (settings.language === 'zh' ? 'WebDAV 下载同步 (Pull)' : 'WebDAV Pull (Download)')
        }}
      </button>
    </div>

    <p
      v-if="statusText"
      class="webdav-sync__status"
      :class="{
        'webdav-sync__status--ok': statusKind === 'ok',
        'webdav-sync__status--err': statusKind === 'err',
      }"
    >
      {{ statusText }}
    </p>
  </section>
</template>

<style scoped>
.webdav-sync {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.webdav-sync__presets {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.webdav-sync__preset-label {
  font-size: 12px;
  color: var(--text-muted);
}
.webdav-sync__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 10px;
}
.webdav-sync__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
}
.webdav-sync__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}
.webdav-sync__status {
  margin: 2px 0 0;
  font-size: 12px;
}
.webdav-sync__status--ok {
  color: var(--accent);
}
.webdav-sync__status--err {
  color: #e5534b;
}
</style>
