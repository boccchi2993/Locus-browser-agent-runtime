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
//  Telemetry, LocusProjector, VirtualWorkspace, SHELL_COMMANDS) come from
//  the classic scripts loaded by index.html before this module — same as
//  the old ui.js wiring.
// ============================================================

import { reactive, computed } from 'vue';

/* global AgentSession, Model, callModel, executeTool, buildSystemPrompt,
   LocalDirectoryWorkspace, ensureWorkspacePermission, PythonRuntime,
   Telemetry, LocusProjector, VirtualWorkspace, SHELL_COMMANDS,
   PersistenceServiceInstance, OPFSWorkspace, ConversationHistoryWorkspace,
   getProviderAdapter, projectNormalizedHistory */

// ONE persistent VFS for the whole page lifetime. All static mounts
// (home/tmp/upload/download/bin/usrbin) are wired inside the constructor;
// /mnt/workspace is added/replaced by mountFolder(). The command list is
// injected lazily so this module never depends on script load order.
const vfs = new VirtualWorkspace({ listCommands: () => Object.keys(SHELL_COMMANDS) });
export { vfs };

const UPLOAD_ROOT = '/mnt/upload';
const ARTIFACTS_ROOT = '/mnt/download';

const REMEMBER_SESSION_KEY = 'bar.v0.rememberSessionKey.v1';
const SESSION_CONFIG_KEY = 'bar.v0.sessionConfig.v1';

const DEFAULTS = {
  apiKey: '',
  apiBase: 'https://api.deepseek.com/anthropic',
  model: 'deepseek-flash',
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

function durableId(prefix) {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

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
  workspacePermission: 'none', // none | granted | prompt | denied | stale
  workspaceHandleAvailable: false,

  storageStatus: { mode: 'memory', dbName: 'locus', schemaVersion: 1, opfs: false, persistent: null, usage: null, quota: null, error: null },
  storageNotice: null,

  plusMenuOpen: false,
  rightRailCollapsed: false,
  // Drawer open/close is PURE presentation state: it never enters
  // AgentSession, provider history, or any runtime structure.
  sidebarDrawerOpen: false,  // <700px: sidebar as left overlay drawer
  contextDrawerOpen: false,  // <1100px: context rail as right overlay drawer
  narrowLayout: false,       // reactive mirror of the single <1100px matchMedia boundary
  terminalOpen: false,
  sidebarSearch: '',

  // Uploads are real browser File objects held by the VFS at
  // /mnt/upload (read-only to the agent). attachments is UI metadata
  // mirroring what the user put there: { name, path, size, type }.
  attachments: [],
  attachmentsWired: true,

  // Downloadable artifacts: files the agent wrote under /mnt/download.
  // Refreshed on boot and after every tool_result (telemetryVersion).
  artifacts: [],

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

// Conversation identity semantics — three DIFFERENT concepts, never merge:
//   activeConversationId  — which conversation the user is looking at.
//   liveConversationId    — which conversation the current AgentSession
//                           session maps to (moved by newTask/mountFolder).
//   runningConversationId — which conversation the in-flight runtime task's
//                           events MUST project into, bound at submit() time.
// A task's events follow the task, not whichever conversation happens to be
// live when a tail event (warning/session_changed/task_end) arrives.
let runningConversationId = null;

let persistenceContext = null;
let persistenceBootPromise = null;
let persistenceBootComplete = false;
let pendingCancel = false;

function persistConversation(conv) {
  if (!conv || typeof PersistenceServiceInstance === 'undefined') return Promise.resolve();
  return PersistenceServiceInstance.saveConversation(Object.assign({}, conv, {
    // Private counters are useful for deterministic ordering after reload;
    // the actual protocol truth remains in the dedicated stores.
    presentationSequence: conv.presentationSequence || 0,
  })).catch(() => {});
}

function providerConfig() {
  const adapter = getProviderAdapter({ dialect: store.settings.dialect, apiBase: store.settings.apiBase });
  return {
    provider: adapter.providerFamily || adapter.dialect,
    adapterId: adapter.adapterId || adapter.dialect,
    dialect: adapter.dialect,
    apiBase: store.settings.apiBase,
    model: store.settings.model,
  };
}

function sessionCompatible(meta, config) {
  try {
    const adapter = getProviderAdapter({ dialect: config.dialect, apiBase: config.apiBase });
    return !!(adapter && typeof adapter.isRawReplayCompatible === 'function'
      && adapter.isRawReplayCompatible(meta, { dialect: config.dialect, apiBase: config.apiBase }));
  } catch (e) { return false; }
}

async function ensureProviderSession(conv) {
  if (typeof PersistenceServiceInstance === 'undefined' || typeof getProviderAdapter !== 'function') return null;
  const service = PersistenceServiceInstance;
  const config = providerConfig();
  let previous = conv && conv.activeProviderSessionId ? await service.get('providerSessions', conv.activeProviderSessionId) : null;
  if (!previous) previous = conv ? await service.loadProviderSession(conv.id) : null;
  if (previous && sessionCompatible(previous, config)) {
    if (previous.nextFrameSequence == null) {
      const frames = await service.loadProviderFrames(previous.id);
      previous.nextFrameSequence = frames.reduce((n, f) => Math.max(n, f.sequence || 0), 0);
    }
    if (previous.nextNormalizedSequence == null) {
      const messages = await service.loadNormalizedMessages(conv.id);
      previous.nextNormalizedSequence = messages.reduce((n, m) => Math.max(n, m.sequence || 0), 0);
    }
    if (conv.activeProviderSessionId !== previous.id) {
      conv.activeProviderSessionId = previous.id;
      await persistConversation(conv);
    }
    return previous;
  }
  const row = {
    id: durableId('provider-session'), conversationId: conv.id,
    provider: config.provider, adapterId: config.adapterId, dialect: config.dialect,
    model: config.model, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    replayCheckpointSequence: 0, nextFrameSequence: 0, nextNormalizedSequence: 0, schemaVersion: 1,
  };
  row._projectedHistory = await service.loadNormalizedMessages(conv.id);
  const persistedRow = Object.assign({}, row);
  delete persistedRow._projectedHistory;
  await service.saveProviderSession(persistedRow);
  conv.activeProviderSessionId = row.id;
  await persistConversation(conv);
  return row;
}

async function restoreSessionForConversation(conv) {
  if (!conv || typeof PersistenceServiceInstance === 'undefined') return null;
  const config = providerConfig();
  const previous = conv.activeProviderSessionId
    ? await PersistenceServiceInstance.get('providerSessions', conv.activeProviderSessionId)
    : await PersistenceServiceInstance.loadProviderSession(conv.id);
  session.reset();
  if (!previous) return null;
  if (sessionCompatible(previous, config)) {
    const frames = await PersistenceServiceInstance.loadProviderFrames(previous.id, previous.replayCheckpointSequence);
    session.history = frames.map((f) => f.raw).filter(Boolean);
  } else {
    const normalized = await PersistenceServiceInstance.loadNormalizedMessages(conv.id);
    session.history = projectNormalizedHistory(normalized, config.dialect);
  }
  return previous;
}

function makePersistenceContext(conv, providerSession) {
  let frameSequence = providerSession.nextFrameSequence || 0;
  let normalizedSequence = providerSession.nextNormalizedSequence || 0;
  return {
    async onUserMessage(text) {
      const raw = { role: 'user', content: text };
      await PersistenceServiceInstance.appendProviderFrame({
        sessionId: providerSession.id, conversationId: conv.id,
        sequence: ++frameSequence, turnId: providerSession.id,
        direction: 'outbound', role: 'user', kind: 'user', raw: raw,
      });
      await PersistenceServiceInstance.saveNormalizedMessage({
        conversationId: conv.id, sequence: ++normalizedSequence,
        role: 'user', kind: 'message', text: text,
      });
      providerSession.nextFrameSequence = frameSequence;
      providerSession.nextNormalizedSequence = normalizedSequence;
      // A user frame is a safe replay boundary. If the browser dies before
      // the provider answers, the next run can still resume from this turn
      // without replaying a dangling assistant/tool frame.
      providerSession.replayCheckpointSequence = frameSequence;
      providerSession.updatedAt = new Date().toISOString();
      await PersistenceServiceInstance.saveProviderSession(providerSession);
    },
    async onProviderFrame(payload) {
      const raw = payload.raw || null;
      const frame = await PersistenceServiceInstance.appendProviderFrame({
        sessionId: providerSession.id, conversationId: conv.id,
        sequence: ++frameSequence, turnId: providerSession.id,
        direction: payload.role === 'assistant' ? 'inbound' : 'outbound',
        role: payload.role || (raw && raw.role) || null, kind: payload.kind || 'message', raw: raw,
        toolCallId: payload.toolCallId || null,
      });
      providerSession.updatedAt = new Date().toISOString();
      providerSession.nextFrameSequence = frameSequence;
      providerSession.nextNormalizedSequence = normalizedSequence;
      if (payload.rawResponse) {
        await PersistenceServiceInstance.saveNormalizedMessage({
          conversationId: conv.id, sequence: ++normalizedSequence,
          role: 'assistant', kind: payload.rawResponse.toolCalls ? 'tool_call' : 'message', text: payload.rawResponse.content || '',
          reasoning: payload.rawResponse.reasoning || null,
          toolCalls: payload.rawResponse.toolCalls || null,
        });
      }
      providerSession.nextNormalizedSequence = normalizedSequence;
      await PersistenceServiceInstance.saveProviderSession(providerSession);
      return frame;
    },
    async onNormalizedMessage(payload) {
      const row = await PersistenceServiceInstance.saveNormalizedMessage(Object.assign({}, payload, {
        conversationId: conv.id, sequence: ++normalizedSequence,
      }));
      providerSession.nextNormalizedSequence = normalizedSequence;
      await PersistenceServiceInstance.saveProviderSession(providerSession);
      return row;
    },
    async onCheckpoint(payload) {
      if (!payload || !payload.frame) return;
      providerSession.replayCheckpointSequence = payload.frame.sequence || providerSession.replayCheckpointSequence || 0;
      providerSession.updatedAt = new Date().toISOString();
      await PersistenceServiceInstance.saveProviderSession(providerSession);
    },
  };
}

function handleRuntimeEvent(event) {
  const targetId = runningConversationId !== null ? runningConversationId : store.liveConversationId;
  const conv = store.conversations.find((c) => c.id === targetId);
  if (conv) {
    LocusProjector.projectEvent(conv, event);
    conv.presentationSequence = (conv.presentationSequence || 0) + 1;
    if (event.type === 'task_start') conv.runState = 'running';
    if (event.type === 'task_end') conv.runState = 'idle';
    persistConversation(conv);
    if (typeof PersistenceServiceInstance !== 'undefined') {
      PersistenceServiceInstance.appendPresentationEvent(conv.id, conv.presentationSequence, event).catch(() => {});
    }
  }
  if (event.type === 'tool_result') store.telemetryVersion++;
  if (event.type === 'task_end') {
    // Reliable lifecycle end: release the binding only when the task that
    // owned it reports its end.
    runningConversationId = null;
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

// The VFS (declared at module scope above) replaces the raw adapter in
// the workspace slot: buildSystemPrompt and the tool executor both
// receive it (buildSystemPrompt reads workspace.workspaceName; tools
// route every path through the mounts).

// ---------- settings ----------

export function applySettings() {
  Model.apiKey = store.settings.apiKey.trim();
  Model.apiBase = store.settings.apiBase.trim() || DEFAULTS.apiBase;
  Model.model = store.settings.model.trim() || DEFAULTS.model;
  Model.proxy = store.settings.proxy.trim();
  Model.dialect = store.settings.dialect || 'auto';
}

export async function persistSettingsIfNeeded() {
  if (typeof PersistenceServiceInstance === 'undefined') return;
  await PersistenceServiceInstance.saveSettings(store.settings);
  await PersistenceServiceInstance.setRememberedApiKey(store.settings.apiKey, !!store.settings.remember);
  sessionRemove(REMEMBER_SESSION_KEY);
  sessionRemove(SESSION_CONFIG_KEY);
}

export async function testConnection() {
  applySettings();
  store.settingsTesting = true;
  store.settingsResult = null;
  try {
    await verifyConnection(); // eslint-disable-line no-undef
    await persistSettingsIfNeeded();
    store.settingsResult = { ok: true, message: 'Connected — ' + Model.model + ' via ' + Model.dialect + ' dialect.' };
  } catch (e) {
    store.settingsResult = { ok: false, message: 'Connection failed: ' + (e && e.message ? e.message : String(e)) };
  } finally {
    store.settingsTesting = false;
  }
}

// ---------- conversations ----------

function startConversation() {
  const conv = LocusProjector.createConversation(durableId('conversation'));
  conv.presentationSequence = 0;
  store.conversations.unshift(conv); // newest first, Cowork-style recents
  store.activeConversationId = conv.id;
  store.liveConversationId = conv.id;
  persistConversation(conv);
  return conv;
}

export function newTask() {
  // Cancel + reset the old session, but do NOT touch runningConversationId:
  // the old task's tail events (session_changed / task_end) must still
  // project into ITS conversation. The new conversation becomes live/active
  // immediately, yet never receives the old task's events. store.busy stays
  // true until the old task actually ends — the AgentSession concurrent-run
  // guard is never bypassed by flipping UI flags early.
  if (store.busy) session.cancel();
  session.reset();
  clearAttachments();
  startConversation();
}

export function openConversation(id) {
  store.activeConversationId = id;
}

// ---------- task submission ----------

export async function submit(text) {
  const input = String(text || '').trim();
  if (!input) return;
  const waitingForPersistence = !!persistenceBootPromise && !persistenceBootComplete;
  if (store.busy && !waitingForPersistence) return;
  if (waitingForPersistence) {
    // The page can become interactive before IndexedDB/OPFS restoration has
    // finished. Hold the composer in a busy state while boot settles so a
    // first task cannot race boot's conversation/session restoration.
    store.busy = true;
    store.cancelling = false;
    try { await persistenceBootPromise; } catch (e) {}
  }
  // An idle user may open an archived conversation and continue it. The
  // presentation-only switch remains harmless while another task is live;
  // only submission rebinds the session to the selected conversation.
  if (store.activeConversationId && store.activeConversationId !== store.liveConversationId) {
    const selected = store.conversations.find((c) => c.id === store.activeConversationId);
    if (selected) {
      store.liveConversationId = selected.id;
      await restoreSessionForConversation(selected);
    }
  }
  // Submitting always targets the live session. If the user is viewing an
  // archived conversation, snap back to the live one first — presentation
  // history is never replayed into provider history.
  store.activeConversationId = store.liveConversationId;
  store.plusMenuOpen = false;
  store.busy = true;
  store.cancelling = false;
  pendingCancel = false;
  // Bind this task's events to the conversation that is live NOW, before
  // run() starts. If newTask()/mountFolder() later moves liveConversationId
  // while this task is still settling, its tail events still land here.
  if (store.liveConversationId == null) startConversation(); // defensive: never route into a random conversation
  runningConversationId = store.liveConversationId;
  const boundId = runningConversationId;
  const boundConversation = store.conversations.find((c) => c.id === boundId);
  const submitGeneration = session.generation;
  const finishPreRunSessionSwitch = () => {
    // Persistence can still be committing the first user frame when a
    // workspace/new-task boundary or cancel arrives. Preserve that intent in
    // the presentation projection before recording the terminal outcome, so
    // the interrupted attempt remains visible in recents.
    if (boundConversation && !boundConversation.items.length && boundConversation.status === 'idle') {
      handleRuntimeEvent({ type: 'task_start', input: input });
    }
    if (pendingCancel) {
      handleRuntimeEvent({
        type: 'warning',
        code: 'task_cancelled',
        message: '任务已取消，尚未开始模型请求。',
      });
      handleRuntimeEvent({ type: 'task_end', reason: 'cancelled' });
      return true;
    }
    if (session.generation === submitGeneration) return false;
    handleRuntimeEvent({
      type: 'warning',
      code: 'session_changed',
      message: '会话已切换，丢弃本次任务的后续结果。',
    });
    handleRuntimeEvent({ type: 'task_end', reason: 'session_changed' });
    return true;
  };
  try {
    if (typeof PersistenceServiceInstance !== 'undefined' && typeof getProviderAdapter === 'function') {
      const providerSession = await ensureProviderSession(boundConversation);
      if (finishPreRunSessionSwitch()) return;
      persistenceContext = makePersistenceContext(boundConversation, providerSession);
      if (providerSession && Array.isArray(providerSession._projectedHistory)
        && providerSession._projectedHistory.length) {
        if (typeof session.reset === 'function') session.reset();
        session.history = projectNormalizedHistory(providerSession._projectedHistory, providerConfig().dialect);
        delete providerSession._projectedHistory;
      }
      boundConversation.runState = 'running';
      boundConversation.updatedAt = new Date().toISOString();
      await persistConversation(boundConversation);
      // Durable ordering: user presentation/semantic/provider state is
      // committed before AgentSession can make the first model request.
      await persistenceContext.onUserMessage(input);
      if (finishPreRunSessionSwitch()) return;
      if (typeof session.setPersistenceContext === 'function') session.setPersistenceContext(persistenceContext);
    }
    // run() resolves only AFTER task_end has been emitted (the binding is
    // released by handleRuntimeEvent at that point) — so by the time this
    // await returns, no late event of this task can still be in flight.
    //
    // The task binds a FORK of the live VFS: same providers, but a private
    // mount table. A workspace switch mid-task (mountFolder replaces the
    // /mnt/workspace provider on the live VFS) can never rebind this task's
    // filesystem routing — its late async operations keep touching the OLD
    // provider, and the generation/abort guards drop its results.
    await session.run(input, { workspace: vfs.fork() });
  } catch (e) {
    // run() threw without a normal task lifecycle (e.g. the concurrent-run
    // guard): no task_end will arrive, so release the binding here instead
    // of leaving a stale route for some future task's events.
    if (runningConversationId === boundId) runningConversationId = null;
    const conv = store.conversations.find((c) => c.id === boundId);
    if (conv) {
      LocusProjector.projectEvent(conv, {
        type: 'error',
        code: 'task_rejected',
        message: e && e.message ? e.message : String(e),
      });
      conv.status = 'error';
    }
  } finally {
    if (typeof session.setPersistenceContext === 'function') session.setPersistenceContext(null);
    persistenceContext = null;
    pendingCancel = false;
    store.busy = false;
    store.cancelling = false;
  }
}

export function cancelTask() {
  if (!store.busy) return;
  if (!session.task) {
    pendingCancel = true;
    store.cancelling = true;
    return;
  }
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

async function mountExternalHandle(handle, persistHandle) {
  const provider = new LocalDirectoryWorkspace(handle);
  vfs.mount('/mnt/workspace', provider, 'external-read-write');
  store.workspaceName = provider.name;
  store.workspacePermission = 'granted';
  store.workspaceHandleAvailable = true;
  if (persistHandle && typeof PersistenceServiceInstance !== 'undefined') {
    await PersistenceServiceInstance.saveWorkspaceHandle(handle);
  }
  return provider;
}

async function mountDurableStorage() {
  if (typeof PersistenceServiceInstance === 'undefined') return;
  try {
    const homeDir = await PersistenceServiceInstance.opfsDirectory(['home', 'locus'], true);
    vfs.mount('/home/locus', new OPFSWorkspace(homeDir, { name: 'home' }), 'read-write');
  } catch (e) {
    store.storageNotice = 'Durable home storage unavailable; using memory-only home for this session.';
  }
  try {
    const pluginDir = await PersistenceServiceInstance.opfsDirectory(['mnt', 'plugins'], true);
    vfs.mount('/mnt/plugins', new OPFSWorkspace(pluginDir, { name: 'plugins' }), 'system-read-only');
  } catch (e) {}
  try {
    vfs.mount('/home/locus/history', new ConversationHistoryWorkspace(PersistenceServiceInstance), 'system-read-only');
  } catch (e) {}
}

async function restoreWorkspaceHandle() {
  if (typeof PersistenceServiceInstance === 'undefined') return;
  const handle = await PersistenceServiceInstance.loadWorkspaceHandle();
  if (!handle) return;
  store.workspaceHandleAvailable = true;
  try {
    if (handle.queryPermission) {
      const state = await handle.queryPermission({ mode: 'readwrite' });
      if (state === 'granted') {
        await mountExternalHandle(handle, false);
      } else if (state === 'prompt') {
        store.workspacePermission = 'prompt';
      } else {
        store.workspacePermission = 'denied';
      }
    } else {
      await mountExternalHandle(handle, false);
    }
  } catch (e) {
    store.workspacePermission = 'stale';
    store.storageNotice = 'The saved external folder is no longer available. Choose Reconnect to select it again.';
  }
}

export async function reconnectWorkspace() {
  if (typeof PersistenceServiceInstance === 'undefined') return;
  const handle = await PersistenceServiceInstance.loadWorkspaceHandle();
  if (!handle) return mountFolder();
  try {
    const granted = await ensureWorkspacePermission(handle);
    if (!granted) { store.workspacePermission = 'denied'; return; }
    await mountExternalHandle(handle, false);
    store.storageNotice = null;
  } catch (e) {
    store.workspacePermission = 'stale';
    store.storageNotice = 'Reconnect failed: ' + (e && e.message ? e.message : String(e));
  }
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

  const granted = await ensureWorkspacePermission(handle);
  if (!granted) return;

  // FINAL busy gate, AFTER the picker + permission awaits: a task may have
  // been submitted while those prompts were open. Cancel and wait for it
  // HERE — never mount a new workspace underneath a live task.
  if (store.busy) {
    session.cancel();
    const stopped = await waitFor(() => !store.busy, 10000);
    if (!stopped) return; // task would not stop — keep the old workspace
  }

  // Re-mounting a different folder replaces the provider at /mnt/workspace.
  // In-flight tasks hold a fork() of this VFS (see submit) and keep routing
  // to the OLD provider — this mutation only affects future tasks.
  await mountExternalHandle(handle, true);
  // Full session boundary, only on success.
  session.reset();
  clearAttachments();
  startConversation();
}

// ---------- composer + menu actions ----------

export function togglePlusMenu() {
  store.plusMenuOpen = !store.plusMenuOpen;
}

// Canonical narrow-layout boundary for JS: the ONLY breakpoint JS knows.
// Layout itself is owned by CSS media queries in theme.css (700px / 1100px);
// this matchMedia exists solely so the rail toggle can pick between the
// desktop static collapse and the <1100px drawer. Never derive layout
// decisions from window.innerWidth elsewhere.
const narrowMq = (typeof window !== 'undefined' && typeof window.matchMedia === 'function')
  ? window.matchMedia('(max-width: 1099px)')
  : null;

// Keep the JS-only interaction state reactive when the viewport crosses the
// one breakpoint JS needs to know about. CSS still owns the actual layout.
if (narrowMq) {
  store.narrowLayout = narrowMq.matches;
  const syncNarrowLayout = (event) => {
    store.narrowLayout = !!event.matches;
    if (!store.narrowLayout) store.contextDrawerOpen = false;
  };
  if (typeof narrowMq.addEventListener === 'function') {
    narrowMq.addEventListener('change', syncNarrowLayout);
  } else if (typeof narrowMq.addListener === 'function') {
    narrowMq.addListener(syncNarrowLayout);
  }
}

// One trigger, two presentations: desktop toggles the static rail in/out
// of the flex row; tablet/mobile open the same ContextRail as a drawer.
export function toggleContextPanel() {
  store.plusMenuOpen = false;
  if (store.narrowLayout) {
    if (store.rightRailCollapsed) store.rightRailCollapsed = false; // rail must be mounted to open as a drawer
    const next = !store.contextDrawerOpen;
    store.contextDrawerOpen = next;
    if (next) store.sidebarDrawerOpen = false; // only one modal drawer owns focus at a time
  } else {
    store.contextDrawerOpen = false;
    store.rightRailCollapsed = !store.rightRailCollapsed;
  }
}

export function openSidebarDrawer() {
  store.plusMenuOpen = false;
  store.contextDrawerOpen = false;
  store.sidebarDrawerOpen = true;
}

export function closeDrawers() {
  store.sidebarDrawerOpen = false;
  store.contextDrawerOpen = false;
}

// ---------- uploads (/mnt/upload, real File objects) ----------

function uploadProvider() {
  return vfs.resolveMount(UPLOAD_ROOT).provider; // UploadWorkspace, always mounted
}

// Surface a warning in the LIVE conversation via the same projector path
// the runtime uses (e.g. the workspace-picker warning in mountFolder).
function projectUploadWarning(message) {
  const conv = store.conversations.find((c) => c.id === store.liveConversationId);
  if (conv) {
    LocusProjector.projectEvent(conv, {
      type: 'warning', code: 'upload_skipped', message: message,
    });
  }
}

// Add browser File objects to /mnt/upload. The provider assigns the final
// (collision-safe) name; quota overflows skip that file and surface a
// conversation warning instead of failing the whole batch.
export function addUploadFiles(fileList) {
  const provider = uploadProvider();
  const skipped = [];
  for (const f of fileList || []) {
    try {
      const finalName = provider.addFile(f);
      store.attachments.push({
        name: finalName,
        path: UPLOAD_ROOT + '/' + finalName,
        size: f.size || 0,
        type: f.type || 'file',
      });
    } catch (e) {
      skipped.push((f && f.name ? f.name : 'file')
        + ' (' + (e && e.message ? e.message : String(e)) + ')');
    }
  }
  if (skipped.length) {
    projectUploadWarning('Not uploaded — ' + skipped.join('; '));
  }
}

// File picker → addUploadFiles. Uploads never leave the browser.
export function uploadFiles() {
  store.plusMenuOpen = false;
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.addEventListener('change', () => { addUploadFiles(input.files); });
  input.click();
}

export function removeAttachment(index) {
  const a = store.attachments[index];
  if (!a) return;
  try { uploadProvider().removeFile(a.name); } catch (e) { /* already gone */ }
  store.attachments.splice(index, 1);
}

// Session boundaries (new task / folder change) drop the user's uploads
// from BOTH the UI metadata and the VFS — the two never drift apart.
function clearAttachments() {
  const provider = uploadProvider();
  for (const a of store.attachments) {
    try { provider.removeFile(a.name); } catch (e) { /* already gone */ }
  }
  store.attachments = [];
}

// ---------- artifacts (/mnt/download, explicit Download UI) ----------

// Recursively walk /mnt/download → [{ path (relative), size }], sorted.
// Errors (transient provider faults) keep the previous list — artifacts
// are a display surface, never a source of truth.
export async function refreshArtifacts() {
  const found = [];
  async function walk(rel) {
    const entries = await vfs.list(rel ? ARTIFACTS_ROOT + '/' + rel : ARTIFACTS_ROOT);
    for (const e of entries) {
      const child = rel ? rel + '/' + e.name : e.name;
      if (e.kind === 'directory') {
        await walk(child);
      } else {
        const st = await vfs.stat(ARTIFACTS_ROOT + '/' + child);
        found.push({ path: child, size: st.size || 0 });
      }
    }
  }
  try {
    await walk('');
  } catch (e) {
    return;
  }
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  store.artifacts = found;
}

// Explicit user action only: read bytes from the VFS, hand them to the
// browser as a blob download. Never automatic, never the network.
export async function downloadArtifact(path) {
  const bytes = await vfs.readBytes(ARTIFACTS_ROOT + '/' + path);
  const blob = new Blob([bytes]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = String(path).split('/').pop() || 'artifact';
  a.click();
  URL.revokeObjectURL(url);
}

export function openTerminal() {
  store.plusMenuOpen = false;
  store.terminalOpen = true;
}

// ---------- storage controls ----------

export async function refreshStorageStatus() {
  if (typeof PersistenceServiceInstance === 'undefined') return;
  store.storageStatus = await PersistenceServiceInstance.storageStatus();
}

export async function keepDataOnThisDevice() {
  if (typeof PersistenceServiceInstance === 'undefined') return false;
  const granted = await PersistenceServiceInstance.requestPersistentStorage();
  await refreshStorageStatus();
  return granted;
}

export async function clearConversations() {
  if (typeof PersistenceServiceInstance !== 'undefined') await PersistenceServiceInstance.clearConversations();
  store.conversations = [];
  session.reset();
  startConversation();
}

export async function clearHome() {
  if (typeof PersistenceServiceInstance !== 'undefined') await PersistenceServiceInstance.clearHome();
  await mountDurableStorage();
}

export async function clearPlugins() {
  if (typeof PersistenceServiceInstance !== 'undefined') await PersistenceServiceInstance.clearPlugins();
  await mountDurableStorage();
}

export async function forgetApiKeys() {
  store.settings.apiKey = '';
  store.settings.remember = false;
  Model.apiKey = '';
  if (typeof PersistenceServiceInstance !== 'undefined') await PersistenceServiceInstance.forgetApiKeys();
}

export async function resetAllData() {
  if (typeof PersistenceServiceInstance !== 'undefined') await PersistenceServiceInstance.reset();
  if (typeof vfs.resetEphemeral === 'function') vfs.resetEphemeral();
  store.attachments = [];
  store.artifacts = [];
  store.settings = Object.assign({}, DEFAULTS);
  applySettings();
  store.conversations = [];
  store.activeConversationId = null;
  store.liveConversationId = null;
  session.reset();
  await mountDurableStorage();
  startConversation();
  await refreshStorageStatus();
}

// ---------- boot ----------

applySettings();
startConversation();
refreshArtifacts(); // initial artifacts listing (fire-and-forget, self-guarded)

async function bootPersistence() {
  if (typeof PersistenceServiceInstance === 'undefined') return;
  await PersistenceServiceInstance.ready;
  try {
    const settings = await PersistenceServiceInstance.loadSettings();
    for (const key of ['apiBase', 'model', 'proxy', 'dialect']) {
      if (settings[key]) store.settings[key] = settings[key];
    }
    if (settings.remember && settings.apiKey) {
      store.settings.apiKey = settings.apiKey;
      store.settings.remember = true;
    } else {
      store.settings.apiKey = '';
      store.settings.remember = false;
    }
    applySettings();
    await mountDurableStorage();
    const rows = await PersistenceServiceInstance.loadConversations();
    if (rows.length) {
      rows.forEach((c) => { if (c.runState === 'running') { c.runState = 'interrupted'; c.status = 'interrupted'; } });
      store.conversations = rows;
      const continuation = rows.find((c) => c.items && c.items.length || c.status && c.status !== 'idle') || rows[0];
      store.activeConversationId = continuation.id;
      store.liveConversationId = continuation.id;
      await restoreSessionForConversation(continuation);
      for (const c of rows) await persistConversation(c);
    }
    await restoreWorkspaceHandle();
    await refreshStorageStatus();
  } catch (e) {
    store.storageNotice = 'Persistence initialization failed; Locus is running in memory-only mode.';
    try { await refreshStorageStatus(); } catch (ignored) {}
  }
}

persistenceBootPromise = bootPersistence();
persistenceBootPromise.then(
  () => { persistenceBootComplete = true; },
  () => { persistenceBootComplete = true; },
);
