<template>
  <div class="modal-backdrop" @click.self="close">
    <div class="modal settings-panel" role="dialog" aria-label="Settings">
      <div class="modal-head">
        <span>Settings</span>
        <button class="icon-btn" type="button" @click="close">×</button>
      </div>

      <div class="field">
        <label for="set-api-key">API key</label>
        <input id="set-api-key" v-model="store.settings.apiKey" type="password" placeholder="sk-…" spellcheck="false" autocomplete="off">
      </div>
      <div class="field">
        <label for="set-api-base">API endpoint</label>
        <input id="set-api-base" v-model="store.settings.apiBase" type="text" spellcheck="false" autocomplete="off">
      </div>
      <div class="field">
        <label for="set-model">Model</label>
        <input id="set-model" v-model="store.settings.model" type="text" spellcheck="false" autocomplete="off">
      </div>
      <div class="field">
        <label for="set-dialect">API dialect</label>
        <select id="set-dialect" v-model="store.settings.dialect">
          <option value="auto">auto — detect from endpoint</option>
          <option value="openai">openai — OpenAI-compatible</option>
          <option value="anthropic">anthropic — Anthropic-compatible</option>
        </select>
        <div class="hint">Set manually when a gateway or corporate proxy cannot be auto-detected.</div>
      </div>
      <div class="field">
        <label for="set-proxy">Relay / proxy <span class="hint-inline">optional</span></label>
        <input id="set-proxy" v-model="store.settings.proxy" type="text" placeholder="https://your-proxy.workers.dev" spellcheck="false" autocomplete="off">
        <div class="hint">Routes the model call through your own relay to work around CORS. Empty = direct.</div>
      </div>

      <label class="check-row">
        <input v-model="store.settings.remember" type="checkbox">
        Remember API key on this device (local browser profile)
      </label>

      <section class="storage-controls">
        <div class="section-label">Local storage</div>
        <div class="hint">
          {{ storageSummary }}
          <span v-if="store.storageStatus.error">Persistence fallback: {{ store.storageStatus.error }}</span>
        </div>
        <button class="rail-btn" type="button" @click="keepStorage">
          {{ store.storageStatus.persistent ? 'Persistent storage granted' : 'Keep Locus data on this device' }}
        </button>
        <div class="storage-actions">
          <button class="rail-btn" type="button" @click="clearConversations">Clear conversations</button>
          <button class="rail-btn" type="button" @click="clearHome">Clear home</button>
          <button class="rail-btn" type="button" @click="clearPlugins">Clear plugins</button>
          <button class="rail-btn danger" type="button" @click="forgetApiKeys">Forget API keys</button>
          <button class="rail-btn danger" type="button" @click="resetAllData">Reset all local data</button>
        </div>
      </section>

      <div class="modal-actions">
        <button class="primary-btn" type="button" :disabled="store.settingsTesting" @click="testConnection">
          {{ store.settingsTesting ? 'Testing…' : 'Test connection' }}
        </button>
        <button class="rail-btn" type="button" @click="close">Done</button>
      </div>
      <div v-if="store.settingsResult" class="settings-result" :class="{ ok: store.settingsResult.ok }">
        {{ store.settingsResult.message }}
      </div>
    </div>
  </div>
</template>

<script setup>
import {
  store, applySettings, persistSettingsIfNeeded, testConnection,
  keepDataOnThisDevice, clearConversations as clearConversationData,
  clearHome as clearHomeData, clearPlugins as clearPluginData,
  forgetApiKeys as forgetStoredApiKeys, resetAllData as resetLocalData,
} from '../ui/store.js';
import { computed } from 'vue';

const storageSummary = computed(() => {
  const s = store.storageStatus;
  const mb = (n) => n == null ? '?' : (n / (1024 * 1024)).toFixed(1);
  return `${s.mode === 'indexeddb' ? 'IndexedDB' : 'Memory-only'} · OPFS ${s.opfs ? 'available' : 'unavailable'} · ${mb(s.usage)} MB used / ${mb(s.quota)} MB available`;
});

async function keepStorage() { await keepDataOnThisDevice(); }
async function clearConversations() { await clearConversationData(); }
async function clearHome() { await clearHomeData(); }
async function clearPlugins() { await clearPluginData(); }
async function forgetApiKeys() { await forgetStoredApiKeys(); }
async function resetAllData() { await resetLocalData(); }

async function close() {
  applySettings();
  await persistSettingsIfNeeded();
  store.settingsOpen = false;
  store.settingsResult = null;
}
</script>
