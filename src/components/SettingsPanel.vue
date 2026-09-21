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
        <div class="section-label">Image input</div>
        <div class="hint">
          {{ imageCapabilitySummary }}
          <span v-if="store.imageCapability && store.imageCapability.lastProbeFailure">Last check: {{ store.imageCapability.lastProbeFailure }}</span>
        </div>
        <button
          class="rail-btn"
          type="button"
          :disabled="store.busy || store.cancelling || !store.imageCapability"
          data-testid="recheck-image-capability"
          @click="recheckCapability"
        >Forget &amp; recheck image capability</button>
      </section>

      <section class="storage-controls" data-testid="capabilities-section">
        <div class="section-label">Capabilities</div>
        <div v-if="!capabilities.length" class="hint" data-testid="capabilities-empty">No optional capabilities available yet.</div>
        <div v-for="c in capabilities" :key="c.id" class="capability-item" :data-testid="'capability-' + c.id">
          <div class="capability-row">
            <span class="capability-name">{{ c.displayName }}</span>
            <span class="capability-state" :data-state="c.state">{{ stateLabel(c) }}</span>
            <button v-if="!c.enabled" class="rail-btn" type="button" :disabled="store.busy || store.cancelling"
              :data-testid="'capability-add-' + c.id" @click="addCapability(c)">Add</button>
            <button v-else class="rail-btn" type="button" :disabled="store.busy || store.cancelling"
              :data-testid="'capability-remove-' + c.id" @click="removeCapability(c)">Remove</button>
          </div>
          <div class="hint">{{ c.description }}</div>
          <div v-if="c.enabled" class="hint" :data-testid="'capability-includes-' + c.id">
            Includes: {{ c.includes.plugins }} local software · {{ c.includes.skills }} guidance · {{ c.includes.mcps }} external connections
          </div>
          <div v-if="c.enabled && c.error" class="hint">{{ c.error }}</div>
          <template v-if="c.enabled">
            <div v-for="m in c.mcps" :key="m.id" class="hint" :data-testid="'capability-mcp-' + c.id">
              External connection: {{ m.displayName }} — {{ m.state === 'connected' ? 'Connected' : 'Connection required' }}
              <button v-if="m.state !== 'connected'" class="rail-btn" type="button" :disabled="store.busy || store.cancelling"
                :data-testid="'capability-connect-' + c.id" @click="connectMcp(c, m)">Connect</button>
            </div>
          </template>
        </div>
      </section>

      <section class="storage-controls">
        <div class="section-label">Local storage</div>
        <div class="hint">
          {{ storageSummary }}
          <span v-if="store.storageStatus.error">Persistence fallback: {{ store.storageStatus.error }}</span>
        </div>
        <div v-if="store.storageNotice" class="hint storage-notice">{{ store.storageNotice }}</div>
        <button class="rail-btn" type="button" @click="keepStorage">
          {{ store.storageStatus.persistent ? 'Persistent storage granted' : 'Keep Locus data on this device' }}
        </button>
        <div class="storage-actions">
          <button class="rail-btn" type="button" :disabled="store.busy || store.cancelling" @click="clearConversations">Clear conversations</button>
          <button class="rail-btn" type="button" :disabled="store.busy || store.cancelling" @click="clearHome">Clear home</button>
          <button class="rail-btn" type="button" :disabled="store.busy || store.cancelling" @click="clearPlugins">Clear plugins</button>
          <button class="rail-btn danger" type="button" :disabled="store.busy || store.cancelling" @click="forgetApiKeys">Forget API keys</button>
          <button class="rail-btn danger" type="button" :disabled="store.busy || store.cancelling" @click="resetAllData">Reset all local data</button>
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
  capabilityList, enableCapability, disableCapability, setMcpConnectionState,
  keepDataOnThisDevice, clearConversations as clearConversationData,
  clearHome as clearHomeData, clearPlugins as clearPluginData,
  forgetApiKeys as forgetStoredApiKeys, resetAllData as resetLocalData,
  refreshImageCapability, recheckImageCapability,
} from '../ui/store.js';
import { computed, onMounted } from 'vue';

const storageSummary = computed(() => {
  const s = store.storageStatus;
  const mb = (n) => n == null ? '?' : (n / (1024 * 1024)).toFixed(1);
  return `${s.mode === 'indexeddb' ? 'IndexedDB' : 'Memory-only'} · OPFS ${s.opfs ? 'available' : 'unavailable'} · ${mb(s.usage)} MB used / ${mb(s.quota)} MB available`;
});

// Read-only capability projection (docs/IMAGE-INPUT.md). Source labels:
// user / probe / built-in / provider / unknown origin.
const imageCapabilitySummary = computed(() => {
  const c = store.imageCapability;
  if (!c) return 'Unavailable in this runtime.';
  const sourceLabel = { user: 'your answer', probe: 'visual check', builtin: 'built-in table', 'provider-rejection': 'provider' }[c.source] || c.source;
  return `Image input: ${c.state} · source: ${sourceLabel}`;
});

const capabilities = computed(() => store.capabilities);

function stateLabel(c) {
  if (!c.enabled) return c.state === 'disabled' ? 'Not added' : c.state;
  return { ready: 'Ready', 'needs-connection': 'Connection required', error: 'Error', disabled: 'Not added' }[c.state] || c.state;
}

async function refreshCapabilities() { capabilityList(); }

async function addCapability(c) {
  try {
    await enableCapability(c.id);
    refreshCapabilities();
  } catch (e) {
    store.storageNotice = e.message || String(e);
  }
}

function removeCapability(c) {
  try {
    disableCapability(c.id);
    refreshCapabilities();
  } catch (e) {
    store.storageNotice = e.message || String(e);
  }
}

function connectMcp(c, m) {
  try {
    setMcpConnectionState(m.id, 'connected');
    refreshCapabilities();
  } catch (e) {
    store.storageNotice = e.message || String(e);
  }
}

onMounted(() => { refreshImageCapability(); });

async function recheckCapability() {
  try {
    await recheckImageCapability();
    store.storageNotice = 'Image capability was reset for the current provider; Locus will ask again next time an image is sent.';
  } catch (e) {
    store.storageNotice = 'Recheck failed: ' + (e && e.message ? e.message : String(e));
  }
}

async function keepStorage() { await keepDataOnThisDevice(); }
async function clearConversations() { try { await clearConversationData(); } catch (e) { store.storageNotice = e.message || String(e); } }
async function clearHome() { try { await clearHomeData(); } catch (e) { store.storageNotice = e.message || String(e); } }
async function clearPlugins() { try { await clearPluginData(); } catch (e) { store.storageNotice = e.message || String(e); } }
async function forgetApiKeys() { try { await forgetStoredApiKeys(); } catch (e) { store.storageNotice = e.message || String(e); } }
async function resetAllData() { try { await resetLocalData(); } catch (e) { store.storageNotice = e.message || String(e); } }

async function close() {
  applySettings();
  await persistSettingsIfNeeded();
  store.settingsOpen = false;
  store.settingsResult = null;
}
</script>
