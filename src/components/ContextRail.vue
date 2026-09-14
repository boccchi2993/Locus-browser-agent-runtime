<template>
  <aside class="context-rail">
    <section class="rail-section">
      <button class="rail-head" type="button" @click="collapse.progress = !collapse.progress">
        Progress <span class="rail-chev" :class="{ closed: collapse.progress }">▾</span>
      </button>
      <div v-if="!collapse.progress" class="rail-body">
        <div class="progress-row">
          <span class="status-pill" :data-status="status">{{ statusLabel }}</span>
        </div>
        <!-- Derived from real runtime events only — no invented plan steps. -->
        <div v-if="meta.lastTool" class="kv">
          <span class="k">Last action</span>
          <span class="v mono">{{ meta.lastTool }}</span>
        </div>
        <div v-if="meta.toolCount" class="kv">
          <span class="k">Tool calls</span>
          <span class="v">{{ meta.toolCount }}</span>
        </div>
        <div v-if="meta.lastBackend" class="kv">
          <span class="k">Backend</span>
          <span class="v"><span class="backend-badge" :data-backend="meta.lastBackend">{{ meta.lastBackend }}</span></span>
        </div>
        <div v-if="status === 'idle' && !meta.toolCount" class="rail-hint">
          Progress will show as the task unfolds.
        </div>
      </div>
    </section>

    <section class="rail-section">
      <button class="rail-head" type="button" @click="collapse.folder = !collapse.folder">
        Working folder <span class="rail-chev" :class="{ closed: collapse.folder }">▾</span>
      </button>
      <div v-if="!collapse.folder" class="rail-body">
        <template v-if="store.workspaceName">
          <div class="folder-row">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3">
              <path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 2h6.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7.5Z"/>
            </svg>
            <span class="folder-name">{{ store.workspaceName }}</span>
          </div>
          <div class="rail-hint">mounted at /mnt/workspace</div>
        </template>
        <div v-else class="rail-hint">No external folder mounted</div>
        <button class="rail-btn" type="button" @click="mountFolder">
          {{ store.workspaceName ? 'Change folder' : 'Mount folder' }}
        </button>
      </div>
    </section>

    <section class="rail-section artifacts-section">
      <button class="rail-head" type="button" @click="collapse.artifacts = !collapse.artifacts">
        Artifacts <span class="rail-chev" :class="{ closed: collapse.artifacts }">▾</span>
      </button>
      <div v-if="!collapse.artifacts" class="rail-body">
        <div v-if="!store.artifacts.length" class="rail-hint">No artifacts yet</div>
        <div v-for="a in store.artifacts" :key="a.path" class="artifact-row">
          <span class="artifact-path" :title="'/mnt/download/' + a.path">{{ a.path }}</span>
          <span class="artifact-size">{{ humanSize(a.size) }}</span>
          <button class="artifact-download" type="button" @click="downloadArtifact(a.path)">Download</button>
        </div>
      </div>
    </section>

    <section class="rail-section">
      <button class="rail-head" type="button" @click="collapse.context = !collapse.context">
        Context <span class="rail-chev" :class="{ closed: collapse.context }">▾</span>
      </button>
      <div v-if="!collapse.context" class="rail-body">
        <div class="kv"><span class="k">Model</span><span class="v mono">{{ store.settings.model }}</span></div>
        <div class="kv"><span class="k">Dialect</span><span class="v mono">{{ store.settings.dialect }}</span></div>
        <div class="kv"><span class="k">Python</span><span class="v mono" :data-py="store.pythonStatus">{{ store.pythonStatus }}</span></div>
        <div class="kv">
          <span class="k">API</span>
          <span class="v mono api-base" :title="store.settings.apiBase">{{ apiHost }}</span>
        </div>
      </div>
    </section>

    <section class="rail-section">
      <button class="rail-head" type="button" @click="collapse.telemetry = !collapse.telemetry">
        Telemetry <span class="rail-chev" :class="{ closed: collapse.telemetry }">▾</span>
      </button>
      <div v-if="!collapse.telemetry" class="rail-body">
        <div v-if="!records.length" class="rail-hint">No executions recorded yet.</div>
        <div v-for="(r, i) in records" :key="i" class="tele-item">
          <span :class="r.success ? 'ok' : 'fail'">{{ r.success ? '✓' : '✗' }}</span>
          <span class="mono">{{ r.tool }}</span>
          <span v-if="r.backend" class="backend-badge" :data-backend="r.backend">{{ r.backend }}</span>
          <span class="tele-detail">{{ r.duration_ms }}ms · in {{ r.input_bytes }}B · out {{ r.output_bytes }}B</span>
          <div v-if="r.error" class="tele-err">{{ r.error }}</div>
        </div>
      </div>
    </section>
  </aside>
</template>

<script setup>
import { reactive, computed, watch } from 'vue';
import { store, activeConversation, mountFolder, refreshArtifacts, downloadArtifact } from '../ui/store.js';

/* global Telemetry */

const collapse = reactive({ progress: false, folder: false, artifacts: false, context: false, telemetry: true });

const status = computed(() => (activeConversation.value ? activeConversation.value.status : 'idle'));
const meta = computed(() => (activeConversation.value ? activeConversation.value.meta : { toolCount: 0 }));

const statusLabel = computed(() => {
  switch (status.value) {
    case 'running': return 'Running';
    case 'completed': return 'Completed';
    case 'cancelled': return 'Cancelled';
    case 'error': return 'Error';
    case 'iteration_limit': return 'Stopped (iteration limit)';
    case 'session_changed': return 'Session switched';
    default: return 'Idle';
  }
});

// store.telemetryVersion bumps on every tool_result so this re-reads the
// runtime-owned Telemetry.records (never copied, never reformatted here).
const records = computed(() => {
  void store.telemetryVersion;
  return (typeof Telemetry !== 'undefined' ? Telemetry.records.slice(-12).reverse() : []);
});

const apiHost = computed(() => {
  try { return new URL(store.settings.apiBase).host; } catch (e) { return store.settings.apiBase; }
});

// Artifacts mirror /mnt/download; refreshed on store boot and whenever a
// tool_result lands (telemetryVersion bumps) — the agent may have written
// new downloadable files.
watch(() => store.telemetryVersion, () => { refreshArtifacts(); });

function humanSize(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
</script>
