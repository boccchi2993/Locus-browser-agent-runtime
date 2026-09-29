// ============================================================
//  PRESENTATION STORE (Vue) — Product composition layer
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
//  M1a (repository split): the TASK lifecycle (admission, task
//  controller, prepare→run→settle ordering, pre-run cancellation,
//  storage-mutation quiesce) moved to the Harness module
//  src/harness/task-runner.js; protocol-replay session preparation and
//  the durable persistence context moved to
//  src/harness/provider-session.js. This store now provides the
//  PRODUCT side: conversation identity, UI projection, persistence
//  storage access, VFS/Python preparation, model configuration and
//  test/demo hooks — wired through the two harness modules' ports.
//  Classic-script globals this file still reads are concentrated in
//  the adapter blocks below (marked M1b/M2 elimination points in
//  docs/REPOSITORY-SPLIT-INVENTORY.md).
//
//  Runtime globals (AgentSession, Model, callModel, executeTool,
//  LocalDirectoryWorkspace, ensureWorkspacePermission, createPythonRuntime,
//  Telemetry, LocusProjector, VirtualWorkspace, SHELL_COMMANDS) come from
//  the classic scripts loaded by index.html before this module — same as
//  the old ui.js wiring. M1b (repository split): the python interpreter is
//  an INSTANCE created and owned here (no page-global PythonRuntime); task
//  preparation, session reset and shell execution all use that one
//  instance.
// ============================================================

import { reactive, computed } from 'vue';
import { createTaskRunner, isPersistenceFailure } from '../harness/task-runner.js';
import { createProviderSessions } from '../harness/provider-session.js';

/* global AgentSession, Model, callModel, executeTool, buildSystemPrompt,
   LocalDirectoryWorkspace, ensureWorkspacePermission, createPythonRuntime, LocusMutationPolicy,
   Telemetry, LocusProjector, VirtualWorkspace, SHELL_COMMANDS,
   CapabilityManager, CAPABILITY_CATALOG, PLUGIN_CATALOG, SKILL_CATALOG, MCP_CATALOG,
   SkillSourceStore, SkillInstanceStorage, SkillInstanceWorkspace,
   PersistenceServiceInstance, OPFSWorkspace, ConversationHistoryWorkspace,
   getProviderAdapter, projectNormalizedHistory */

// ONE persistent VFS for the whole page lifetime. All static mounts
// (home/tmp/upload/download/bin/usrbin) are wired inside the constructor;
// /mnt/workspace is added/replaced by mountFolder(). The command list is
// injected lazily so this module never depends on script load order.
const vfs = new VirtualWorkspace({ listCommands: () => Object.keys(SHELL_COMMANDS) });
export { vfs };

// Capability Composition v1: page-session CapabilityManager over the
// (empty) PRODUCTION catalogs, an EMPTY default source store and the
// durable skill-instance storage backed by the CURRENT /home/locus mount
// (memory before boot, OPFS after — resolved dynamically, never captured).
// No capability persistence — a reload resets enabled-state; the
// materialized instances stay durable and a re-enable reuses them.
// Tests/e2e inject synthetic catalogs through injectCapabilityCatalogs();
// production code never does.
const capabilityManager = typeof CapabilityManager === 'function'
  ? new CapabilityManager({
      catalogs: {
        capabilities: CAPABILITY_CATALOG,
        plugins: PLUGIN_CATALOG,
        skills: SKILL_CATALOG,
        mcps: MCP_CATALOG,
      },
      sources: typeof SkillSourceStore === 'function' ? new SkillSourceStore() : undefined,
      instances: typeof SkillInstanceStorage === 'function'
        ? new SkillInstanceStorage({
            resolveHome: () => {
              const r = vfs.resolveMount('/home/locus');
              return r ? r.provider : null;
            },
          })
        : undefined,
    })
  : null;
export { capabilityManager };

function syncCapabilityProjection() {
  store.capabilities = capabilityManager ? capabilityManager.listCapabilities() : [];
}

export function capabilityList() {
  syncCapabilityProjection();
  return store.capabilities;
}

// TEST/E2E-ONLY synthetic catalog injection (production catalogs stay
// empty). Validates loudly before swapping; enabled-state resets with
// the new set. Optional second argument swaps the synthetic SOURCE store:
// { [skillId]: { version, source } }. Rejected while a task is running.
export function injectCapabilityCatalogs(catalogs, sources) {
  if (!capabilityManager) throw new Error('capability runtime unavailable');
  if (store.busy || session.task) throw new Error('cannot change capabilities while a task is running');
  capabilityManager.replaceCatalogs(catalogs, sources);
  syncCapabilityProjection();
  return store.capabilities;
}

// Capability mutations are between-task actions: while a task runs the
// UI disables them AND these guards reject programmatic calls. A task
// already holds its own frozen TaskEnvironment either way — the guard
// exists to keep manager state and user expectation aligned. Both enable
// and disable now touch the DURABLE home (instance materialization /
// capability-directory removal), so both run inside the storage-mutation
// gate: a running task can never race OPFS skill files, and a failed
// destructive removal surfaces as an error instead of a fake "Removed".
function assertCapabilitiesIdle() {
  if (store.busy || session.task) {
    throw new Error('a task is running; capability changes apply between tasks');
  }
}

export async function enableCapability(id) {
  if (!capabilityManager) throw new Error('capability runtime unavailable');
  assertCapabilitiesIdle();
  return withStorageMutation(async () => {
    const state = await capabilityManager.enable(id);
    syncCapabilityProjection();
    return state;
  });
}

export async function disableCapability(id) {
  if (!capabilityManager) throw new Error('capability runtime unavailable');
  assertCapabilitiesIdle();
  await withStorageMutation(async () => {
    await capabilityManager.disable(id);
    syncCapabilityProjection();
  });
}

// The ONLY write path for external-connection state (the future MCP
// connector uses it too). Enabling a capability NEVER flips this:
// unconnected requirements stay needs-connection until an explicit
// connection decision.
export function setMcpConnectionState(id, state) {
  if (!capabilityManager) throw new Error('capability runtime unavailable');
  assertCapabilitiesIdle();
  const next = capabilityManager.setMcpState(id, state);
  syncCapabilityProjection();
  return next;
}

// ---------- python interpreter lifecycle (M1b, repository split) ----------
// The Product OWNS the ONE canonical interpreter instance for the page
// (contract REPOSITORY-SPLIT-CONTRACTS 3.1 / 3.4-Q3). It is created here —
// lazily on first use, so deployments and Node tests without the shell
// runtime simply get none — and the SAME instance is (a) configured by task
// preparation (prepare), (b) reset at session boundaries, and (c) injected
// into every shell execution (opts.pythonRuntime), so preparation and
// execution can never split onto two interpreters. There is deliberately
// NO page-global fallback: a shell python command without an injected
// instance fails loudly (runPythonCode), it never resurrects a global.
// Tests may substitute the instance via window.__LOCUS_HOOKS__.pythonRuntime
// before first use; production resolves the createPythonRuntime factory
// from shell.js.
let pythonRuntimeResolved; // undefined = unresolved; null = resolved: none available
function ensurePythonRuntime() {
  if (pythonRuntimeResolved !== undefined) return pythonRuntimeResolved;
  const h = hooks();
  if (h && h.pythonRuntime) {
    pythonRuntimeResolved = h.pythonRuntime;
  } else if (typeof createPythonRuntime === 'function') {
    pythonRuntimeResolved = createPythonRuntime();
  } else {
    pythonRuntimeResolved = null;
  }
  return pythonRuntimeResolved;
}

// Canonical accessor for callers outside this module (the UI status poll
// and the ?e2e=1 seam). Returns null when this deployment has no python
// runtime.

// ---------- product mutation policy (M1b, repository split) ----------
// The Locus skill-identity protection is PRODUCT policy, not runtime:
// LocusMutationPolicy (src/mutation-policy.js) owns the /home/locus/.skills
// rules; the generic runtime shell only consumes the operation-aware port
// (checkMove / checkRemove / isPolicyRefusal) via opts.mutationPolicy.
// EVERY bash execution carries it — a missing policy implementation fails
// LOUDLY here instead of silently running shell mutations unprotected.
let mutationPolicyResolved = null;
function taskMutationPolicy() {
  if (mutationPolicyResolved) return mutationPolicyResolved;
  if (typeof LocusMutationPolicy === 'undefined' || typeof LocusMutationPolicy.create !== 'function') {
    throw new Error('Locus mutation policy unavailable; refusing to run shell commands without the skill-protection policy');
  }
  mutationPolicyResolved = LocusMutationPolicy.create();
  return mutationPolicyResolved;
}
export function pythonRuntime() {
  const rt = ensurePythonRuntime();
  return rt || null;
}

// Configure the interpreter with the plugin payload set THIS task's
// TaskEnvironment needs (instance.prepare): a changed extension key means
// the configured interpreter holds a different plugin set, so prepare
// validates the NEW payload first, then rebuilds the payload set — the
// next boot installs it before READY (never a lazy install-on-import).
// Same-key preparation is a no-op and nothing here boots the interpreter
// or downloads assets: a text-only task performs zero Python work.
// With no python plugins (null key) this returns the runtime to core-only.
// A validation failure is all-or-nothing inside prepare: the previously
// configured payload survives intact.
async function preparePythonRuntimeForEnvironment(env, signal) {
  const rt = ensurePythonRuntime();
  if (!rt) return;
  const wanted = env ? env.pythonExtensionKey : null;
  // A null key means the core-only runtime: the payload is cleared
  // explicitly (buildExtensions validates strict shapes and rejects
  // key: null payloads).
  const payload = wanted === null || !capabilityManager
    ? null
    : capabilityManager.pythonExtensionPayload(env);
  // The TASK's signal rides along: the runtime refuses to configure for a
  // task whose signal already aborted (cancellation-shaped, so the
  // runner's existing classification reads it as a cancellation).
  await rt.prepare({ python: payload, signal: signal });
}

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

  // Capability Composition v1: reactive projection of the (non-reactive)
  // CapabilityManager. Mutator actions re-sync it; the manager itself
  // stays a plain page-session object (frozen TaskEnvironments must
  // never become Vue reactive proxies).
  capabilities: [],
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
  // NetworkRuntime approval consumer context (docs/NETWORK-RUNTIME.md):
  // side-effecting network requests ask through the page's ApprovalController.
  // The approval provider is injected here — the shell neither constructs
  // approvals nor knows their internals. Read-only in the hooks path.
  const o = Object.assign({}, opts || {}, {
    approvals: approvals,
    conversationId: runningConversationId || store.liveConversationId || null,
    taskGeneration: session.generation,
    // M1b: the canonical interpreter instance — shell python executes on
    // exactly the instance task preparation configured (see the lifecycle
    // block above).
    pythonRuntime: pythonRuntime(),
    // M1b: the product mutation policy — mv/rm refusals (skill identity
    // among them) come from IT, never from hardcoded runtime rules.
    mutationPolicy: taskMutationPolicy(),
  });
  const h = hooks();
  if (h && typeof h.toolExecutor === 'function') return h.toolExecutor(tool, input, workspace, o);
  return executeTool(tool, input, workspace, o);
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
// Task↔conversation binding owner (id of the runner task that currently
// owns runningConversationId). Released by onTaskEnd, guarded by id so a
// late finish of an older task can never release a newer task's binding.
let boundTaskId = null;
// Task-id → conversation-id for EVENT ROUTING (lifecycle fix): a task's
// events carry the task id captured AT EXECUTION START; this map resolves
// them back to the conversation they belong to, even when the event
// arrives after another task was admitted. Entries are deleted in
// onTaskEnd — which runs AFTER the runner published the final task_end,
// so the terminal projection itself still resolves — and after that a
// late tail of a released task is dropped, never projected.
const taskEventTargets = new Map();

let persistenceContext = null;
let persistenceBootPromise = null;
let persistenceBootComplete = false;
const STORAGE_MUTATION_TIMEOUT_MS = 10000;

function reportPersistenceIssue(error, message) {
  const detail = error && error.message ? error.message : String(error || 'unknown persistence error');
  store.storageNotice = (message || 'Durable storage failed') + ': ' + detail;
  if (typeof PersistenceServiceInstance !== 'undefined'
      && typeof PersistenceServiceInstance.notePersistenceError === 'function') {
    PersistenceServiceInstance.notePersistenceError(error, message || 'persistence');
  }
}

// isPersistenceFailure moved to src/harness/task-runner.js (M1a lifecycle
// fix): ONE classification table shared by the Product and the runner.

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

// ---------- harness provider sessions (M1a) ----------
// The replay/session-preparation logic lives in
// src/harness/provider-session.js. This adapter is the Product's ONLY
// place that maps classic-script persistence/adapter globals onto that
// module's ports (M1b/M2 elimination point: inject the service instance
// instead of reading the global here). Built LAZILY on first use — the
// globals may be installed by the host page (or a test) after this
// module loads, exactly like the old call-time typeof checks.
let providerSessionsInstance = null;
function providerSessionsAdapter() {
  if (providerSessionsInstance) return providerSessionsInstance;
  if (typeof PersistenceServiceInstance === 'undefined' || typeof getProviderAdapter !== 'function') return null;
  providerSessionsInstance = createProviderSessions({
    persistence: {
      get: (name, key) => PersistenceServiceInstance.get(name, key),
      loadProviderSession: (conversationId) => PersistenceServiceInstance.loadProviderSession(conversationId),
      loadProviderFrames: (sessionId) => PersistenceServiceInstance.loadProviderFrames(sessionId),
      loadNormalizedMessages: (conversationId) => PersistenceServiceInstance.loadNormalizedMessages(conversationId),
      saveProviderSession: (row) => PersistenceServiceInstance.saveProviderSession(row),
      appendProviderFrame: (frame) => PersistenceServiceInstance.appendProviderFrame(frame),
      saveNormalizedMessage: (row) => PersistenceServiceInstance.saveNormalizedMessage(row),
    },
    persistConversation: (conv, opts) => persistConversation(conv, opts),
    reportIssue: (error, message) => reportPersistenceIssue(error, message),
    getAdapter: (config) => getProviderAdapter(config),
    providerConfig: providerConfig,
    createProviderIdentity: createProviderIdentity,
    projectHistory: (messages, dialect) => projectNormalizedHistory(messages, dialect),
    validateReplayPrefix: (meta, frames, adapter) => validateReplayPrefix(meta, frames, adapter),
    validateNormalizedPrefix: (conversationId, rows) => validateNormalizedPrefix(conversationId, rows),
    durableId: durableId,
    now: () => new Date().toISOString(),
  });
  return providerSessionsInstance;
}

// restoreSessionForConversation / makePersistenceContext moved to
// src/harness/provider-session.js (M1a); use
// providerSessions.restoreInto(session, conv) and
// providerSessions.makeContext(conv, providerSession).

function handleRuntimeEvent(event) {
  // Task-identity routing (lifecycle fix): a stamped event belongs to the
  // conversation its task bound AT EXECUTION START — never to whichever
  // task/conversation is live when the event arrives. A late tail of an
  // already-released task is DROPPED here, BEFORE any projection, so it
  // can neither pollute the next task's conversation/UI nor bump its
  // telemetry. Unstamped events (session-level diagnostics outside any
  // task) keep the legacy fallback routing.
  let targetId;
  if (event && event.taskId !== undefined) {
    targetId = taskEventTargets.get(event.taskId) || null;
    if (targetId == null) return;
  } else {
    targetId = runningConversationId !== null ? runningConversationId : store.liveConversationId;
  }
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
  // The harness task runner observes the pipeline LAST: it records
  // task_start/termination intent only for events carrying the active
  // task's own identity. The single final task_end is published by the
  // runner at the REAL completion boundary (run body returned + necessary
  // finalize), and onTaskEnd — which releases the binding — runs AFTER
  // that publication, so this projection still finds the task's routing
  // entry alive. The binding and busy flags are not released anywhere
  // above — onTaskEnd owns them, guarded by task id.
  taskRunner.observeEvent(event);
}

export const session = new AgentSession({
  modelClient: wiredModelClient,
  toolExecutor: wiredToolExecutor,
  buildSystemPrompt: buildSystemPrompt,
  emit: handleRuntimeEvent,
  // M1b: the session boundary resets the SAME canonical instance the
  // task preparation configured (interpreter globals/modules/tmp die
  // here; verified assets and the lifecycle object survive).
  onSessionReset: () => { const rt = ensurePythonRuntime(); if (rt) rt.reset(); },
});

// ---------- harness task runner (M1a) ----------
// Owns admission, the task-lifetime controller, prepare→run→settle
// ordering and the storage-mutation quiesce gate. The Product side of
// the split: prepareTask below supplies conversation binding, image
// building, provider-session persistence, VFS/Python preparation.
const taskRunner = createTaskRunner({
  emit: handleRuntimeEvent,
  prepare: (task) => prepareTask(task),
  sessionEpoch: () => session.generation,
  // No finalizeTask registered, deliberately: an audit of every write on
  // the completion path (persistConversation in handleRuntimeEvent /
  // taskFailedProductPart, appendPresentationEvent) found them all to be
  // OPTIONAL, failure-tolerant saves — none is a completion condition of
  // the task. Required writes (ensureSession, first user frame, run
  // checkpoints) are awaited inside prepare/run and classify through the
  // failure table; the finalizeTask seam stays available for a PROVEN
  // necessary completion write (M1b reconsideration point).
  onTaskEnd: (task) => {
    // Exactly once per task, AFTER the final task_end was published (the
    // projection above could still resolve this task's routing entry) and
    // before its ended promise resolves. Guarded by task id: a late
    // finish of an older task never releases a newer task's binding.
    if (boundTaskId === task.id) {
      runningConversationId = null;
      boundTaskId = null;
    }
    taskEventTargets.delete(task.id);
    store.busy = false;
    store.cancelling = false;
  },
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
//   confirmation→ CANCEL the mutation (behavior changes never ride an
//                 implicit deny that might be read as a lasting verdict;
//                 the model is simply told the change did not happen).
export function denyApproval() {
  const pending = store.pendingApproval;
  if (!pending) return false;
  if (pending.kind === 'capability' || pending.kind === 'confirmation') {
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
  // true until the old task actually ends — the runner's admission is
  // never bypassed by flipping UI flags early.
  //
  // The session-level cancel/reset (not a runner cancel) is what carries
  // the session_changed outcome: an in-run task is aborted through the
  // session's controller, and a still-preparing task is recognized by the
  // runner's epoch guard after its next liveness check.
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
  const projected = session.historyRequestBytes(vfs, capabilityManager ? capabilityManager.buildTaskEnvironment() : null) + imageBytes + new TextEncoder().encode(JSON.stringify({ role: 'user', content: parts })).byteLength + 16;
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

// Product preparation for one ACCEPTED task, invoked by the harness task
// runner after the task has taken the active slot (admission and the task
// controller already exist — pre-run cancellation is task.cancel()).
// Self-checks task liveness after every await that precedes a side
// effect; the runner additionally guards when this resolves. Returns a
// PrepareOutcome (see src/harness/task-runner.js).
async function prepareTask(task) {
  // Task event identity (lifecycle fix): bind THIS task's id to the
  // conversation its events belong to, captured at execution start. The
  // binding is refined when the run conversation is pinned below; the
  // runner's pre-run terminals emitted before that still route here.
  taskEventTargets.set(task.id, store.liveConversationId);
  const input = task.input;

  // (1) The page can become interactive before IndexedDB/OPFS restoration
  // has finished. Hold the task while boot settles so it cannot race
  // boot's conversation/session restoration.
  if (persistenceBootPromise && !persistenceBootComplete) {
    store.busy = true;
    store.cancelling = false;
    try { await persistenceBootPromise; } catch (e) {}
  }

  // (2) An idle user may open an archived conversation and continue it.
  // Submission rebinds the session to the selected conversation.
  if (store.activeConversationId && store.activeConversationId !== store.liveConversationId) {
    const selected = store.conversations.find((c) => c.id === store.activeConversationId);
    if (selected) {
      store.liveConversationId = selected.id;
      const providerSessions = providerSessionsAdapter();
      if (providerSessions) {
        try {
          await providerSessions.restoreInto(session, selected);
        } catch (e) {
          selected.persistenceState = 'degraded';
          selected.runState = 'interrupted';
          selected.status = 'interrupted';
          reportPersistenceIssue(e, 'Conversation replay could not be restored');
          return { status: 'silent' };
        }
      }
      if (session.replayBlocked) {
        store.storageNotice = 'This conversation has an invalid durable checkpoint and was not sent to the provider. Start a new task to continue safely.';
        return { status: 'silent' };
      }
    }
  }
  const selectedConversation = store.conversations.find((c) => c.id === store.liveConversationId);
  if (selectedConversation && (selectedConversation.replayState === 'raw_invalid'
      || selectedConversation.persistenceState === 'degraded')) {
    store.storageNotice = selectedConversation.replayState === 'raw_invalid'
      ? 'This conversation has an invalid durable checkpoint and was not sent to the provider. Start a new task to continue safely.'
      : 'This conversation has degraded persistence and was not retried. Start a new task to continue safely.';
    return { status: 'silent' };
  }
  // Submitting always targets the live session. If the user is viewing an
  // archived conversation, snap back to the live one first — presentation
  // history is never replayed into provider history.
  store.activeConversationId = store.liveConversationId;

  // (3) Image attachments (docs/IMAGE-INPUT.md): durable snapshot +
  // semantic parts BEFORE any task state moves. Budget overflow blocks the
  // task with an explicit error; individual rejected images degrade to a
  // warning and the text still goes out.
  const imageBuild = await buildImageUserContent(input);
  if (imageBuild.blocked) return { status: 'silent' };
  const userContent = imageBuild.parts;

  store.plusMenuOpen = false;
  store.busy = true;
  store.cancelling = false;
  // Bind this task's events to the conversation that is live NOW, before
  // run() starts. If newTask()/mountFolder() later moves liveConversationId
  // while this task is still settling, its tail events still land here.
  if (store.liveConversationId == null) startConversation(); // defensive: never route into a random conversation
  runningConversationId = store.liveConversationId;
  boundTaskId = task.id;
  taskEventTargets.set(task.id, store.liveConversationId);
  const boundConversation = store.conversations.find((c) => c.id === runningConversationId);
  // Pre-run terminal paths backfill a task_start only when the bound
  // conversation would otherwise never see the submitted intent (same
  // predicate the old projectPreRunIntent used).
  const preRunStart = () => boundConversation && !boundConversation.items.length && boundConversation.status === 'idle';
  // Session-generation pin: rebinding to an archived conversation (above)
  // already advanced the generation legitimately; from HERE any further
  // change is a session boundary for this task.
  let pinnedGeneration = session.generation;
  // Liveness sentinel handed back to the runner: a ready result whose run
  // body does nothing. The runner's guards (signal first, then epoch) turn
  // it into the honest cancelled / session_changed terminal — this task
  // must not reach AgentSession.run().
  const stopReady = () => ({ status: 'ready', run: async () => {}, epoch: pinnedGeneration, preRunStart });
  const preRunStopped = () => task.signal.aborted || session.generation !== pinnedGeneration;

  let contextBound = false;
  try {
    // (4) Durable ordering: user presentation/semantic/provider state is
    // committed before AgentSession can make the first model request.
    // Rich content (image attachment refs) rides in the same frame —
    // base64 never enters persistence (docs/IMAGE-INPUT.md).
    const providerSessions = providerSessionsAdapter();
    if (providerSessions) {
      const providerSession = await providerSessions.ensureSession(boundConversation);
      if (preRunStopped()) return stopReady();
      persistenceContext = providerSessions.makeContext(boundConversation, providerSession);
      if (providerSession && Array.isArray(providerSession._projectedHistory)
        && providerSession._projectedHistory.length) {
        // Intentional provider-session rebind, not a user workspace switch.
        session.reset();
        pinnedGeneration = session.generation;
        // Explicit adoption (runner contract): without this the runner
        // would classify any failure after this point against the
        // submit-time epoch and misread THIS legitimate rebind as an
        // external session boundary. After adoption, failure
        // classification and the ready liveness guard compare against
        // the adopted generation.
        task.adoptEpoch(pinnedGeneration);
        session.history = projectNormalizedHistory(providerSession._projectedHistory, providerConfig().dialect);
        delete providerSession._projectedHistory;
      }
      if (providerSession && providerSession._replayBlocked) session.replayBlocked = true;
      if (session.replayBlocked) {
        return {
          status: 'blocked', code: 'raw_replay_invalid',
          message: 'Durable conversation history is invalid; no provider request was sent. Start a new task to continue safely.',
        };
      }
      boundConversation.runState = 'running';
      boundConversation.updatedAt = new Date().toISOString();
      await persistConversation(boundConversation, { required: true });
      await persistenceContext.onUserMessage(input, userContent);
      if (preRunStopped()) return stopReady();
      if (typeof session.setPersistenceContext === 'function') session.setPersistenceContext(persistenceContext);
      contextBound = true;
    }
    // (5) Capability Composition v1: build THIS task's immutable
    // environment, prepare the python plugin set for it, and bind
    // per-task mounts on a FORK of the live VFS. A workspace switch
    // mid-task can never rebind this task's filesystem routing — its late
    // async operations keep touching the OLD provider, and the
    // generation/abort guards drop its results.
    if (capabilityManager) await capabilityManager.refreshSkillPresence();
    // The refresh AWAITED: a cancel or session boundary that landed while
    // it hung ends THIS task here. The canonical interpreter is never
    // prepared/reset/reconfigured for a task that will not run, and no
    // model request can follow (the runner's guards classify the outcome;
    // the epoch in the ready result below stays the SUBMIT-time pin, so a
    // boundary is detected instead of adopted by accident).
    if (preRunStopped()) return stopReady();
    const taskEnvironment = capabilityManager ? capabilityManager.buildTaskEnvironment() : null;
    await preparePythonRuntimeForEnvironment(taskEnvironment, task.signal);
    // prepare awaited too (runtime-side signal refusal): the same liveness
    // rule before any task-scoped mount is bound for this task.
    if (preRunStopped()) return stopReady();
    const taskVfs = vfs.fork();
    if (capabilityManager && taskEnvironment) {
      if (taskEnvironment.skills.length && typeof SkillInstanceWorkspace === 'function') {
        // Task-bound approval-guarded view of /home/locus/.skills: every
        // skill mutation of this task (shell redirects, rm, curl -o,
        // python write-backs) suspends on a confirmation here. The signal
        // getter is generation-pinned — after a session switch this fork's
        // guard fails closed instead of borrowing the next task's signal.
        const forkGeneration = session.generation;
        taskVfs.mount('/home/locus/.skills', new SkillInstanceWorkspace({
          storage: capabilityManager.skillInstances,
          context: {
            approvals: approvals,
            conversationId: runningConversationId || store.liveConversationId || null,
            taskGeneration: session.generation,
            getSignal: () => ((session.generation === forkGeneration && session.task)
              ? session.task.controller.signal : null),
            taskEnvironment: taskEnvironment,
          },
        }), 'read-write');
      }
      for (const mount of capabilityManager.taskVfsMounts(taskEnvironment)) {
        taskVfs.mount(mount.path, mount.provider, mount.authority);
      }
    }
    return {
      status: 'ready',
      epoch: session.generation,
      preRunStart,
      run: async (ctx) => {
        // run() resolves only AFTER task_end has been emitted — by the
        // time this await returns, no late event of this task is in
        // flight. One user turn: text + selected image attachments bind
        // into a single provider turn; run() emits ONE task_start.
        try {
          await session.run(input, { workspace: taskVfs, taskEnvironment, userContent, controller: ctx.controller, emit: ctx.emit });
        } catch (e) {
          // The runner emits the error/terminal pair; this is the Product
          // side of the old catch block (degraded marking + snapshot).
          taskFailedProductPart(boundConversation, e);
          throw e;
        } finally {
          if (contextBound && typeof session.setPersistenceContext === 'function') session.setPersistenceContext(null);
          persistenceContext = null;
        }
      },
    };
  } catch (e) {
    // Preparation failed (required persistence failure, ensureSession
    // fault…): report it STRUCTURED (never rethrow) so the runner can
    // classify, backfill the pre-run start and emit exactly one terminal.
    taskFailedProductPart(boundConversation, e);
    return { status: 'failed', error: e, preRunStart };
  }
}

// Product-side failure bookkeeping shared by the prepare and run paths
// (the runner owns the error/task_end events).
function taskFailedProductPart(conv, e) {
  if (!conv) return;
  if (isPersistenceFailure(e)) {
    conv.persistenceState = 'degraded';
    reportPersistenceIssue(e, 'Task persistence failed');
  }
  persistConversation(conv);
}

export async function submit(text) {
  const input = String(text || '').trim();
  if (!input) return;
  // While an approval is pending the composer must not start a new task —
  // approve, deny, or cancel the task are the three available actions.
  if (store.pendingApproval) return;
  // Admission (one active task, storage-mutation gate, boot wait) is the
  // harness runner's; a refused submit is silent exactly as before.
  const handle = taskRunner.submit(input);
  if (!handle) return;
  await handle.ended;
}

export function cancelTask() {
  // Pre-run AND in-run cancellation share the task-lifetime controller
  // owned by the harness runner (previously the pre-run window used a
  // separate pendingCancel flag). The session-level cancel is kept for
  // the run phase: with the real AgentSession it aborts the very same
  // task controller (handed over via run({ controller })); sessions that
  // create their own controller (standalone harnesses, test fakes) are
  // still cancelled through it.
  const task = taskRunner.activeTask();
  if (!task) return;
  if (!task.signal.aborted) {
    task.cancel('user');
    if (session.task) session.cancel();
    store.cancelling = true;
  }
}

// ---------- workspace ----------

async function pickDirectory() {
  const h = hooks();
  if (h && typeof h.pickDirectory === 'function') return h.pickDirectory();
  if (!window.showDirectoryPicker) {
    throw new Error('This browser does not support the File System Access API (use desktop Chrome / Edge).');
  }
  return window.showDirectoryPicker({ mode: 'readwrite' });
}

// One runtime gate for every destructive/mount mutation (M1a: the stop,
// wait and mutual-exclusion semantics live in the harness runner's
// quiesceAndRun — admission stays closed for the whole window and the
// gate is released even when the action throws). UI disabled states are
// only a convenience; this gate is the authority.
async function withStorageMutation(action) {
  try {
    return await taskRunner.quiesceAndRun(action, { timeoutMs: STORAGE_MUTATION_TIMEOUT_MS });
  } catch (e) {
    if (e && e.code === 'active_task_did_not_stop') store.storageNotice = e.message;
    throw e;
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
      const providerSessions = providerSessionsAdapter();
      if (providerSessions) await providerSessions.restoreInto(session, continuation);
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
