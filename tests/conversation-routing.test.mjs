// Conversation-routing regression tests (node, no DOM):
// the REAL presentation store (src/ui/store.js) wired to a fake
// AgentSession at the documented DI seam. Proves the P3.1 invariant:
//
//   a task's runtime events follow the task's bound conversation,
//   not whichever conversation is live/active when the event arrives.
//
// Run: node tests/conversation-routing.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- stub runtime globals BEFORE importing the store ----------
// Fake AgentSession: scriptable run(). Each script entry is either an
// event object to emit, or an async function (controller, session) — used
// to suspend mid-task until the test releases it or an abort arrives.
class FakeAgentSession {
  constructor(deps) {
    this.emit = deps.emit;
    this.onSessionReset = deps.onSessionReset;
    this.history = [];
    this.generation = 0;
    this.task = null;
    this.script = [];
    this.throwOnRun = null;
  }
  reset() {
    if (this.task) this.task.controller.abort();
    this.history = [];
    this.generation++;
    if (this.onSessionReset) this.onSessionReset();
  }
  cancel() { if (this.task) this.task.controller.abort(); }
  async run(input, opts) {
    if (this.task) throw new Error('AgentSession already has a running task');
    if (this.throwOnRun) throw new Error(this.throwOnRun);
    // Mirror the real AgentSession seam (M1a lifecycle fix): a task-bound
    // emit sink handed in by the harness runner's ctx wins; standalone
    // emission keeps this.emit. The sink is recorded so tests can inject
    // a LATE tail through an already-ended task's entry point.
    const o = opts || {};
    const emit = (o.emit && typeof o.emit === 'function') ? o.emit : this.emit;
    this.lastRunEmit = emit;
    const controller = new AbortController();
    this.task = { controller };
    try {
      emit({ type: 'task_start', input });
      for (const step of this.script) {
        if (typeof step === 'function') await step(controller, this);
        else emit(step);
      }
    } finally {
      if (this.task && this.task.controller === controller) this.task = null;
    }
  }
}

const projectorSrc = readFileSync(join(root, 'src', 'ui', 'projector.js'), 'utf8');
globalThis.LocusProjector = (0, eval)(projectorSrc + '\n;LocusProjector');
globalThis.AgentSession = FakeAgentSession;
globalThis.Model = { apiKey: '', apiBase: '', model: 'test-model', proxy: '', dialect: 'auto' };
globalThis.callModel = async () => ({});
globalThis.executeTool = async () => ({ output: '', success: true });
globalThis.buildSystemPrompt = () => 'test';
globalThis.verifyConnection = async () => {};
globalThis.LocalDirectoryWorkspace = class {};
globalThis.ensureWorkspacePermission = async () => true;
// PythonRuntime intentionally left undefined — store guards with typeof.
// store.js boots ONE persistent VFS at module scope: provide the REAL
// vfs.js (plus workspace.js it extends from) exactly like index.html does.
globalThis.SHELL_COMMANDS = {};
globalThis.ApprovalController = (0, eval)(
  readFileSync(join(root, 'src', 'approval.js'), 'utf8') + String.fromCharCode(10) + ';ApprovalController');
globalThis.VirtualWorkspace = (0, eval)(
  readFileSync(join(root, 'src', 'workspace.js'), 'utf8') + '\n'
  + readFileSync(join(root, 'src', 'vfs.js'), 'utf8') + '\n;VirtualWorkspace');

const ui = await import('../src/ui/store.js');
const { store, session, submit, newTask, openConversation } = ui;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitAbort = (controller) => new Promise((r) => controller.signal.addEventListener('abort', r));

function gate() {
  let release;
  const p = new Promise((r) => { release = r; });
  return { wait: () => p, release };
}

const convById = (id) => store.conversations.find((c) => c.id === id);
const kinds = (conv) => conv.items.map((i) => i.kind);

// Boot: one idle conversation exists (A).
const A = store.conversations[0];
check('R0 boot conversation exists', !!A && store.liveConversationId === A.id);

// ---------- Case A: old task tail events never enter the new conversation ----------
{
  session.script = [
    waitAbort,
    { type: 'warning', code: 'session_changed', message: '会话已切换，丢弃本次任务的后续结果。' },
    { type: 'task_end', reason: 'session_changed' },
  ];
  const pA = submit('task A hangs until cancelled');
  await sleep(20);
  check('A1 task A running', store.busy === true && A.status === 'running');

  newTask(); // cancel + reset + create B (live/active)
  const B = store.conversations[0];
  check('A2 newTask creates B as live/active', B.id !== A.id
    && store.liveConversationId === B.id && store.activeConversationId === B.id);
  check('A3 busy stays until old task actually ends', store.busy === true);

  await pA; // old task settles: warning + task_end emitted AFTER B exists
  await sleep(20);

  check('A4 old tail events land in A',
    A.items.some((i) => i.kind === 'warning' && i.code === 'session_changed')
    && A.status === 'session_changed', kinds(A).join(',') + '/' + A.status);
  check('A5 B receives no old warning / task_end',
    B.items.length === 0 && B.status === 'idle', kinds(B).join(',') + '/' + B.status);
  check('A6 busy released after settle', store.busy === false);

  // ---------- Case B: after A settles, B runs its own task cleanly ----------
  session.script = [
    { type: 'reasoning', content: 'thinking about B', presentation: 'raw' },
    { type: 'tool_call', tool: 'bash', input: 'ls' },
    { type: 'tool_result', tool: 'bash', backend: 'browser', success: true, output: 'a.csv', operation: 'shell' },
    { type: 'assistant_text', content: 'B done' },
    { type: 'task_end', reason: 'completed' },
  ];
  await submit('task B normal');
  check('B1 B task fully projected into B',
    JSON.stringify(kinds(B)) === JSON.stringify(['user', 'reasoning', 'tool', 'assistant'])
    && B.status === 'completed', kinds(B).join(',') + '/' + B.status);
  check('B2 tool result attached with backend metadata',
    B.items[2].result && B.items[2].result.backend === 'browser');
  const aItemsAfterA = A.items.length;
  check('B3 A received none of B events', A.items.length === aItemsAfterA
    && !A.items.some((i) => i.content === 'B done'));

  // ---------- Case C: viewing history must not change event destination ----------
  const g = gate();
  session.script = [
    { type: 'reasoning', content: 'r1 before switching view', presentation: 'raw' },
    () => g.wait(),
    { type: 'reasoning', content: 'r2 while user views A', presentation: 'raw' },
    { type: 'assistant_text', content: 'C final' },
    { type: 'task_end', reason: 'completed' },
  ];
  const bItemsBeforeC = B.items.length;
  const pC = submit('task C in B');
  await sleep(20);
  check('C1 r1 projected into B before view switch',
    B.items.some((i) => i.content === 'r1 before switching view'));

  openConversation(A.id); // user is now LOOKING at A while C runs in B
  check('C2 active view is A', store.activeConversationId === A.id
    && store.liveConversationId === B.id);
  g.release();
  await pC;
  await sleep(20);

  check('C3 events emitted while viewing A still land in B',
    B.items.some((i) => i.content === 'r2 while user views A')
    && B.items.some((i) => i.content === 'C final'));
  check('C4 A unchanged while viewed during C',
    A.items.length === aItemsAfterA && !A.items.some((i) => i.content === 'C final'));
  check('C5 B item count grew by exactly C events', B.items.length === bItemsBeforeC + 4,
    String(B.items.length - bItemsBeforeC));

  // ---------- Case D: run() throwing before a task releases the binding ----------
  session.throwOnRun = 'simulated pre-task failure';
  const bItemsBeforeD = B.items.length;
  openConversation(B.id);
  await submit('task D rejected');
  session.throwOnRun = null;
  check('D1 pre-task failure surfaces as error in the bound conversation',
    B.items.length === bItemsBeforeD + 1
    && B.items[B.items.length - 1].kind === 'error'
    && B.items[B.items.length - 1].code === 'task_rejected');
  check('D2 busy cleared', store.busy === false);

  // binding was released: a following task routes normally
  session.script = [
    { type: 'assistant_text', content: 'after D' },
    { type: 'task_end', reason: 'completed' },
  ];
  await submit('task E after failure');
  check('D3 binding reusable after pre-task failure',
    B.items.some((i) => i.content === 'after D') && B.status === 'completed');

  // ---------- Case E: a late tail of an ENDED task cannot pollute anything (F2) ----------
  {
    session.script = [
      { type: 'assistant_text', content: 'stale-tail source final' },
      { type: 'task_end', reason: 'completed' },
    ];
    await submit('stale-tail source');
    const staleEmit = session.lastRunEmit; // the ended task's task-bound sink
    check('E0 captured a task-bound emit sink from the ended task', typeof staleEmit === 'function');

    const g = gate();
    session.script = [
      { type: 'reasoning', content: 'G working', presentation: 'raw' },
      () => g.wait(),
      { type: 'assistant_text', content: 'G final' },
      { type: 'task_end', reason: 'completed' },
    ];
    const bItemsBeforeG = B.items.length;
    const pG = submit('task G with stale tails');
    await sleep(20);
    check('E1 G is running in B', store.busy === true && B.status === 'running');

    // The ended task's entry point emits a full late tail — including a
    // task_start that would double-start G and a terminal that would end it.
    staleEmit({ type: 'tool_result', tool: 'bash', success: true, output: 'STALE-TAIL-OUTPUT' });
    staleEmit({ type: 'warning', code: 'late_warning', message: 'stale tail' });
    staleEmit({ type: 'task_start', input: 'late restart' });
    staleEmit({ type: 'task_end', reason: 'error' });
    await sleep(20);

    check('E2 stale tail events dropped BEFORE projection (B untouched)',
      B.items.length === bItemsBeforeG + 2 // G's user item + its first reasoning (before the gate)
      && !B.items.some((i) => (i.result && i.result.output) === 'STALE-TAIL-OUTPUT')
      && !B.items.some((i) => i.kind === 'warning'), kinds(B).join(',') + '/' + B.status);
    check('E3 stale terminal does not settle G', store.busy === true && B.status === 'running', B.status);
    g.release();
    await pG;
    await sleep(20);
    check('E4 G completes with its own single terminal',
      B.status === 'completed' && B.items.some((i) => i.content === 'G final'), kinds(B).join(',') + '/' + B.status);
  }
}

console.log('---');
console.log('conversation-routing.test.mjs: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
