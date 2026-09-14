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
   Telemetry, LocusProjector, VirtualWorkspace, SHELL_COMMANDS */

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
  // Drawer open/close is PURE presentation state: it never enters
  // AgentSession, provider history, or any runtime structure.
  sidebarDrawerOpen: false,  // <700px: sidebar as left overlay drawer
  contextDrawerOpen: false,  // <1100px: context rail as right overlay drawer
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

function handleRuntimeEvent(event) {
  const targetId = runningConversationId !== null ? runningConversationId : store.liveConversationId;
  const conv = store.conversations.find((c) => c.id === targetId);
  if (conv) LocusProjector.projectEvent(conv, event);
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
  if (!input || store.busy) return;
  // Submitting always targets the live session. If the user is viewing an
  // archived conversation, snap back to the live one first — presentation
  // history is never replayed into provider history.
  store.activeConversationId = store.liveConversationId;
  store.plusMenuOpen = false;
  store.busy = true;
  store.cancelling = false;
  // Bind this task's events to the conversation that is live NOW, before
  // run() starts. If newTask()/mountFolder() later moves liveConversationId
  // while this task is still settling, its tail events still land here.
  if (store.liveConversationId == null) startConversation(); // defensive: never route into a random conversation
  runningConversationId = store.liveConversationId;
  const boundId = runningConversationId;
  try {
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
  const provider = new LocalDirectoryWorkspace(handle);
  vfs.mount('/mnt/workspace', provider, 'external-read-write');
  store.workspaceName = provider.name;
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

// One trigger, two presentations: desktop toggles the static rail in/out
// of the flex row; tablet/mobile open the same ContextRail as a drawer.
export function toggleContextPanel() {
  store.plusMenuOpen = false;
  if (narrowMq && narrowMq.matches) {
    if (store.rightRailCollapsed) store.rightRailCollapsed = false; // rail must be mounted to open as a drawer
    store.contextDrawerOpen = !store.contextDrawerOpen;
  } else {
    store.rightRailCollapsed = !store.rightRailCollapsed;
  }
}

export function openSidebarDrawer() {
  store.plusMenuOpen = false;
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

// ---------- boot ----------

applySettings();
startConversation();
refreshArtifacts(); // initial artifacts listing (fire-and-forget, self-guarded)
