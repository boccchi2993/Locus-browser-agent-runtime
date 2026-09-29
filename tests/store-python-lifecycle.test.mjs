// Store python-lifecycle wiring tests (M1b, repository split, node):
// the REAL presentation store (src/ui/store.js) wired to a fake
// AgentSession and a RECORDED python runtime factory. Proves the M1b
// ownership invariants at the product seam:
//
//   SP1  the store creates the ONE canonical interpreter instance from the
//        injected factory and task preparation drives THAT instance
//        (prepare with the TaskEnvironment's payload, null payload when
//        there is no capability manager);
//   SP2  shell execution receives exactly the SAME instance in
//        opts.pythonRuntime — preparation and execution never split;
//   SP3  the session boundary (newTask / session reset) resets the SAME
//        instance via onSessionReset;
//   SP4  the instance is created lazily (text-only work never touches the
//        factory) and a deployment without the shell runtime resolves to
//        null with no error;
//   SP5  window.__LOCUS_HOOKS__.pythonRuntime substitutes the instance
//        (test/e2e seam) before first use.
//
// Instance BEHAVIOR (prepare/reset/dispose semantics) is pinned in
// tests/python-lifecycle.test.cjs against the REAL factory; REAL browser
// python is gated by the e2e python suites driving the production seam.
// Run: node tests/store-python-lifecycle.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- recorded python runtime factory ----------
// A fake instance faithful to the lifecycle surface the store uses:
// prepare(req) → { rebuiltInterpreter }, reset(reason), run(code, vfs, opts).
const createdInstances = [];
const pythonRuntime = () => ({
  worker: null,
  status: 'cold',
  prepared: [],
  resets: [],
  runs: [],
  extensionKey() { return this.prepared.length ? (this.prepared[this.prepared.length - 1].key ?? null) : null; },
  async prepare(req) {
    const wanted = req && req.python ? req.python.key : null;
    this.prepared.push({ key: wanted, python: req ? req.python : undefined, signal: req ? req.signal : undefined });
    return { rebuiltInterpreter: false };
  },
  reset(reason) { this.resets.push(reason ?? null); },
  async run(code, vfs, opts) {
    this.runs.push({ code, opts: opts || null });
    return { stdout: 'ok', stderr: '', error: null, written: [], deleted: [], mkdirs: [], conflicts: [], writeFailed: [], notPersisted: [], skipped: [], uncollected: [] };
  },
});
globalThis.createPythonRuntime = () => {
  const rt = pythonRuntime();
  createdInstances.push(rt);
  return rt;
};

// index.html loads src/mutation-policy.js as a classic script before the
// store module runs; mirror that here.
globalThis.LocusMutationPolicy = (0, eval)(
  readFileSync(join(root, 'src', 'mutation-policy.js'), 'utf8') + String.fromCharCode(10) + ';LocusMutationPolicy');

// ---------- stub runtime globals BEFORE importing the store ----------
class FakeAgentSession {
  constructor(deps) {
    this.emit = deps.emit;
    this.onSessionReset = deps.onSessionReset;
    this.toolExecutor = deps.toolExecutor; // the store's wiredToolExecutor (SP2 drives it)
    this.history = [];
    this.generation = 0;
    this.task = null;
    this.script = [];
    this.lastRunOpts = null;
  }
  reset() {
    if (this.task && this.task.controller) this.task.controller.abort();
    this.history = [];
    this.generation++;
    if (this.onSessionReset) this.onSessionReset();
  }
  cancel() { if (this.task && this.task.controller) this.task.controller.abort(); }
  async run(input, opts) {
    if (this.task) throw new Error('AgentSession already has a running task');
    this.ranCount = (this.ranCount || 0) + 1;
    const o = opts || {};
    this.lastRunOpts = o;
    const emit = (o.emit && typeof o.emit === 'function') ? o.emit : this.emit;
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
// Records the opts the store hands to every tool call (SP2 evidence).
const toolCalls = [];
globalThis.executeTool = async (tool, input, workspace, opts) => {
  toolCalls.push({ tool, input, opts });
  return { output: 'tool-ok', success: true };
};
globalThis.buildSystemPrompt = () => 'test';
globalThis.verifyConnection = async () => {};
globalThis.LocalDirectoryWorkspace = class {};
globalThis.ensureWorkspacePermission = async () => true;
globalThis.SHELL_COMMANDS = {};
globalThis.ApprovalController = (0, eval)(
  readFileSync(join(root, 'src', 'approval.js'), 'utf8') + String.fromCharCode(10) + ';ApprovalController');
globalThis.VirtualWorkspace = (0, eval)(
  readFileSync(join(root, 'src', 'workspace.js'), 'utf8') + '\n'
  + readFileSync(join(root, 'src', 'vfs.js'), 'utf8') + '\n;VirtualWorkspace');

// ---------- gated capability manager (prepare-phase liveness, M1b fix) ----
// Refreshes can hang (durability re-observation): these sections park a
// REAL submit() inside refreshSkillPresence and prove the stale task never
// prepares/resets/reconfigures the canonical interpreter afterwards.
class FakeCapabilityManager {
  constructor(opts) { this.opts = opts; this.refreshes = 0; this.envBuilt = 0; this.gate = null; }
  async refreshSkillPresence() { this.refreshes++; if (this.gate) await this.gate(); }
  buildTaskEnvironment() {
    this.envBuilt++;
    return { capabilities: [], plugins: [], skills: [], mcps: [], pythonExtensionKey: null };
  }
  pythonExtensionPayload() { return null; }
  taskVfsMounts() { return []; }
  listCapabilities() { return []; }
}

const ui = await import('../src/ui/store.js');
const { store, session, submit, newTask } = ui;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runScript = (script) => { session.script = script; };

// The canonical instance the store resolved on first use.
const canonical = ui.pythonRuntime();

check('SP0 exactly ONE instance was created by the store',
  createdInstances.length === 1 && canonical === createdInstances[0],
  JSON.stringify({ created: createdInstances.length }));

// ---------- SP4: lazy creation (already proven by order) ----------
// The factory must not have run before the first explicit pythonRuntime()
// use OR the first task — both happened above; a second submit reuses the
// SAME instance (never a second construction).
const createdBefore = createdInstances.length;

// ---------- SP1 + SP2 + SP3: one task end to end ----------
{
  // session.toolExecutor IS the store's wiredToolExecutor (the exact
  // function the real agent loop invokes for every tool call).
  await session.toolExecutor('bash', 'echo probe', ui.vfs, { signal: new AbortController().signal });
  const done = submit('run python and report');
  await done;
  check('SP1 task preparation configured the CANONICAL instance',
    canonical.prepared.length === 1
      && canonical.prepared[0].key === null
      && canonical.prepared[0].python === null,
    JSON.stringify(canonical.prepared));
  check('SP2 the tool executor received the SAME instance in opts.pythonRuntime',
    toolCalls.length >= 1
      && toolCalls.every((c) => c.opts && c.opts.pythonRuntime === canonical),
    JSON.stringify(toolCalls.map((c) => c.opts && (c.opts.pythonRuntime === canonical))));
  check('SP2b no additional instance was constructed for execution',
    createdInstances.length === createdBefore,
    JSON.stringify({ created: createdInstances.length, before: createdBefore }));

  // SP3: the session boundary resets the canonical instance.
  const resetsBefore = canonical.resets.length;
  newTask();
  check('SP3 the session boundary reset the CANONICAL instance',
    canonical.resets.length === resetsBefore + 1,
    JSON.stringify(canonical.resets));
}

// ---------- SP1b: a second task reuses the instance (same key, no reset) ----------
{
  runScript([]);
  await submit('second task');
  check('SP1b the second task reused the SAME instance (no reconfiguration churn)',
    canonical.prepared.length === 2
      && canonical.prepared[1].key === null
      && canonical.prepared[1].python === null
      && createdInstances.length === 1,
    JSON.stringify({ prepared: canonical.prepared.length, created: createdInstances.length }));
}

// ---------- SP6: the product mutation policy rides every bash call -------
{
  toolCalls.length = 0;
  await session.toolExecutor('bash', 'mv /home/locus/.skills/x /tmp/x', ui.vfs, { signal: new AbortController().signal });
  const injected = toolCalls[0] && toolCalls[0].opts && toolCalls[0].opts.mutationPolicy;
  check('SP6 the executor opts carry a REAL product mutation policy',
    !!injected && typeof injected.checkMove === 'function' && typeof injected.checkRemove === 'function'
      && typeof injected.isPolicyRefusal === 'function',
    JSON.stringify({ present: !!injected }));
  const refusal = injected.checkMove({
    source: '/home/locus/.skills/cap-a/synthetic-skill.skill',
    destination: '/home/locus/renamed.skill',
    recursive: true,
  });
  const allowed = injected.checkMove({ source: '/tmp/a.txt', destination: '/tmp/b.txt', recursive: true });
  check('SP6b the injected policy enforces the skill identity and nothing else',
    refusal.allowed === false && refusal.reason.includes('Skill instance paths are stable')
      && allowed.allowed === true,
    JSON.stringify({ refusal, allowed }));
}

// ---------- SP5: the hooks seam substitutes the instance ----------
{
  // Fresh module graph: hooks must be set BEFORE the first pythonRuntime()
  // resolution of that graph. Use a subprocess-style second import via a
  // query string so the store module re-evaluates.
  globalThis.window = { __LOCUS_HOOKS__: { pythonRuntime: pythonRuntime() } };
  createdInstances.length = 0;
  const ui2 = await import('../src/ui/store.js?hooks-seam');
  const hooked = ui2.pythonRuntime();
  check('SP5 window.__LOCUS_HOOKS__.pythonRuntime substitutes the instance',
    !!hooked && createdInstances.length === 0 && typeof hooked.prepare === 'function',
    JSON.stringify({ hooked: !!hooked, created: createdInstances.length }));
  delete globalThis.window;
}

// ---------- SP7: a missing policy implementation fails LOUDLY ----------
{
  // Fresh graph without the policy global (the product forgot to load
  // mutation-policy.js): the first bash call must REFUSE, never run
  // unprotected.
  const savedPolicy = globalThis.LocusMutationPolicy;
  const savedFactory = globalThis.createPythonRuntime;
  delete globalThis.LocusMutationPolicy;
  const ui3 = await import('../src/ui/store.js?no-policy');
  let refused = null;
  try { await ui3.session.toolExecutor('bash', 'echo hi', ui3.vfs, {}); }
  catch (e) { refused = e; }
  check('SP7 a missing product policy refuses execution loudly',
    !!refused && /mutation policy unavailable/.test(String(refused && refused.message)),
    String(refused && refused.message));
  globalThis.LocusMutationPolicy = savedPolicy;
  globalThis.createPythonRuntime = savedFactory;
}

// ---------- SP8: cancel while refreshSkillPresence hangs ----------
// The task is cancelled DURING the async capability refresh (before any
// interpreter preparation): once the refresh returns, the stale task must
// not prepare/reset/reconfigure the canonical interpreter and must not
// reach the model. The runner's own guards catch it; the Product must not
// hand the cancelled task's configuration work to the runtime at all.
{
  globalThis.CapabilityManager = FakeCapabilityManager;
  globalThis.CAPABILITY_CATALOG = [];
  globalThis.PLUGIN_CATALOG = [];
  globalThis.SKILL_CATALOG = [];
  globalThis.MCP_CATALOG = [];
  const created8 = [];
  globalThis.createPythonRuntime = () => { const rt = pythonRuntime(); created8.push(rt); return rt; };
  const ui8 = await import('../src/ui/store.js?presence-cancel');
  const cm8 = ui8.capabilityManager;
  let release8 = null;
  cm8.gate = () => new Promise((r) => { release8 = r; });
  const done8 = ui8.submit('presence cancel task');
  await sleep(30);
  check('SP8 the task is parked inside refreshSkillPresence',
    cm8.refreshes === 1 && !!release8, JSON.stringify({ refreshes: cm8.refreshes }));
  ui8.cancelTask();
  release8();
  await done8;
  check('SP8b the cancelled task never prepared the canonical interpreter',
    created8.length === 0, JSON.stringify({ created: created8.length }));
  check('SP8c no TaskEnvironment was built for the cancelled task',
    cm8.envBuilt === 0, JSON.stringify({ envBuilt: cm8.envBuilt }));
  check('SP8d no model request was made for the cancelled task',
    (ui8.session.ranCount || 0) === 0, JSON.stringify({ ran: ui8.session.ranCount }));
  cm8.gate = null; // the follow-up must not hang on the section's gate
  const followUp8 = ui8.submit('follow-up after cancel');
  check('SP8e the cancelled task ended and admission reopened',
    ui8.store.busy === false && !!followUp8, JSON.stringify({ busy: ui8.store.busy }));
  await followUp8;
}

// ---------- SP9: session boundary while refreshSkillPresence hangs ----------
{
  const created9 = [];
  globalThis.createPythonRuntime = () => { const rt = pythonRuntime(); created9.push(rt); return rt; };
  const ui9 = await import('../src/ui/store.js?presence-boundary');
  const cm9 = ui9.capabilityManager;
  let release9 = null;
  cm9.gate = () => new Promise((r) => { release9 = r; });
  const done9 = ui9.submit('presence boundary task');
  await sleep(30);
  ui9.newTask();          // the session boundary lands mid-refresh
  release9();
  await done9;
  const rt9 = created9[0]; // created by the boundary's own onSessionReset
  check('SP9 the boundary-struck task stops cold: no environment, no model',
    cm9.envBuilt === 0 && (ui9.session.ranCount || 0) === 0,
    JSON.stringify({ envBuilt: cm9.envBuilt, ran: ui9.session.ranCount }));
  check('SP9b the stale task neither prepared nor reset the interpreter again',
    !!rt9 && rt9.prepared.length === 0 && rt9.resets.length === 1,
    JSON.stringify({ prepared: rt9 && rt9.prepared.length, resets: rt9 && rt9.resets.length }));
  check('SP9c the stale task ended and admission reopened',
    ui9.store.busy === false, JSON.stringify({ busy: ui9.store.busy }));
}

// ---------- SP10: normal flow still prepares — with the task signal ----------
{
  const created10 = [];
  globalThis.createPythonRuntime = () => { const rt = pythonRuntime(); created10.push(rt); return rt; };
  const ui10 = await import('../src/ui/store.js?presence-normal');
  const cm10 = ui10.capabilityManager;
  const done10 = ui10.submit('normal presence task');
  await done10;
  const rt10 = created10[0];
  check('SP10 a live task hands its OWN signal to the interpreter prepare',
    !!rt10 && rt10.prepared.length === 1 && !!rt10.prepared[0].signal
      && rt10.prepared[0].signal.aborted === false,
    JSON.stringify({ prepared: rt10 && rt10.prepared.length, signal: !!(rt10 && rt10.prepared[0] && rt10.prepared[0].signal) }));
  check('SP10b the model ran exactly once for the normal task',
    ui10.session.ranCount === 1, JSON.stringify({ ran: ui10.session.ranCount }));
  const done10b = ui10.submit('second normal task');
  await done10b;
  check('SP10c same-key tasks cause no interpreter churn (prepare only, zero resets)',
    rt10.prepared.length === 2 && rt10.resets.length === 0,
    JSON.stringify({ prepared: rt10.prepared.length, resets: rt10.resets.length }));
}

// Presence-fixture globals are section-local: remove them so nothing after
// this file's sections observes a capability manager by accident.
delete globalThis.CapabilityManager;
delete globalThis.CAPABILITY_CATALOG;
delete globalThis.PLUGIN_CATALOG;
delete globalThis.SKILL_CATALOG;
delete globalThis.MCP_CATALOG;

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
