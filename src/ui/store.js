// ============================================================
//  PRESENTATION STORE (Vue)
//
//  The store is the presentation consumer of the AgentSession event
//  stream. It owns UI state ONLY: conversations/timelines (a pure
//  projection via LocusProjector), settings surface, workspace display
//  state, panels and busy flags.
//
//  It does NOT own: the agent loop, provider history, provider
//  serialization, tool execution semantics, cancellation correctness,
//  session generation or workspace authority — all of that stays in
//  the injected runtime (AgentSession and friends). The timeline is
//  never serialized back into provider history.
//
//  Runtime globals (AgentSession, Model, callModel, executeTool,
//  LocalDirectoryWorkspace, ensureWorkspacePermission, PythonRuntime,
//  Telemetry, LocusProjector) come from the classic scripts loaded by
//  index.html before this module — same as the old ui.js wiring.
// ============================================================

import { reactive, computed } from 'vue';

/* global AgentSession, Model, callModel, executeTool, buildSystemPrompt,
   LocalDirectoryWorkspace, ensureWorkspacePermission, PythonRuntime,
   Telemetry, LocusProjector */

const REMEMBER_SESSION_KEY = 'bar.v0.rememberSessionKey.v1';
const SESSION_CONFIG_KEY = 'bar.v0.sessionConfig.v1';

const DEFAULTS = {
  apiKey: '',
  apiBase: 'https://api.deepseek.com/anthropic',
  model: 'deepseek-v4-pro',
  proxy: '',
  dialect: 'auto',
  remember: false,
};

function sessionGet(key) {
  try { return sessionStorage.getItem(key); } catch (e) { return null; }
}
function sessionSet(key, value) {
  try { sessionStorage.setItem(key, value); } catch (e) {}
}
function sessionRemove(key) {
  try { sessionStorage.removeItem(key); } catch (e) {}
}

function loadSettings() {
  const s = Object.assign({}, DEFAULTS);
  if (sessionGet(REMEMBER_SESSION_KEY) !== '1') return s;
  let cfg = null;
  try { cfg = JSON.parse(sessionGet(SESSION_CONFIG_KEY) || 'null'); } catch (e) {}
  if (!cfg) return s;
  for (const k of ['apiKey', 'apiBase', 'model', 'proxy', 'dialect']) {
    if (cfg[k]) s[k] = cfg[k];
  }
  s.remember = true;
  return s;
}

// Test/demo hook seam: tests inject model/tool/directory fakes without
// touching runtime code. Production builds simply never set this.
function hooks() {
  return (typeof window !== 'undefined' && window.__LOCUS_HOOKS__) || null;
}

let conversationSeq = 1;

export const store = reactive({
  settings: loadSettings(),
  settingsOpen: false,
  settingsTesting: false,
  settingsResult: null, // { ok, message }

  conversations: [],
  activeConversationId: null,
  liveConversationId: null, // conversation bound to the current AgentSession session

  busy: false,
  cancelling: false,

  workspaceName: null, // null = not mounted

  plusMenuOpen: false,
  rightRailCollapsed: false,
  terminalOpen: false,
  sidebarSearch: '',

  // Upload seam: pending attachments are presentation-only metadata.
  // No attachment runtime pipeline exists yet — the UI says so.
  attachments: [],
  attachmentsWired: false,

  pythonStatus: 'cold',
  telemetryVersion: 0, // bumped on tool_result so rails re-read Telemetry.records
});

export const activeConversation = computed(() =>
  store.conversations.find((c) => c.id === store.activeConversationId) || null);

export const isViewingLive = computed(() =>
  store.activeConversationId === store.liveConversationId);

// ---------- runtime wiring ----------

function wiredModelClient(body, opts) {
  const h = hooks();
  if (h && typeof h.modelClient === 'function') return h.modelClient(body, opts);
  return callModel(Object.assign({ model: Model.model }, body), opts);
}

function wiredToolExecutor(tool, input, workspace, opts) {
  const h = hooks();
  if (h && typeof h.toolExecutor === 'function') return h.toolExecutor(tool, input, workspace, opts);
  return executeTool(tool, input, workspace, opts);
}

function handleRuntimeEvent(event) {
  const conv = store.conversations.find((c) => c.id === store.liveConversationId);
  if (conv) LocusProjector.projectEvent(conv, event);
  if (event.type === 'tool_result') store.telemetryVersion++;
  if (event.type === 'task_end') {
    store.busy = false;
    store.cancelling = false;
  }
}

export const session = new AgentSession({
  modelClient: wiredModelClient,
  toolExecutor: wiredToolExecutor,
  buildSystemPrompt: buildSystemPrompt,
  emit: handleRuntimeEvent,
  onSessionReset: () => { if (typeof PythonRuntime !== 'undefined') PythonRuntime.reset(); },
});

let workspace = null; // LocalDirectoryWorkspace | null — bound per task

// ---------- settings ----------

export function applySettings() {
  Model.apiKey = store.settings.apiKey.trim();
  Model.apiBase = store.settings.apiBase.trim() || DEFAULTS.apiBase;
  Model.model = store.settings.model.trim() || DEFAULTS.model;
  Model.proxy = store.settings.proxy.trim();
  Model.dialect = store.settings.dialect || 'auto';
}

export function persistSettingsIfNeeded() {
  if (!store.settings.remember) {
    sessionRemove(REMEMBER_SESSION_KEY);
    sessionRemove(SESSION_CONFIG_KEY);
    return;
  }
  // SECURITY NOTE: the API key lives in sessionStorage (per-tab, cleared
  // when the tab closes) only because the user explicitly opted in. It is
  // never written to localStorage, cookies, or any server.
  sessionSet(REMEMBER_SESSION_KEY, '1');
  sessionSet(SESSION_CONFIG_KEY, JSON.stringify({
    apiKey: store.settings.apiKey.trim(),
    apiBase: store.settings.apiBase.trim(),
    model: store.settings.model.trim(),
    proxy: store.settings.proxy.trim(),
    dialect: store.settings.dialect,
  }));
}

export async function testConnection() {
  applySettings();
  store.settingsTesting = true;
  store.settingsResult = null;
  try {
    await verifyConnection(); // eslint-disable-line no-undef
    persistSettingsIfNeeded();
    store.settingsResult = { ok: true, message: 'Connected — ' + Model.model + ' via ' + Model.dialect + ' dialect.' };
  } catch (e) {
    store.settingsResult = { ok: false, message: 'Connection failed: ' + (e && e.message ? e.message : String(e)) };
  } finally {
    store.settingsTesting = false;
  }
}

// ---------- conversations ----------

function startConversation() {
  const conv = LocusProjector.createConversation(conversationSeq++);
  store.conversations.unshift(conv); // newest first, Cowork-style recents
  store.activeConversationId = conv.id;
  store.liveConversationId = conv.id;
  return conv;
}

export function newTask() {
  if (store.busy) session.cancel();
  session.reset();
  store.attachments = [];
  startConversation();
}

export function openConversation(id) {
  store.activeConversationId = id;
}

// ---------- task submission ----------

export async function submit(text) {
  const input = String(text || '').trim();
  if (!input || store.busy) return;
  // Submitting always targets the live session. If the user is viewing an
  // archived conversation, snap back to the live one first — presentation
  // history is never replayed into provider history.
  store.activeConversationId = store.liveConversationId;
  store.plusMenuOpen = false;
  store.busy = true;
  store.cancelling = false;
  try {
    await session.run(input, { workspace: workspace });
  } catch (e) {
    const conv = store.conversations.find((c) => c.id === store.liveConversationId);
    if (conv) {
      LocusProjector.projectEvent(conv, {
        type: 'error',
        code: 'task_rejected',
        message: e && e.message ? e.message : String(e),
      });
      conv.status = 'error';
    }
  } finally {
    store.busy = false;
    store.cancelling = false;
  }
}

export function cancelTask() {
  if (!store.busy || !session.task) return;
  if (!session.task.controller.signal.aborted) {
    session.cancel();
    store.cancelling = true;
  }
}

// ---------- workspace ----------

function waitFor(cond, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (cond()) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function pickDirectory() {
  const h = hooks();
  if (h && typeof h.pickDirectory === 'function') return h.pickDirectory();
  if (!window.showDirectoryPicker) {
    throw new Error('This browser does not support the File System Access API (use desktop Chrome / Edge).');
  }
  return window.showDirectoryPicker({ mode: 'readwrite' });
}

// Mount folder: real File System Access API flow (same semantics as the
// old ui.js selectWorkspace): never switch under a live task, permission
// check, then a full session boundary (history + generation + Python).
export async function mountFolder() {
  store.plusMenuOpen = false;
  let handle;
  try {
    handle = await pickDirectory();
  } catch (e) {
    if (e && e.name === 'AbortError') return; // user cancelled the picker
    const conv = store.conversations.find((c) => c.id === store.liveConversationId);
    if (conv) {
      LocusProjector.projectEvent(conv, {
        type: 'warning', code: 'workspace_picker',
        message: 'Mount folder failed: ' + (e && e.message ? e.message : String(e)),
      });
    }
    return;
  }

  if (store.busy) {
    session.cancel();
    const stopped = await waitFor(() => !store.busy, 10000);
    if (!stopped) return; // task would not stop — keep the old workspace
  }

  const granted = await ensureWorkspacePermission(handle);
  if (!granted) return;

  workspace = new LocalDirectoryWorkspace(handle);
  store.workspaceName = workspace.name;
  // Full session boundary, only on success.
  session.reset();
  store.attachments = [];
  startConversation();
}

// ---------- composer + menu actions ----------

export function togglePlusMenu() {
  store.plusMenuOpen = !store.plusMenuOpen;
}

// Upload files: the UI seam exists and collects real File metadata, but
// no attachment runtime pipeline is wired into AgentSession yet — the
// chips say so instead of faking success.
export function uploadFiles() {
  store.plusMenuOpen = false;
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.addEventListener('change', () => {
    for (const f of input.files || []) {
      store.attachments.push({ name: f.name, size: f.size, type: f.type || 'file' });
    }
  });
  input.click();
}

export function removeAttachment(index) {
  store.attachments.splice(index, 1);
}

export function openTerminal() {
  store.plusMenuOpen = false;
  store.terminalOpen = true;
}

// ---------- boot ----------

applySettings();
startConversation();
