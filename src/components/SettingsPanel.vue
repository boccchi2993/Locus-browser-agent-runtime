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
        Remember key for this tab only (sessionStorage — cleared when the tab closes)
      </label>

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
import { store, applySettings, persistSettingsIfNeeded, testConnection } from '../ui/store.js';

function close() {
  applySettings();
  persistSettingsIfNeeded();
  store.settingsOpen = false;
  store.settingsResult = null;
}
</script>
