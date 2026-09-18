// Submit/presentation wiring regressions (node, no DOM):
// exercise the real store with a persistence seam so normal task_start
// ownership and pre-run terminal fallbacks are tested at their actual await
// boundaries.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

class FakeAgentSession {
  constructor(deps) {
    this.emit = deps.emit;
    this.onSessionReset = deps.onSessionReset;
    this.history = [];
    this.generation = 0;
    this.task = null;
    this.script = [];
    this.runCalls = 0;
  }

  reset() {
    if (this.task) this.task.controller.abort();
    this.history = [];
    this.generation++;
    if (this.onSessionReset) this.onSessionReset();
  }

  cancel() { if (this.task) this.task.controller.abort(); }

  async run(input) {
    if (this.task) throw new Error('AgentSession already has a running task');
    this.runCalls++;
    const controller = new AbortController();
    this.task = { controller };
    try {
      this.emit({ type: 'task_start', input });
      for (const step of this.script) {
        if (typeof step === 'function') await step(controller, this);
        else this.emit(step);
      }
    } finally {
      if (this.task && this.task.controller === controller) this.task = null;
    }
  }
}

globalThis.LocusProjector = (0, eval)(
  readFileSync(join(root, 'src', 'ui', 'projector.js'), 'utf8') + '\n;LocusProjector');
globalThis.AgentSession = FakeAgentSession;
globalThis.Model = { apiKey: '', apiBase: '', model: 'test-model', proxy: '', dialect: 'auto' };
globalThis.callModel = async () => ({});
globalThis.executeTool = async () => ({ output: '', success: true });
globalThis.buildSystemPrompt = () => 'test';
globalThis.verifyConnection = async () => {};
globalThis.LocalDirectoryWorkspace = class {};
globalThis.ensureWorkspacePermission = async () => true;
globalThis.SHELL_COMMANDS = {};
globalThis.VirtualWorkspace = (0, eval)(
  readFileSync(join(root, 'src', 'workspace.js'), 'utf8') + '\n'
  + readFileSync(join(root, 'src', 'vfs.js'), 'utf8') + '\n;VirtualWorkspace');
globalThis.getProviderAdapter = ({ dialect, apiBase }) => ({
  providerFamily: 'test-provider',
  adapterId: 'test-adapter',
  dialect: dialect || 'auto',
  apiBase,
  isRawReplayCompatible: () => true,
});
globalThis.createCredentialIdentity = (config) => ({
  provider: config.provider,
  adapterId: config.adapterId,
  dialect: config.dialect,
  endpointIdentity: config.apiBase,
});
globalThis.createProviderIdentity = (config) => ({
  provider: config.provider,
  adapterId: config.adapterId,
  dialect: config.dialect,
  endpointIdentity: config.apiBase,
  protocolVersion: 'test-v1',
});
globalThis.ApprovalController = (0, eval)(
  readFileSync(join(root, 'src', 'approval.js'), 'utf8') + '\n;ApprovalController');
globalThis.validateNormalizedPrefix = () => {};
globalThis.projectNormalizedHistory = (rows) => rows || [];

const ui = await import('../src/ui/store.js');
const { store, session, submit, newTask, cancelTask } = ui;

const providerSessions = new Map();
const presentationEvents = [];
let loadProviderSession = async () => null;
globalThis.PersistenceServiceInstance = {
  saveConversation: async (record) => record,
  get: async (storeName, id) => storeName === 'providerSessions' ? providerSessions.get(id) || null : null,
  loadProviderSession: async (conversationId) => loadProviderSession(conversationId),
  loadProviderFrames: async () => [],
  loadNormalizedMessages: async () => [],
  saveProviderSession: async (row) => { providerSessions.set(row.id, row); return row; },
  appendProviderFrame: async (row) => row,
  saveNormalizedMessage: async (row) => row,
  appendPresentationEvent: async (conversationId, sequence, event) => {
    presentationEvents.push({ conversationId, sequence, event });
  },
  notePersistenceError: () => {},
};

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

const live = () => store.conversations.find((c) => c.id === store.liveConversationId);
const userItems = (conv, content) => conv.items.filter((item) =>
  item.kind === 'user' && (content === undefined || item.content === content));
const taskStarts = (conversationId, input) => presentationEvents.filter((row) =>
  row.conversationId === conversationId && row.event.type === 'task_start'
  && (input === undefined || row.event.input === input));
// A. Normal first submit: AgentSession owns the only task_start.
{
  const conv = live();
  session.script = [
    { type: 'assistant_text', content: 'hello back' },
    { type: 'task_end', reason: 'completed' },
  ];
  await submit('hello');
  check('A1 first submit projects user message exactly once', userItems(conv, 'hello').length === 1,
    JSON.stringify(conv.items));
  check('A2 first submit keeps assistant completion', conv.items.some((item) => item.kind === 'assistant')
    && conv.status === 'completed');
  check('A3 normal task_start is owned by AgentSession', taskStarts(conv.id, 'hello').length === 1);
}

// B. Repeated equal content is legal and must not be deduplicated.
{
  const conv = live();
  session.script = [{ type: 'assistant_text', content: 'same answer' }, { type: 'task_end', reason: 'completed' }];
  await submit('same');
  await submit('same');
  check('B1 repeated equal submissions remain two user items', userItems(conv, 'same').length === 2,
    JSON.stringify(conv.items));
  check('B2 repeated equal submissions each persist one task_start', taskStarts(conv.id, 'same').length === 2);
}

// C. Cancellation while persistence is still pre-run preserves intent once.
{
  newTask();
  const conv = live();
  let release;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  loadProviderSession = async () => { markStarted(); await gate; return null; };
  const runsBefore = session.runCalls;
  const p = submit('cancel me');
  await started;
  cancelTask();
  release();
  await p;
  check('C1 pre-run cancellation preserves user intent once', userItems(conv, 'cancel me').length === 1,
    JSON.stringify(conv.items));
  check('C2 pre-run cancellation ends cancelled without provider run', conv.status === 'cancelled'
    && session.runCalls === runsBefore);
  check('C3 pre-run cancellation emits one synthetic task_start', taskStarts(conv.id, 'cancel me').length === 1);
  loadProviderSession = async () => null;
}

// D. A session boundary before run() preserves intent in the old conversation only.
{
  newTask();
  const conv = live();
  let release;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  loadProviderSession = async () => { markStarted(); await gate; return null; };
  const runsBefore = session.runCalls;
  const p = submit('old task');
  await started;
  newTask();
  const next = live();
  release();
  await p;
  check('D1 pre-run session switch preserves old user intent once', userItems(conv, 'old task').length === 1,
    JSON.stringify(conv.items));
  check('D2 pre-run session switch records terminal reason', conv.status === 'session_changed');
  check('D3 switched conversation receives no old input', userItems(next, 'old task').length === 0
    && session.runCalls === runsBefore);
  check('D4 pre-run session switch emits one synthetic task_start', taskStarts(conv.id, 'old task').length === 1);
  loadProviderSession = async () => null;
}

// E. Persistence rejection before run() keeps the existing catch fallback singular.
{
  newTask();
  const conv = live();
  const runsBefore = session.runCalls;
  loadProviderSession = async () => {
    throw Object.assign(new Error('simulated persistence failure'), { persistenceFailure: true });
  };
  await submit('persist fail');
  check('E1 pre-run persistence failure preserves user intent once', userItems(conv, 'persist fail').length === 1,
    JSON.stringify(conv.items));
  check('E2 pre-run persistence failure keeps terminal semantics', conv.status === 'persistence_error'
    && conv.items.filter((item) => item.kind === 'error' && item.code === 'persistence_write_failed').length === 1);
  check('E3 pre-run persistence failure sends no provider request', session.runCalls === runsBefore);
  loadProviderSession = async () => null;
}

console.log('---');
console.log('submit-presentation.test.mjs: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
