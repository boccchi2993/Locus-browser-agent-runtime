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

  // Projection of the ApprovalController's canonical pending state (set
  // via its onChange hook). Null = nothing awaiting a human decision.
  // Approval is orthogonal to the task lifecycle: while this is set the
  // running task is still ALIVE — runState stays 'running', only the
  // composer/card reflect the suspension.
  pendingApproval: null,

  workspaceName: null, // null = not mounted
  workspacePermission: 'none', // none | granted | prompt | denied | stale
  workspaceHandleAvailable: false,

  storageStatus: { mode: 'memory', dbName: 'locus', schemaVersion: 2, opfs: false, persistent: null, usage: null, quota: null, error: null, persistenceHealth: 'healthy', lastPersistenceError: null },
  storageNotice: null,

  // Read-only projection of the image-capability registry for Settings
  // (docs/IMAGE-INPUT.md): { state: supported|unsupported|unknown,
  // source: user|probe|builtin|provider-rejection|none } or null.
  imageCapability: null,

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
  const invoke = () => (h && typeof h.modelClient === 'function')
    ? h.modelClient(body, opts)
    : callModel(Object.assign({ model: Model.model }, body), opts);
  return invoke().catch(async (e) => {
    // Authoritative provider rejection of IMAGE input (docs/IMAGE-INPUT.md):
    // ONLY an explicit model-level capability rejection (classifier kind
    // 'model_unsupported' — e.g. "this model does not support image input")
    // downgrades the registry. A rejected/corrupt IMAGE INSTANCE
    // ('invalid_image') or an unsupported FORMAT ('mime_unsupported') is an
    // input failure, never capability evidence: the registry keeps its
    // previous state. Auth/quota/404/5xx/timeouts/parse failures and any
    // other ambiguous error never do either. The error is rethrown
    // unchanged — the agent's conservative fallback policy applies (no
    // automatic image-less resend, no double inference).
    try {
      if (typeof classifyImageProviderError === 'function'
        && classifyImageProviderError(e).kind === 'model_unsupported') {
        const identity = imageInputIdentity();
        const s = ensureImageStores();
        if (identity && s) await s.registry.recordProviderRejection(identity, e && e.message);
      }
    } catch (ignored) { /* registry best-effort on the error path */ }
    throw e;
  });
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
let storageMutationTail = Promise.resolve();
const STORAGE_MUTATION_TIMEOUT_MS = 10000;

function reportPersistenceIssue(error, message) {
  const detail = error && error.message ? error.message : String(error || 'unknown persistence error');
  store.storageNotice = (message || 'Durable storage failed') + ': ' + detail;
  if (typeof PersistenceServiceInstance !== 'undefined'
      && typeof PersistenceServiceInstance.notePersistenceError === 'function') {
    PersistenceServiceInstance.notePersistenceError(error, message || 'persistence');
  }
}

function isPersistenceFailure(error) {
  return !!(error && (error.persistenceFailure || error.code === 'persistence_write_failed'
    || error.name === 'PersistenceError' || error.name === 'StorageClearError'));
}

function persistConversation(conv) {
  if (!conv || typeof PersistenceServiceInstance === 'undefined') return Promise.resolve();
  const options = arguments[1] || {};
  return PersistenceServiceInstance.saveConversation(Object.assign({}, conv, {
    // Private counters are useful for deterministic ordering after reload;
    // the actual protocol truth remains in the dedicated stores.
    presentationSequence: conv.presentationSequence || 0,
  })).catch((e) => {
    reportPersistenceIssue(e, 'Conversation snapshot could not be saved');
    if (options.required) throw e;
    return null;
  });
}

function providerConfig() {
  const adapter = getProviderAdapter({ dialect: store.settings.dialect, apiBase: store.settings.apiBase });
  const identity = createProviderIdentity({
    provider: adapter.providerFamily || adapter.dialect,
    adapterId: adapter.adapterId || adapter.dialect,
    dialect: adapter.dialect,
    apiBase: store.settings.apiBase,
    model: store.settings.model,
  });
  return {
    provider: identity.provider,
    adapterId: identity.adapterId,
    dialect: identity.dialect,
    apiBase: store.settings.apiBase,
    model: store.settings.model,
    endpointIdentity: identity.endpointIdentity,
    protocolVersion: identity.protocolVersion,
  };
}

function sessionCompatible(meta, config) {
  try {
    const adapter = getProviderAdapter({ dialect: config.dialect, apiBase: config.apiBase });
    return !!(adapter && typeof adapter.isRawReplayCompatible === 'function'
      && adapter.isRawReplayCompatible(meta, config));
  } catch (e) { return false; }
}

async function ensureProviderSession(conv) {
  if (typeof PersistenceServiceInstance === 'undefined' || typeof getProviderAdapter !== 'function') return null;
  const service = PersistenceServiceInstance;
  const config = providerConfig();
  let previous = conv && conv.activeProviderSessionId ? await service.get('providerSessions', conv.activeProviderSessionId) : null;
  if (!previous) previous = conv ? await service.loadProviderSession(conv.id) : null;
  if (previous && conv.persistenceState !== 'degraded' && sessionCompatible(previous, config)) {
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
      await persistConversation(conv, { required: true });
    }
    return previous;
  }
  const row = {
    id: durableId('provider-session'), conversationId: conv.id,
    provider: config.provider, adapterId: config.adapterId, dialect: config.dialect,
    model: config.model, endpointIdentity: config.endpointIdentity,
    protocolVersion: config.protocolVersion,
    providerIdentity: createProviderIdentity(config),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    replayCheckpointSequence: 0, nextFrameSequence: 0, nextNormalizedSequence: 0,
    persistenceState: 'healthy', rawReplayInvalid: false, schemaVersion: 2,
  };
  row._projectedHistory = await service.loadNormalizedMessages(conv.id);
  row.nextNormalizedSequence = row._projectedHistory.reduce((n, message) => Math.max(n, message.sequence || 0), 0);
  try { validateNormalizedPrefix(conv.id, row._projectedHistory); }
  catch (e) {
    row._projectedHistory = [];
    row._replayBlocked = true;
    row.replayError = { code: e.code || 'normalized_invalid', message: e.message || String(e) };
  }
  const persistedRow = Object.assign({}, row);
  delete persistedRow._projectedHistory;
  await service.saveProviderSession(persistedRow);
  conv.activeProviderSessionId = row.id;
  await persistConversation(conv, { required: true });
  return row;
}

async function restoreSessionForConversation(conv) {
  if (!conv || typeof PersistenceServiceInstance === 'undefined') return null;
  const config = providerConfig();
  const adapter = getProviderAdapter({ dialect: config.dialect, apiBase: config.apiBase });
  const previous = conv.activeProviderSessionId
    ? await PersistenceServiceInstance.get('providerSessions', conv.activeProviderSessionId)
    : await PersistenceServiceInstance.loadProviderSession(conv.id);
  session.reset();
  session.replayBlocked = false;
  if (!previous) return null;
  if (sessionCompatible(previous, config) && conv.persistenceState !== 'degraded') {
    const allFrames = await PersistenceServiceInstance.loadProviderFrames(previous.id);
    const frames = allFrames.filter((frame) => frame.sequence <= previous.replayCheckpointSequence);
    try {
      validateReplayPrefix(previous, frames, adapter);
      // A durable suffix exists when a response/tool result was archived but
      // the checkpoint write failed.  It is intentionally not replay-safe:
      // reusing only the old checkpoint could execute an already-side-effecting
      // tool a second time after reload.
      if (allFrames.some((frame) => frame.sequence > previous.replayCheckpointSequence)) {
        throw Object.assign(new Error('durable transcript has an uncheckpointed suffix'), {
          name: 'ReplayValidationError', code: 'uncheckpointed_suffix', replayInvalid: true,
        });
      }
      session.history = frames.map((f) => f.raw).filter(Boolean);
    } catch (e) {
      previous.rawReplayInvalid = true;
      previous.persistenceState = 'invalid';
      previous.replayError = { code: e.code || 'replay_invalid', message: e.message || String(e) };
      conv.runState = 'interrupted';
      conv.status = 'interrupted';
      conv.persistenceState = 'degraded';
      conv.replayState = 'raw_invalid';
      await PersistenceServiceInstance.saveProviderSession(previous);
      await persistConversation(conv);
      try {
        const normalized = await PersistenceServiceInstance.loadNormalizedMessages(conv.id);
        validateNormalizedPrefix(conv.id, normalized);
        // The semantic projection is useful for inspection/recovery, but a
        // corrupt raw checkpoint is never silently turned into a new provider
        // request. Starting a fresh task creates a new safe boundary.
        session.replayBlocked = true;
        session.history = projectNormalizedHistory(normalized, config.dialect);
      } catch (normalizedError) {
        session.history = [];
        session.replayBlocked = true;
        conv.replayState = 'blocked';
        conv.replayError = { code: normalizedError.code || 'normalized_invalid', message: normalizedError.message || String(normalizedError) };
        await persistConversation(conv);
      }
    }
  } else {
    const normalized = await PersistenceServiceInstance.loadNormalizedMessages(conv.id);
    try {
      validateNormalizedPrefix(conv.id, normalized);
      session.history = projectNormalizedHistory(normalized, config.dialect);
    } catch (e) {
      session.history = [];
      session.replayBlocked = true;
      conv.runState = 'interrupted';
      conv.status = 'interrupted';
      conv.persistenceState = 'degraded';
      conv.replayState = 'blocked';
      conv.replayError = { code: e.code || 'normalized_invalid', message: e.message || String(e) };
      await persistConversation(conv);
    }
  }
  return previous;
}

function makePersistenceContext(conv, providerSession) {
  let frameSequence = providerSession.nextFrameSequence || 0;
  let normalizedSequence = providerSession.nextNormalizedSequence || 0;
  return {
    async onUserMessage(text, userContent) {
      // Rich user content (docs/IMAGE-INPUT.md): the raw provider frame
      // and the normalized row keep SEMANTIC image parts (attachmentId +
      // sha256 refs into the durable store) — never base64. Replay
      // materializes the bytes at request time through the gate.
      const parts = Array.isArray(userContent) && userContent.length ? userContent : null;
      const raw = { role: 'user', content: parts || text };
      await PersistenceServiceInstance.appendProviderFrame({
        sessionId: providerSession.id, conversationId: conv.id,
        sequence: ++frameSequence, turnId: providerSession.id,
        direction: 'outbound', role: 'user', kind: 'user', raw: raw,
      });
      await PersistenceServiceInstance.saveNormalizedMessage({
        conversationId: conv.id, sequence: ++normalizedSequence,
        role: 'user', kind: 'message', text: text,
        contentParts: parts || null,
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
    async onPersistenceError(error) {
      providerSession.persistenceState = 'degraded';
      providerSession.lastPersistenceError = { code: error.code || 'persistence_write_failed', message: error.message || String(error) };
      try { await PersistenceServiceInstance.saveProviderSession(providerSession); } catch (ignored) {}
      conv.persistenceState = 'degraded';
      conv.runState = 'interrupted';
      conv.status = 'interrupted';
      await persistConversation(conv);
    },
    async onPersistenceWarning(error) {
      reportPersistenceIssue(error, 'Optional persistence warning');
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
    if (event.type === 'task_end') {
      conv.runState = event.reason === 'persistence_error' || event.reason === 'interrupted' ? 'interrupted' : 'idle';
      if (event.reason === 'persistence_error') conv.persistenceState = 'degraded';
    }
    persistConversation(conv);
    if (typeof PersistenceServiceInstance !== 'undefined') {
      PersistenceServiceInstance.appendPresentationEvent(conv.id, conv.presentationSequence, event)
        .catch((e) => reportPersistenceIssue(e, 'Presentation event could not be saved'));
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

// Approval Framework v1 (src/approval.js): the controller is the CANONICAL
// owner of pending approval state; this store only mirrors it through
// onChange so the UI can render an ApprovalCard. A pending approval is a
// suspension of the SAME task — it never touches runState, provider
// history, or persistence. Session grants live in the controller's memory
// for this page session only (cleared by resetAllData / page reload).
//
// ?e2e=1 TEST SEAM (never set in production): window.__e2eObserverFailure
// makes these observer callbacks throw so browser e2e can prove a throwing
// observer cannot break approval settlement (docs/APPROVALS.md,
// "Observer failures"). The controller contains every throw; the flag is
// only ever set by e2e page scripts.
function e2eObserverFailureWanted(kind) {
  return typeof window !== 'undefined'
    && !!window.__e2eObserverFailure
    && window.__e2eObserverFailure[kind] === true;
}
export const approvals = new ApprovalController({
  onChange: (pending) => {
    if (e2eObserverFailureWanted('onChange')) throw new Error('e2e injected onChange failure');
    store.pendingApproval = pending;
  },
  onEvent: (name, data) => {
    if (e2eObserverFailureWanted('onEvent')) throw new Error('e2e injected onEvent failure');
    // Debug hook: the event stream is observability-only for the store.
  },
});

// Resolve the CURRENT pending approval from UI input. Stale ids (old card,
// late click) are no-ops inside the controller — they can never resolve a
// newer request. Returns true when a decision was applied.
export function resolveApproval(requestId, decision) {
  return approvals.resolve(requestId, decision);
}

// Escape-path resolution, kind-aware (docs/APPROVALS.md + docs/IMAGE-INPUT.md):
//   permission  → deny the current action only; the task keeps running.
//   capability  → CANCEL the decision, never answer it. Escape means "not
//                 now", not "No, this model is text-only" — nothing is
//                 written to the capability registry; the gate treats the
//                 image as unsent for this run and does not re-ask.
export function denyApproval() {
  const pending = store.pendingApproval;
  if (!pending) return false;
  if (pending.kind === 'capability') {
    return approvals.cancel(pending.id, 'escape');
  }
  return approvals.resolve(pending.id, { outcome: 'deny', scope: 'once' });
}

// Dismiss path for kinds without an allow decision in v1 (reserved).
export function cancelApproval(requestId) {
  const pending = store.pendingApproval;
  if (!pending || (requestId && pending.id !== requestId)) return false;
  return approvals.cancel(pending.id, 'dismissed');
}

// ---------- image feedback wiring (docs/IMAGE-INPUT.md) ----------
// AttachmentStore + ModelCapabilityRegistry are lazy: Node test harnesses
// and minimal deployments load store.js without the image modules and
// simply get a text-only runtime. In the app both modules are loaded by
// index.html before this file executes.
let attachmentStoreInstance = null;
let capabilityRegistryInstance = null;

function ensureImageStores() {
  if (typeof AttachmentStore === 'undefined' || typeof ModelCapabilityRegistry === 'undefined') return null;
  if (typeof PersistenceServiceInstance === 'undefined') return null;
  if (!attachmentStoreInstance) {
    attachmentStoreInstance = new AttachmentStore({ persistence: PersistenceServiceInstance });
  }
  if (!capabilityRegistryInstance) {
    capabilityRegistryInstance = new ModelCapabilityRegistry({ persistence: PersistenceServiceInstance });
  }
  return { store: attachmentStoreInstance, registry: capabilityRegistryInstance };
}

export function getAttachmentStore() { return ensureImageStores() ? attachmentStoreInstance : null; }
export function getCapabilityRegistry() { return ensureImageStores() ? capabilityRegistryInstance : null; }

function imageInputIdentity() {
  if (typeof getProviderAdapter !== 'function' || typeof createProviderIdentity !== 'function') return null;
  try {
    return createProviderIdentity(providerConfig());
  } catch (e) {
    return null;
  }
}

// The ImageInputGate (docs/IMAGE-INPUT.md): consults the registry, asks
// via the Approval Framework (kind 'capability') when unknown, and runs
// the synthetic visual probe on "I don't know" — through the production
// callModel path. Per-run askCache is supplied by AgentSession.run.
async function ensureImageCapability(opts) {
  const s = ensureImageStores();
  const gate = createImageInputGate({
    registry: s.registry,
    approvals: approvals,
    runProbe: (probeOpts) => runImageInputProbe({ signal: probeOpts.signal }),
    identityOf: imageInputIdentity,
  });
  return gate.ensure({
    signal: opts.signal,
    taskGeneration: opts.taskGeneration,
    askCache: opts.askCache,
    conversationId: runningConversationId !== null ? runningConversationId : store.liveConversationId,
  });
}

if (typeof createImageInputGate === 'function' && typeof runImageInputProbe === 'function') {
  session.imageInput = {
    ensureCapability: ensureImageCapability,
    resolveAttachment: (attachmentId) => {
      const s = ensureImageStores();
      return s ? s.store.resolveForWire(attachmentId) : Promise.resolve(null);
    },
    unavailableNotice: (result) => imageInputUnavailableNotice(result),
  };
}

// Exact base64 expansion estimate (identical formula to agent.js) for the
// submit-time transport-budget pre-check.
function imageWireEstimate(size) {
  return Math.ceil(Number(size || 0) / 3) * 4 + 256;
}

// "Recheck image capability" (docs/IMAGE-INPUT.md): the user-facing path
// to correct a mistaken Yes/No — clears the persisted override for the
// CURRENT provider identity only. The next image turn falls back to the
// builtin seed or the interactive ask.
export async function recheckImageCapability() {
  const s = ensureImageStores();
  const identity = imageInputIdentity();
  if (!s || !identity) return false;
  const status = await s.registry.forget(identity);
  store.imageCapability = status;
  return true;
}

export async function refreshImageCapability() {
  const s = ensureImageStores();
  const identity = imageInputIdentity();
  if (!s || !identity) {
    store.imageCapability = null;
    return null;
  }
  const status = await s.registry.lookup(identity);
  store.imageCapability = status;
  // Plain snapshot (not the reactive proxy): safe to serialize for
  // callers outside Vue.
  return { state: status.state, source: status.source, checkedAt: status.checkedAt || null, lastProbeAt: status.lastProbeAt || null, lastProbeFailure: status.lastProbeFailure || null, recorded: status.recorded };
}

// The VFS (declared at module scope above) replaces the raw adapter in
// the workspace slot: buildSystemPrompt and the tool executor both
// receive it (buildSystemPrompt reads workspace.workspaceName; tools
// route every path through the mounts).

// ---------- settings ----------

let appliedCredentialIdentity = null;
let appliedApiKey = '';

export function applySettings() {
  const nextApiBase = store.settings.apiBase.trim() || DEFAULTS.apiBase;
  const nextDialect = store.settings.dialect || 'auto';
  let nextIdentity = null;
  try {
    const adapter = getProviderAdapter({ dialect: nextDialect, apiBase: nextApiBase });
    nextIdentity = createCredentialIdentity({
      provider: adapter.providerFamily || adapter.dialect,
      adapterId: adapter.adapterId || adapter.dialect,
      dialect: adapter.dialect,
      apiBase: nextApiBase,
    });
  } catch (e) {
    store.settings.apiKey = '';
    Model.apiKey = '';
    store.storageNotice = 'Invalid custom endpoint; no remembered credential was loaded.';
  }
  // The key currently in memory belongs to the previously applied
  // destination. Clear it automatically when only the destination changed;
  // a newly typed key is preserved so the user can save endpoint B directly.
  if (appliedCredentialIdentity && nextIdentity
      && JSON.stringify(appliedCredentialIdentity) !== JSON.stringify(nextIdentity)
      && store.settings.apiKey.trim() === appliedApiKey) {
    store.settings.apiKey = '';
  }
  Model.apiKey = store.settings.apiKey.trim();
  Model.apiBase = nextApiBase;
  Model.model = store.settings.model.trim() || DEFAULTS.model;
  Model.proxy = store.settings.proxy.trim();
  Model.dialect = nextDialect;
  appliedCredentialIdentity = nextIdentity;
  appliedApiKey = Model.apiKey;
  return !!nextIdentity;
}

export async function persistSettingsIfNeeded() {
  if (typeof PersistenceServiceInstance === 'undefined') return;
  applySettings();
  const config = providerConfig();
  if (store.settings.remember && !store.settings.apiKey) {
    const saved = await PersistenceServiceInstance.loadRememberedApiKey(config);
    if (saved) {
      store.settings.apiKey = saved;
      Model.apiKey = saved;
      appliedApiKey = saved;
    }
  }
  await PersistenceServiceInstance.saveSettings(store.settings);
  await PersistenceServiceInstance.setRememberedApiKey(store.settings.apiKey, !!store.settings.remember, config);
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
  // Session boundary: a pending approval dies with the old task (running
  // approvals normally die via the task's own AbortSignal; this also
  // closes test-only standalone requests). Session GRANTS survive — they
  // belong to the page session, not to a conversation.
  approvals.cancelAll('session_boundary');
  clearAttachments();
  startConversation();
}

export function openConversation(id) {
  store.activeConversationId = id;
}

// ---------- task submission ----------

// Build the durable snapshot + semantic parts for image attachments on
// the submit path (docs/IMAGE-INPUT.md): each image File at /mnt/upload
// is snapshotted into the AttachmentStore BEFORE the user frame is
// persisted, so persisted history references durable bytes, never the
// ephemeral File. Files stay in /mnt/upload regardless — a rejected or
// unsent image never deletes the user's upload.
async function buildImageUserContent(input) {
  const images = store.attachments.filter((a) => a && String(a.type || '').toLowerCase().startsWith('image/'));
  if (!images.length) return { parts: null, blocked: false };
  const s = ensureImageStores();
  const warn = (message) => {
    const conv = store.conversations.find((c) => c.id === store.liveConversationId);
    if (conv) {
      LocusProjector.projectEvent(conv, { type: 'warning', code: 'image_attachment_rejected', message });
    }
  };
  if (!s) {
    warn('Images cannot be attached in this runtime (attachment store unavailable); the text was sent without them.');
    return { parts: null, blocked: false };
  }
  const parts = [textContentPart(input)];
  for (const a of images) {
    try {
      const bytes = await vfs.readBytes(a.path);
      const record = await s.store.ingestImage({ bytes, name: a.name, declaredType: a.type });
      parts.push(imageContentPart(record));
    } catch (e) {
      warn('Image "' + a.name + '" was not attached: ' + (e && e.message ? e.message : String(e)));
    }
  }
  if (parts.length === 1) return { parts: null, blocked: false };
  // Submit-time transport-budget pre-check: resolved base64 must fit the
  // same budget enforceHistoryBudget enforces (exact arithmetic, not a
  // guess). Over budget → explicit error, no task, no silent dropping.
  const budget = (typeof HISTORY_BUDGET_BYTES === 'number') ? HISTORY_BUDGET_BYTES : 768 * 1024;
  let imageBytes = 0;
  for (const p of parts) if (p.type === 'image') imageBytes += imageWireEstimate(p.size);
  const projected = session.historyRequestBytes(vfs) + imageBytes + new TextEncoder().encode(JSON.stringify({ role: 'user', content: parts })).byteLength + 16;
  if (projected > budget) {
    const conv = store.conversations.find((c) => c.id === store.liveConversationId);
    if (conv) {
      LocusProjector.projectEvent(conv, {
        type: 'error', code: 'history_budget',
        message: 'This task exceeds the request transport budget (' + budget + ' bytes) with the attached image(s) included. Remove an image or start a new task.',
      });
    }
    return { parts: null, blocked: true };
  }
  // Durability honesty (docs/IMAGE-INPUT.md, "Memory-only durability"):
  // when OPFS is unavailable the snapshot lives only in the page-lifetime
  // memoryAttachmentBytes Map even though the metadata may persist in
  // IndexedDB. The current task may still send the image, but the user
  // must KNOW it will not survive a reload — no silent durability lie.
  // This reuses the PersistenceService's own OPFS state (no per-submit
  // probe); the warning is a presentation event only and never enters
  // provider-visible history (frames / normalized messages / replay).
  if (typeof PersistenceServiceInstance !== 'undefined'
      && PersistenceServiceInstance && PersistenceServiceInstance.opfsAvailable === false) {
    warn('Image attachment storage is memory-only in this browser session; the attached image will not survive a page reload.');
  }
  return { parts, blocked: false };
}

export async function submit(text) {
  const input = String(text || '').trim();
  if (!input) return;
  // While an approval is pending the composer must not start a new task —
  // approve, deny, or cancel the task are the three available actions.
  if (store.pendingApproval) return;
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
      try {
        await restoreSessionForConversation(selected);
      } catch (e) {
        selected.persistenceState = 'degraded';
        selected.runState = 'interrupted';
        selected.status = 'interrupted';
        reportPersistenceIssue(e, 'Conversation replay could not be restored');
        return;
      }
      if (session.replayBlocked) {
        store.storageNotice = 'This conversation has an invalid durable checkpoint and was not sent to the provider. Start a new task to continue safely.';
        return;
      }
    }
  }
  const selectedConversation = store.conversations.find((c) => c.id === store.liveConversationId);
  if (selectedConversation && (selectedConversation.replayState === 'raw_invalid'
      || selectedConversation.persistenceState === 'degraded')) {
    store.storageNotice = selectedConversation.replayState === 'raw_invalid'
      ? 'This conversation has an invalid durable checkpoint and was not sent to the provider. Start a new task to continue safely.'
      : 'This conversation has degraded persistence and was not retried. Start a new task to continue safely.';
    return;
  }
  // Submitting always targets the live session. If the user is viewing an
  // archived conversation, snap back to the live one first — presentation
  // history is never replayed into provider history.
  store.activeConversationId = store.liveConversationId;
  // Image attachments (docs/IMAGE-INPUT.md): durable snapshot + semantic
  // parts BEFORE any task state moves. Budget overflow blocks the submit
  // with an explicit error; individual rejected images degrade to a
  // warning and the text still goes out.
  const imageBuild = await buildImageUserContent(input);
  if (imageBuild.blocked) return;
  const userContent = imageBuild.parts;
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
  let submitGeneration = session.generation;
  const projectPreRunIntent = () => {
    if (boundConversation && !boundConversation.items.length && boundConversation.status === 'idle') {
      handleRuntimeEvent({ type: 'task_start', input: input });
    }
  };
  const finishPreRunSessionSwitch = () => {
    if (pendingCancel) {
      // Persistence can still be committing the first user frame when a
      // cancel arrives. Preserve that intent only on this terminal path;
      // normal task_start ownership belongs to AgentSession.run().
      projectPreRunIntent();
      handleRuntimeEvent({
        type: 'warning',
        code: 'task_cancelled',
        message: '任务已取消，尚未开始模型请求。',
      });
      handleRuntimeEvent({ type: 'task_end', reason: 'cancelled' });
      return true;
    }
    if (session.generation === submitGeneration) return false;
    // A session boundary can arrive before AgentSession.run(). Preserve the
    // submitted intent once before recording that terminal outcome.
    projectPreRunIntent();
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
        // This reset is the intentional provider-session rebind above, not a
        // user workspace switch. Continue guarding against later external
        // switches from the new generation.
        submitGeneration = session.generation;
        session.history = projectNormalizedHistory(providerSession._projectedHistory, providerConfig().dialect);
        delete providerSession._projectedHistory;
      }
      if (providerSession && providerSession._replayBlocked) session.replayBlocked = true;
      if (session.replayBlocked) {
        handleRuntimeEvent({ type: 'error', code: 'raw_replay_invalid', message: 'Durable conversation history is invalid; no provider request was sent. Start a new task to continue safely.' });
        handleRuntimeEvent({ type: 'task_end', reason: 'interrupted' });
        return;
      }
      boundConversation.runState = 'running';
      boundConversation.updatedAt = new Date().toISOString();
      await persistConversation(boundConversation, { required: true });
      // Durable ordering: user presentation/semantic/provider state is
      // committed before AgentSession can make the first model request.
      // Rich content (image attachment refs) rides in the same frame —
      // base64 never enters persistence (docs/IMAGE-INPUT.md).
      await persistenceContext.onUserMessage(input, userContent);
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
    // One user turn: text + selected image attachments bind into a single
    // provider turn (never a separate image turn, never a duplicate
    // bubble). run() emits ONE task_start for it.
    await session.run(input, { workspace: vfs.fork(), userContent });
  } catch (e) {
    // run() threw without a normal task lifecycle (e.g. the concurrent-run
    // guard): no task_end will arrive, so release the binding here instead
    // of leaving a stale route for some future task's events.
    if (runningConversationId === boundId) runningConversationId = null;
    const conv = store.conversations.find((c) => c.id === boundId);
    if (conv) {
      if (!conv.items.length && conv.status === 'idle') {
        LocusProjector.projectEvent(conv, { type: 'task_start', input: input });
      }
      LocusProjector.projectEvent(conv, {
        type: 'error',
        code: isPersistenceFailure(e) ? 'persistence_write_failed' : 'task_rejected',
        message: e && e.message ? e.message : String(e),
      });
      LocusProjector.projectEvent(conv, {
        type: 'task_end', reason: isPersistenceFailure(e) ? 'persistence_error' : 'error',
      });
      if (isPersistenceFailure(e)) {
        conv.persistenceState = 'degraded';
        reportPersistenceIssue(e, 'Task persistence failed');
      }
      persistConversation(conv);
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

function storageMutationBlockedError() {
  const e = new Error('Storage action could not proceed because the running task did not stop.');
  e.name = 'StorageMutationBlockedError';
  e.code = 'active_task_did_not_stop';
  return e;
}

// One runtime gate for every destructive/mount mutation.  UI disabled states
// are only a convenience; this gate is the authority that cancels and waits
// for AgentSession.finally to release the task before backing providers move.
export async function quiesceRuntimeForStorageMutation() {
  if (!store.busy && !session.task) return;
  store.cancelling = true;
  if (session.task) session.cancel();
  else pendingCancel = true; // submit may still be before session.run()
  const stopped = await waitFor(() => !store.busy && !session.task, STORAGE_MUTATION_TIMEOUT_MS);
  if (!stopped) {
    const error = storageMutationBlockedError();
    store.storageNotice = error.message;
    throw error;
  }
}

async function withStorageMutation(action) {
  let release;
  const previous = storageMutationTail;
  storageMutationTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    await quiesceRuntimeForStorageMutation();
    return await action();
  } finally {
    release();
  }
}

async function mountExternalHandle(handle, persistHandle) {
  const provider = new LocalDirectoryWorkspace(handle);
  vfs.mount('/mnt/workspace', provider, 'external-read-write');
  store.workspaceName = provider.name;
  store.workspacePermission = 'granted';
  store.workspaceHandleAvailable = true;
  if (persistHandle && typeof PersistenceServiceInstance !== 'undefined') {
    try {
      await PersistenceServiceInstance.saveWorkspaceHandle(handle);
    } catch (e) {
      // The folder is mounted for this session, but restart persistence did
      // not complete. Keep the live authority and make that distinction
      // explicit instead of claiming the handle was remembered.
      store.workspaceHandleAvailable = false;
      reportPersistenceIssue(e, 'Workspace mounted, but could not be remembered');
    }
  }
  return provider;
}

async function mountDurableStorage() {
  if (typeof PersistenceServiceInstance === 'undefined') return;
  try {
    await PersistenceServiceInstance.ensureHomeSkeleton();
    const homeDir = await PersistenceServiceInstance.opfsDirectory(['home', 'locus'], true);
    vfs.mount('/home/locus', new OPFSWorkspace(homeDir, { name: 'home' }), 'read-write');
  } catch (e) {
    reportPersistenceIssue(e, 'Durable home storage unavailable; using memory-only home for this session');
  }
  try {
    const pluginDir = await PersistenceServiceInstance.opfsDirectory(['mnt', 'plugins'], true);
    vfs.mount('/mnt/plugins', new OPFSWorkspace(pluginDir, { name: 'plugins' }), 'system-read-only');
  } catch (e) { reportPersistenceIssue(e, 'Durable plugin storage unavailable; using an empty plugin mount'); }
  try {
    vfs.mount('/home/locus/history', new ConversationHistoryWorkspace(PersistenceServiceInstance), 'system-read-only');
  } catch (e) { reportPersistenceIssue(e, 'Conversation history mount unavailable'); }
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
    await withStorageMutation(async () => {
      await mountExternalHandle(handle, false);
      store.storageNotice = null;
    });
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

  let granted;
  try {
    granted = await ensureWorkspacePermission(handle);
  } catch (e) {
    const conv = store.conversations.find((c) => c.id === store.liveConversationId);
    if (conv) LocusProjector.projectEvent(conv, {
      type: 'warning', code: 'workspace_permission',
      message: 'Workspace permission check failed: ' + (e && e.message ? e.message : String(e)),
    });
    return;
  }
  if (!granted) return;

  // FINAL serialized gate, AFTER the picker + permission awaits: a task may
  // have been submitted while those prompts were open. Never mount beneath it.
  try {
    await withStorageMutation(async () => {
      // Re-mounting a different folder replaces the provider at
      // /mnt/workspace. In-flight tasks hold a fork() of the VFS and keep
      // routing to the OLD provider until their finally block settles.
      approvals.cancelAll('session_boundary');
      await mountExternalHandle(handle, true);
      // Full session boundary after the new authority is live.
      session.reset();
      clearAttachments();
      startConversation();
    });
  } catch (e) {
    const conv = store.conversations.find((c) => c.id === store.liveConversationId);
    if (conv) LocusProjector.projectEvent(conv, { type: 'warning', code: 'workspace_persistence', message: e.message });
  }
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
      const type = String(f.type || '').toLowerCase();
      store.attachments.push({
        name: finalName,
        path: UPLOAD_ROOT + '/' + finalName,
        size: f.size || 0,
        type: f.type || 'file',
        // Lightweight visual metadata only — capability is NEVER decided
        // here. Whether an image crosses the model boundary is judged at
        // that boundary (docs/IMAGE-INPUT.md).
        image: type.startsWith('image/'),
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
    reportPersistenceIssue(e, 'Artifacts could not be refreshed');
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
  return withStorageMutation(async () => {
    if (typeof PersistenceServiceInstance !== 'undefined') await PersistenceServiceInstance.clearConversations();
    store.conversations = [];
    session.reset();
    startConversation();
  });
}

export async function clearHome() {
  return withStorageMutation(async () => {
    if (typeof PersistenceServiceInstance !== 'undefined') await PersistenceServiceInstance.clearHome();
    // PersistenceService owns the durable backend; VFS owns the provider
    // currently mounted at /home/locus. Once the durable clear resolves (or
    // reports memory-only mode), replace the live fallback with a fresh
    // canonical home before attempting a durable remount.
    if (typeof vfs.resetHome === 'function') vfs.resetHome();
    await mountDurableStorage();
    await refreshArtifacts();
  });
}

export async function clearPlugins() {
  return withStorageMutation(async () => {
    if (typeof PersistenceServiceInstance !== 'undefined') await PersistenceServiceInstance.clearPlugins();
    await mountDurableStorage();
  });
}

export async function forgetApiKeys() {
  return withStorageMutation(async () => {
    if (typeof PersistenceServiceInstance !== 'undefined') await PersistenceServiceInstance.forgetApiKeys();
    store.settings.apiKey = '';
    store.settings.remember = false;
    Model.apiKey = '';
    appliedApiKey = '';
  });
}

export async function resetAllData() {
  return withStorageMutation(async () => {
    // Abort/wait already happened in the gate.  Remove the live external
    // authority before clearing durable state; reset must not leave an old
    // forkable /mnt/workspace provider in the VFS.
    const workspaceMount = vfs.resolveMount('/mnt/workspace');
    session.reset();
    // resetAllData is the one in-page action that ends the PAGE session:
    // pending approvals close and every session grant is forgotten.
    approvals.cancelAll('reset');
    approvals.clearSessionGrants();
    if (workspaceMount) vfs.unmount('/mnt/workspace');
    store.workspaceName = null;
    store.workspacePermission = 'none';
    store.workspaceHandleAvailable = false;
    if (typeof PersistenceServiceInstance !== 'undefined') await PersistenceServiceInstance.reset();
    if (typeof vfs.resetHome === 'function') vfs.resetHome();
    if (typeof vfs.resetEphemeral === 'function') vfs.resetEphemeral();
    store.attachments = [];
    store.artifacts = [];
    store.settings = Object.assign({}, DEFAULTS);
    appliedCredentialIdentity = null;
    appliedApiKey = '';
    applySettings();
    store.conversations = [];
    store.activeConversationId = null;
    store.liveConversationId = null;
    await mountDurableStorage();
    startConversation();
    await refreshStorageStatus();
  });
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
    applySettings();
    // Settings identify the destination first.  Only then may a remembered
    // credential for that exact provider/adapter/dialect/path be hydrated.
    store.settings.apiKey = '';
    store.settings.remember = false;
    try {
      const saved = await PersistenceServiceInstance.loadRememberedApiKey(providerConfig());
      if (saved) {
        store.settings.apiKey = saved;
        store.settings.remember = true;
      }
    } catch (e) {
      reportPersistenceIssue(e, 'Remembered credential could not be loaded');
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
