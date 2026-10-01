// M2c joint integration gates (I1–I7): the REAL Harness (public entry,
// self-assembled), the REAL Product adapter (src/product/tool-adapter.js +
// src/tools.js — the production chain), the REAL Runtime (public entry) and
// the REAL VFS, driven through the REAL product task entry
// (src/ui/store.js: submit → task runner → prepareTask → AgentSession).
//
// The MODEL is the only fake: a scripted provider transport injected at
// Model.transport, so every request traverses the real model client and the
// real provider adapter serialization (the wire-suite boundary). No fake
// two-core shortcut anywhere; the standalone runtime/harness host pages stay
// separate gates and are NOT counted as joint evidence here.
//
//   I1  normal chain: model tool call → product adapter → runtime shell
//       writes+reads the real VFS → the NEXT model request carries the tool
//       result → final answer, task completed
//   I2  failure propagation: a real runtime failure reaches the harness as
//       a failed tool result (never converted into success)
//   I3  cancellation and session boundary: parked model + composer cancel;
//       newTask boundary ends the old task without further dispatch;
//       already-committed effects stay (no fake rollback)
//   I4  session isolation: the old task's late model answer cannot leak
//       into the successor's conversation or VFS
//   I5  permission: a real curl -o network-write approval DENIED through
//       the real controller → zero fetch dispatch (offline oracle)
//   I6  compatibility negatives through the REAL product entry: runtime
//       protocol version, harness REGISTRY version, required policy
//       capability, hostile declaration shape → core_incompatible, zero
//       model requests / zero required writes / zero prepare+execute /
//       zero tool dispatch, slot released, next legal task runs
//   I7  replay + required persistence over an in-memory store with the
//       REAL harness replay validators: legal history replays without
//       tool re-execution; corrupted checkpoint and uncheckpointed suffix
//       reject replay (zero model, zero tool); required-write failure
//       stays persistence_error with zero further model requests
//
// Run: node tests/product-integration.test.mjs

import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = (...p) => readFileSync(join(root, ...p), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

// Event-barrier helpers: waiting keys off REACHED STATES, timeouts are only
// the failure bound (never an ordering proof).
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function waitFor(desc, condFn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try { ok = !!condFn(); } catch (e) { ok = false; }
    if (ok) return true;
    if (Date.now() > deadline) throw new Error('waitFor timeout: ' + desc);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------- REAL cores over their public entries ----------
const runtimeEntry = await import('../src/runtime/index.js');
const { PY_WORKER_SOURCE, GREP_WORKER_SOURCE } = await import('../src/runtime/worker-assets.js');
// The FIRST createRuntime() resolves the core (self-assembly) and publishes
// the runtime core registry — afterwards every later host (one per store
// graph, like one per page) delegates to the SAME registry (the product
// page's registry mode). The published globalThis names (VirtualWorkspace,
// SHELL_COMMANDS, …) are what the store reads at module scope.
await runtimeEntry.createRuntime({
  workerAssets: { pyWorkerSource: PY_WORKER_SOURCE, grepWorkerSource: GREP_WORKER_SOURCE },
});

const harnessEntry = await import('../src/harness/index.js');
// The REAL harness core self-assembles; the product store and the real
// harnessCapabilities() both resolve through the published table.
await harnessEntry.ensureHarnessCore();

// ---------- product classic sources (the production adapter path) ----------
globalThis.LocusMutationPolicy = (0, eval)(readSrc('src', 'mutation-policy.js') + '\n;LocusMutationPolicy');
globalThis.LocusProjector = (0, eval)(readSrc('src', 'ui', 'projector.js') + '\n;LocusProjector');
// telemetry.js (utf8ByteLength + Telemetry) and tools.js share ONE eval so
// the tool adapter resolves its helpers through the same lexical scope the
// product page uses; tools.js stays the ONLY tool adaptation path.
const toolGlobals = (0, eval)(readSrc('src', 'telemetry.js') + '\n' + readSrc('src', 'tools.js')
  + '\n;[utf8ByteLength, Telemetry, executeTool, AGENT_TOOL_DEFINITIONS]');
globalThis.executeTool = toolGlobals[2];
globalThis.AGENT_TOOL_DEFINITIONS = toolGlobals[3];
globalThis.Telemetry = toolGlobals[1];
// extensions.js is the PRODUCT adapter half of the extensions split; its
// composition-core references resolve through the names the harness core
// already published (one live copy). The store wires task mounts through
// its productTaskVfsMounts adapter.
const extGlobals = (0, eval)(readSrc('src', 'extensions.js')
  + '\n;[productTaskVfsMounts, SkillInstanceStorage, SkillInstanceWorkspace, StaticFileWorkspace]');
globalThis.productTaskVfsMounts = extGlobals[0];
globalThis.SkillInstanceStorage = extGlobals[1];
globalThis.SkillInstanceWorkspace = extGlobals[2];
globalThis.StaticFileWorkspace = extGlobals[3];

// ---------- the scripted provider transport (the ONLY fake) ----------
function createWire(name) {
  const calls = [];
  const queue = [];
  const respond = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json' },
  });
  const transport = async (url, init) => {
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k] = v;
    const body = JSON.parse(init.body || '{}');
    const record = { name, url, headers, body };
    calls.push(record);
    const next = queue.length ? queue.shift() : null;
    if (next === null) return respond({ choices: [{ message: { role: 'assistant', content: 'joint default answer' }, finish_reason: 'stop' }] });
    // { park: true } -> a REAL-transport-shaped pending response: the
    // scripted transport honors init.signal exactly like fetch does, so
    // task cancellation actually reaches the in-flight request.
    if (next && next.__park) {
      return new Promise((resolve, reject) => {
        const signal = init && init.signal;
        const onAbort = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        if (signal && signal.aborted) { onAbort(); return; }
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (typeof next === 'function') return next(record, respond);
    return respond(next);
  };
  return {
    calls, transport,
    push: (r) => queue.push(r),
    openai: (content, toolCalls) => ({
      choices: [{
        message: toolCalls
          ? { role: 'assistant', content: content || null, tool_calls: toolCalls }
          : { role: 'assistant', content },
        finish_reason: toolCalls ? 'tool_calls' : 'stop',
      }],
    }),
    toolCall: (id, input) => ({
      id, type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({ input }) },
    }),
  };
}
const wires = new Map();

// The product settings path is the production authority: applySettings()
// (store boot) overwrites the Model singleton from store.settings, so the
// wire scenarios configure the STORE settings + applySettings (exactly the
// wire e2e does), then attach the scripted transport to Model.transport
// (applySettings never touches the transport).
function configureModel(wire) {
  globalThis.Model.transport = wire ? wire.transport : undefined;
}
function applyJointSettings(ui) {
  ui.store.settings.apiKey = 'JOINT-KEY';
  ui.store.settings.apiBase = 'https://joint.invalid/v1';
  ui.store.settings.model = 'joint-model';
  ui.store.settings.proxy = '';
  ui.store.settings.dialect = 'openai';
  ui.applySettings();
}

// Counters wrapped ONTO the real runtime session / real executor of one
// store graph (instrumentation of the production objects, never a
// replacement of them).
async function instrument(ui) {
  const counts = { prepare: 0, execute: 0, tool: 0, toolNames: [] };
  // The runtime session resolves lazily on the task path; force the ONE
  // resolution so the counters wrap the SAME object the chain drives.
  const session = (await ui.whenRuntimeSession()) || ui.runtimeSession();
  const origPrepare = session.prepare.bind(session);
  session.prepare = async (req) => { counts.prepare++; return origPrepare(req); };
  const origExecute = session.execute.bind(session);
  session.execute = async (req) => { counts.execute++; return origExecute(req); };
  const origTool = globalThis.executeTool;
  globalThis.executeTool = (n, i, w, o) => { counts.tool++; counts.toolNames.push(n); return origTool(n, i, w, o); };
  return { counts, restore: () => { globalThis.executeTool = origTool; } };
}

function itemsOf(ui) {
  return ui.store.conversations.flatMap((c) => c.items.map((i) => ({ conv: c.id, kind: i.kind, code: i.code, text: String(i.content == null ? (i.message || '') : i.content) })));
}
const findConv = (ui, title) => ui.store.conversations.find((c) => c.title === title);

async function freshStore(tag) {
  return import(pathToFileURL(join(root, 'src', 'ui', 'store.js')).href + '?' + tag);
}

// =====================================================================
// I1 — normal complete chain
// =====================================================================
{
  const wire = createWire('i1');
  wires.set('i1', wire);
  configureModel(wire);
  const ui = await freshStore('joint-i1');
  const inst = await instrument(ui);
  applyJointSettings(ui);
  wire.push(wire.openai(null, [wire.toolCall('i1-call-1', 'echo m2c-joint > /tmp/joint-i1.txt && cat /tmp/joint-i1.txt')]));
  wire.push(wire.openai('Joint I1 final answer'));
  await ui.submit('joint I1: write and read back');
  const conv = findConv(ui, 'joint I1: write and read back');
  check('I1 the task completed through the real chain',
    conv && conv.status === 'completed' && ui.store.busy === false,
    JSON.stringify({ status: conv && conv.status, busy: ui.store.busy }));
  const i1Read = await ui.vfs.read('/tmp/joint-i1.txt').catch(() => null);
  check('I1 the real runtime shell wrote the real VFS file (visible through the page VFS)',
    typeof i1Read === 'string' && i1Read.includes('m2c-joint'),
    JSON.stringify({ read: String(i1Read).slice(0, 60) }));
  check('I1 exactly two model requests, the second carrying the real tool result',
    wire.calls.length === 2
      && JSON.stringify(wire.calls[1].body.messages).includes('m2c-joint')
      && JSON.stringify(wire.calls[1].body.messages).includes('i1-call-1'),
    JSON.stringify({ calls: wire.calls.length }));
  check('I1 the request tools are the REAL product registry serialized by the real adapter',
    Array.isArray(wire.calls[0].body.tools) && wire.calls[0].body.tools.length === 2
      && wire.calls[0].body.tools[0].type === 'function'
      && wire.calls[0].body.tools[0].function.name === 'bash',
    JSON.stringify(wire.calls[0].body.tools));
  check('I1 the final answer was projected and the executor ran exactly once',
    itemsOf(ui).some((i) => i.kind === 'assistant' && i.text.includes('Joint I1 final answer'))
      && inst.counts.tool === 1 && inst.counts.execute === 1 && inst.counts.prepare === 1,
    JSON.stringify(inst.counts));
  inst.restore();
}

// =====================================================================
// I2 — failure propagation
// =====================================================================
{
  const wire = createWire('i2');
  wires.set('i2', wire);
  configureModel(wire);
  const ui = await freshStore('joint-i2');
  const inst = await instrument(ui);
  applyJointSettings(ui);
  wire.push(wire.openai(null, [wire.toolCall('i2-call-1', 'cat /tmp/joint-i2-missing.txt')]));
  wire.push(wire.openai('Joint I2 saw the failure'));
  await ui.submit('joint I2: failing tool');
  const second = JSON.stringify(wire.calls[1].body.messages);
  check('I2 the real runtime failure reached the model as a FAILED tool result',
    wire.calls.length === 2 && /No such file|not found/i.test(second)
      && second.includes('i2-call-1'),
    second.slice(0, 300));
  check('I2 the product telemetry recorded success=false (never converted into success)',
    globalThis.Telemetry.records.length >= 1
      && globalThis.Telemetry.records.some((r) => r.tool === 'bash' && r.success === false),
    JSON.stringify(globalThis.Telemetry.records.slice(-2)));
  const conv = findConv(ui, 'joint I2: failing tool');
  check('I2 the task still terminated honestly (completed conversation, final answer)',
    conv && conv.status === 'completed'
      && itemsOf(ui).some((i) => i.kind === 'assistant' && i.text.includes('Joint I2 saw the failure')),
    JSON.stringify({ status: conv && conv.status }));
  inst.restore();
}

// =====================================================================
// I3 — cancellation and session boundary
// =====================================================================
{
  const wire = createWire('i3');
  wires.set('i3', wire);
  configureModel(wire);
  const ui = await freshStore('joint-i3');
  const inst = await instrument(ui);
  applyJointSettings(ui);
  wire.push({ __park: true }); // parked first request (abort-aware fake)
  const done3 = ui.submit('joint I3: parked then cancelled');
  await waitFor('I3 the parked request was dispatched', () => wire.calls.length === 1);
  ui.cancelTask();
  await done3;
  const conv3 = findConv(ui, 'joint I3: parked then cancelled');
  check('I3 a parked task cancelled through the REAL composer path',
    conv3 && conv3.status === 'cancelled' && ui.store.busy === false
      && itemsOf(ui).some((i) => i.kind === 'warning' && i.code === 'task_cancelled')
      && wire.calls.length === 1 && inst.counts.tool === 0 && inst.counts.execute === 0,
    JSON.stringify({ status: conv3 && conv3.status, calls: wire.calls.length, ...inst.counts }));

  // Session boundary while a tool already committed: the old task ends
  // session_changed, its committed file STAYS (no fake rollback), and the
  // successor is untouched. NOTE: cancelTask does NOT create a new
  // conversation — task A lands in the SAME conversation (its events must
  // still route there), so conversation references use ids, not titles.
  const convAId = ui.store.liveConversationId;
  const callsAfterCancel = wire.calls.length;
  wire.push(wire.openai(null, [wire.toolCall('i3-call-2', 'echo i3-boundary > /tmp/joint-i3.txt')]));
  wire.push({ __park: true }); // parked second request (abort-aware fake)
  const doneA = ui.submit('joint I3: boundary task A');
  await waitFor('I3 the boundary task dispatched its second request',
    () => wire.calls.length === callsAfterCancel + 2);
  await waitFor('I3 the boundary task committed its file', async () => {
    const t = await ui.vfs.read('/tmp/joint-i3.txt').catch(() => null);
    return typeof t === 'string' && t.includes('i3-boundary');
  });
  ui.newTask(); // the REAL session boundary (cancel + reset + new conversation)
  await doneA;
  const convA = ui.store.conversations.find((c) => c.id === convAId);
  const i3File = await ui.vfs.read('/tmp/joint-i3.txt').catch(() => null);
  check('I3 the boundary-struck task ended session_changed and its committed effect stayed',
    convA && convA.status === 'session_changed'
      && typeof i3File === 'string' && i3File.includes('i3-boundary'),
    JSON.stringify({ status: convA && convA.status }));

  // The successor runs cleanly in the NEW conversation on the same graph.
  const convBId = ui.store.liveConversationId;
  wire.push(wire.openai('Joint I3 successor answer'));
  await ui.submit('joint I3: successor');
  const convB = ui.store.conversations.find((c) => c.id === convBId);
  check('I3 the successor completed in a fresh conversation on the same graph',
    convB && convB.id !== convAId && convB.status === 'completed'
      && itemsOf(ui).some((i) => i.conv === convBId && i.text.includes('Joint I3 successor answer')),
    JSON.stringify({ status: convB && convB.status }));
  inst.restore();
}

// =====================================================================
// I4 — session isolation against a LATE old-task answer
// =====================================================================
{
  const wire = createWire('i4');
  wires.set('i4', wire);
  configureModel(wire);
  const ui = await freshStore('joint-i4');
  const inst = await instrument(ui);
  applyJointSettings(ui);
  // The old task commits a real VFS write, then parks on its SECOND model
  // request (abort-aware fake — a real in-flight transport).
  wire.push(wire.openai(null, [wire.toolCall('i4-call-1', 'echo i4-old > /tmp/joint-i4-old.txt')]));
  wire.push({ __park: true });
  const doneOld = ui.submit('joint I4: old task');
  await waitFor('I4 the old task dispatched its second request', () => wire.calls.length === 2);
  await waitFor('I4 the old task committed its file', async () => {
    const t = await ui.vfs.read('/tmp/joint-i4-old.txt').catch(() => null);
    return typeof t === 'string' && t.includes('i4-old');
  });
  const oldConv = findConv(ui, 'joint I4: old task');
  const oldConvId = oldConv.id;
  const oldTools = inst.counts.tool;
  ui.newTask(); // the session boundary invalidates the old loop
  const successorConvId = ui.store.liveConversationId;
  wire.push(wire.openai('Joint I4 successor answer'));
  await ui.submit('joint I4: successor');
  await doneOld;
  // After the boundary NO further tool dispatch may happen for the old
  // task — its parked continuation died with its controller; the successor
  // timeline holds only its own items.
  const succItems = itemsOf(ui).filter((i) => i.conv === successorConvId);
  check('I4 the boundary invalidated the old continuation: zero late tool dispatch',
    inst.counts.tool === oldTools,
    JSON.stringify({ tools: inst.counts.tool, old: oldTools }));
  check('I4 the successor timeline holds only its own items',
    succItems.every((i) => i.kind !== 'tool_call' || !String(i.text).includes('i4-old')),
    JSON.stringify(succItems.map((i) => i.kind + ':' + String(i.text).slice(0, 40))));
  check('I4 the old conversation kept exactly its own timeline',
    itemsOf(ui).filter((i) => i.conv === oldConvId).every((i) => !String(i.text).includes('Joint I4 successor'))
      && itemsOf(ui).some((i) => i.conv === oldConvId && i.code === 'session_changed'),
    JSON.stringify(itemsOf(ui).filter((i) => i.conv === oldConvId).map((i) => i.kind + ':' + i.code)));
  inst.restore();
}

// =====================================================================
// I5 — permission: real approval DENY, zero network dispatch
// =====================================================================
{
  const wire = createWire('i5');
  wires.set('i5', wire);
  configureModel(wire);
  const ui = await freshStore('joint-i5');
  const inst = await instrument(ui);
  applyJointSettings(ui);
  const fetchCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...a) => { fetchCalls.push(String(a[0])); return new Response('{}', { status: 200 }); };
  try {
    wire.push(wire.openai(null, [wire.toolCall('i5-call-1', 'curl -X POST -o /tmp/joint-i5.txt https://joint-i5.invalid/deny-probe')]));
    wire.push(wire.openai('Joint I5 acknowledged the denial'));
    const done5 = ui.submit('joint I5: denied network write');
    await waitFor('I5 the approval card is pending', () => !!ui.store.pendingApproval);
    check('I5 a real network-write approval was raised through the real adapter',
      ui.store.pendingApproval && ui.store.pendingApproval.kind === 'permission',
      JSON.stringify(ui.store.pendingApproval));
    check('I5 zero fetch dispatch happened while the approval was pending',
      fetchCalls.length === 0, JSON.stringify(fetchCalls));
    const denied = ui.resolveApproval(ui.store.pendingApproval.id, { outcome: 'deny', scope: 'once' });
    await done5;
    check('I5 the denial was applied through the real controller',
      denied === true && !ui.store.pendingApproval, JSON.stringify({ denied }));
    check('I5 zero real network dispatch for the denied request (deny reached the runtime port)',
      fetchCalls.length === 0, JSON.stringify(fetchCalls));
    check('I5 the task completed with the denial reported to the model',
      wire.calls.length === 2 && /denied|network_denied|denial|refused|not allowed|approval/i
        .test(JSON.stringify(wire.calls[1].body.messages)),
      JSON.stringify(wire.calls[1].body.messages).slice(0, 300));
  } finally {
    globalThis.fetch = realFetch;
  }
  inst.restore();
}

// =====================================================================
// I6 — compatibility negatives through the REAL product entry
// =====================================================================
// (a)–(d) each drives a REAL store graph: the runtime negatives patch the
// RETAINED host's capabilities() (a genuinely incompatible runtime
// declaration); the harness negative hosts a genuinely different-declaring
// harness table (tests-as-hosts rule). Rejections must surface through
// store.submit() — pure-checker rejections do not count.
{
  const wire = createWire('joint-i6a');
  wires.set('joint-i6a', wire);
  configureModel(wire);
  const ui = await freshStore('joint-i6a');
  const inst = await instrument(ui);
  applyJointSettings(ui);
  const host = ui.runtimeHost();
  const real = host.capabilities.bind(host);
  host.capabilities = () => ({ ...real(), contractVersion: 999 });
  const convId_joint_6a = ui.store.liveConversationId;
  await ui.submit('joint i6a: runtime version must be rejected');
  const conv = ui.store.conversations.find((c) => c.id === convId_joint_6a);
  const events = itemsOf(ui).filter((i) => i.conv === conv.id);
  check('I6.runtime-version rejected core_incompatible through the REAL entry',
    conv.status === 'interrupted' && events.some((i) => i.kind === 'error' && i.code === 'core_incompatible'
      && i.text.includes('999')),
    JSON.stringify(events.map((e) => e.kind + ':' + e.code + ':' + e.text.slice(0, 110))));
  check('I6.runtime-version zero model/prepare/execute/tool',
    wire.calls.length === 0 && inst.counts.prepare === 0 && inst.counts.execute === 0 && inst.counts.tool === 0,
    JSON.stringify({ calls: wire.calls.length, ...inst.counts }));
  host.capabilities = real;
  wire.push(wire.openai('joint i6a follow-up ok'));
  await ui.submit('joint i6a: legal follow-up');
  check('I6.runtime-version slot released, next legal task ran',
    ui.store.conversations.find((c) => c.id === convId_joint_6a).status === 'completed',
    JSON.stringify({ calls: wire.calls.length }));
  inst.restore();
  configureModel(null);
}

// (b) harness REGISTRY version: a fresh graph hosted on a genuinely
// different-declaring harness table (tests-as-hosts rule) — the REAL
// harnessCapabilities() then reports 999.
{
  const wire = createWire('joint-i6b');
  wires.set('joint-i6b', wire);
  configureModel(wire);
  const savedTable = globalThis.__LOCUS_HARNESS_CORE__;
  globalThis.__LOCUS_HARNESS_CORE__ = Object.freeze(
    Object.assign({}, savedTable, { contractVersion: 999 }));
  try {
    const ui = await freshStore('joint-i6b');
    const inst = await instrument(ui);
  applyJointSettings(ui);
    const convId_joint_6b = ui.store.liveConversationId;
  await ui.submit('joint i6b: harness registry version must be rejected');
    const conv = ui.store.conversations.find((c) => c.id === convId_joint_6b);
    const events = itemsOf(ui).filter((i) => i.conv === conv.id);
    check('I6.registry-version rejected (real harnessCapabilities reported the different generation)',
      conv.status === 'interrupted'
        && events.some((i) => i.kind === 'error' && i.code === 'core_incompatible'
          && i.text.includes('999') && i.text.includes('harness')),
      JSON.stringify(events.map((e) => e.kind + ':' + e.code + ':' + e.text.slice(0, 110))));
    check('I6.registry-version zero model/prepare/execute/tool',
      wire.calls.length === 0 && inst.counts.prepare === 0 && inst.counts.execute === 0 && inst.counts.tool === 0,
      JSON.stringify({ calls: wire.calls.length, ...inst.counts }));
    inst.restore();
  } finally {
    globalThis.__LOCUS_HARNESS_CORE__ = savedTable;
    configureModel(null);
  }
}

// (c) required policy capability: the runtime no longer declares the
// authorization mechanism.
{
  const wire = createWire('joint-i6c');
  wires.set('joint-i6c', wire);
  configureModel(wire);
  const ui = await freshStore('joint-i6c');
  const inst = await instrument(ui);
  applyJointSettings(ui);
  const host = ui.runtimeHost();
  const real = host.capabilities.bind(host);
  host.capabilities = () => {
    const d = real();
    return { ...d, policyMechanisms: d.policyMechanisms.filter((m) => m !== 'authorization') };
  };
  const convId_joint_6c = ui.store.liveConversationId;
  await ui.submit('joint i6c: missing authorization capability must be rejected');
  const conv = ui.store.conversations.find((c) => c.id === convId_joint_6c);
  const events = itemsOf(ui).filter((i) => i.conv === conv.id);
  check('I6.policy-capability rejected (authorization is authority, not a convenience)',
    conv.status === 'interrupted'
      && events.some((i) => i.kind === 'error' && i.code === 'core_incompatible'
        && i.text.includes('authorization')),
    JSON.stringify(events.map((e) => e.kind + ':' + e.code + ':' + e.text.slice(0, 110))));
  check('I6.policy-capability zero model/prepare/execute/tool',
    wire.calls.length === 0 && inst.counts.prepare === 0 && inst.counts.execute === 0 && inst.counts.tool === 0,
    JSON.stringify({ calls: wire.calls.length, ...inst.counts }));
  host.capabilities = real;
  wire.push(wire.openai('joint i6c follow-up ok'));
  await ui.submit('joint i6c: legal follow-up');
  check('I6.policy-capability slot released, next legal task ran',
    ui.store.conversations.find((c) => c.id === convId_joint_6c).status === 'completed',
    JSON.stringify({ calls: wire.calls.length }));
  inst.restore();
  configureModel(null);
}

// (d) hostile declaration SHAPE: the retained host reports garbage.
{
  const wire = createWire('joint-i6d');
  wires.set('joint-i6d', wire);
  configureModel(wire);
  const ui = await freshStore('joint-i6d');
  const inst = await instrument(ui);
  applyJointSettings(ui);
  const host = ui.runtimeHost();
  const real = host.capabilities.bind(host);
  host.capabilities = () => ({
    contractVersion: 'one',
    executionKinds: 'shell',
    bootstrap: { shaPinned: 'yes' },
    policyMechanisms: 'mutationPolicy',
    commands: 'echo',
  });
  const convId_joint_6d = ui.store.liveConversationId;
  await ui.submit('joint i6d: hostile declaration shape must be rejected');
  const conv = ui.store.conversations.find((c) => c.id === convId_joint_6d);
  const events = itemsOf(ui).filter((i) => i.conv === conv.id);
  check('I6.declaration-shape rejected as declaration_invalid/contract_version_unsupported',
    conv.status === 'interrupted'
      && events.some((i) => i.kind === 'error' && i.code === 'core_incompatible'),
    JSON.stringify(events.map((e) => e.kind + ':' + e.code + ':' + e.text.slice(0, 130))));
  check('I6.declaration-shape zero model/prepare/execute/tool',
    wire.calls.length === 0 && inst.counts.prepare === 0 && inst.counts.execute === 0 && inst.counts.tool === 0,
    JSON.stringify({ calls: wire.calls.length, ...inst.counts }));
  host.capabilities = real;
  wire.push(wire.openai('joint i6d follow-up ok'));
  await ui.submit('joint i6d: legal follow-up');
  check('I6.declaration-shape slot released, next legal task ran',
    ui.store.conversations.find((c) => c.id === convId_joint_6d).status === 'completed',
    JSON.stringify({ calls: wire.calls.length }));
  inst.restore();
  configureModel(null);
}

// =====================================================================
// I7 — replay + required persistence (in-memory store, REAL validators)
// =====================================================================
function createMemoryPersistence() {
  const conversations = new Map();
  const providerSessions = new Map();
  const sessionsByConv = new Map();
  const frames = new Map();
  const normalized = new Map();
  let frameWriteFail = null; // optional injected required-write fault
  const stub = {
    ready: Promise.resolve(),
    async saveSettings() {},
    async loadSettings() { return {}; },
    async loadRememberedApiKey() { return null; },
    async setRememberedApiKey() {},
    async ensureHomeSkeleton() { throw new Error('memory-only home'); },
    async opfsDirectory() { throw new Error('memory-only home'); },
    async requestPersistentStorage() { return false; },
    async saveConversation(row) { conversations.set(row.id, JSON.parse(JSON.stringify(row))); },
    async loadConversations() { return [...conversations.values()]; },
    async appendPresentationEvent(convId, seq, event) { /* recorded implicitly via conversations */ },
    async notePersistenceError() {},
    async get(name, key) {
      return name === 'providerSessions' ? (providerSessions.get(key) || null) : null;
    },
    async loadProviderSession(convId) {
      const sid = sessionsByConv.get(convId);
      return sid ? (providerSessions.get(sid) || null) : null;
    },
    async saveProviderSession(row) {
      providerSessions.set(row.id, row);
      if (!sessionsByConv.has(row.conversationId)) sessionsByConv.set(row.conversationId, row.id);
    },
    async appendProviderFrame(frame) {
      if (frameWriteFail && frameWriteFail(frame)) throw new Error('simulated durable write failure');
      const list = frames.get(frame.sessionId) || [];
      const row = Object.assign({}, frame, { id: frame.sessionId + ':' + frame.sequence });
      list.push(row);
      frames.set(frame.sessionId, list);
      return row;
    },
    async loadProviderFrames(sessionId) {
      return [...(frames.get(sessionId) || [])].sort((a, b) => a.sequence - b.sequence);
    },
    async saveNormalizedMessage(row) {
      const list = normalized.get(row.conversationId) || [];
      list.push(Object.assign({}, row));
      normalized.set(row.conversationId, list);
      return row;
    },
    async loadNormalizedMessages(convId) {
      return [...(normalized.get(convId) || [])].sort((a, b) => a.sequence - b.sequence);
    },
    async loadWorkspaceHandle() { return null; },
    async storageStatus() { return { mode: 'memory', dbName: 'locus' }; },
    _conversations: conversations, _providerSessions: providerSessions,
    _sessionsByConv: sessionsByConv, _frames: frames, _normalized: normalized,
    _failFrameWrites: (pred) => { frameWriteFail = pred; },
  };
  return stub;
}

{
  const wire = createWire('joint-i7');
  wires.set('joint-i7', wire);
  configureModel(wire);
  const persist = createMemoryPersistence();
  globalThis.PersistenceServiceInstance = persist;
  try {
    const ui = await freshStore('joint-i7');
    const inst = await instrument(ui);
  applyJointSettings(ui);
    wire.push(wire.openai(null, [wire.toolCall('i7-call-1', 'echo i7-replay > /tmp/joint-i7.txt')]));
    wire.push(wire.openai('Joint I7 first task done'));
    await ui.submit('joint I7: persisted tool task');
    const conv = findConv(ui, 'joint I7: persisted tool task');
    check('I7 the persisted tool task completed with frames + checkpoints on disk',
      conv && conv.status === 'completed' && conv.activeProviderSessionId
        && (persist._frames.get(conv.activeProviderSessionId) || []).length >= 4,
      JSON.stringify({ status: conv && conv.status, frames: persist._frames.get(conv && conv.activeProviderSessionId || '')?.length }));
    const sessionId = conv.activeProviderSessionId;
    const sessionRow = persist._providerSessions.get(sessionId);
    check('I7 the provider session checkpoint advanced past the user frame',
      sessionRow && sessionRow.replayCheckpointSequence >= 2,
      JSON.stringify({ checkpoint: sessionRow && sessionRow.replayCheckpointSequence }));

    // Legal restore: reopen the archived conversation and continue — the
    // REAL validators replay the prefix; the tool does NOT run again.
    ui.newTask();
    ui.openConversation(conv.id);
    const toolRunsBefore = inst.counts.tool;
    wire.push(wire.openai('Joint I7 continuation after replay'));
    await ui.submit('joint I7: continue after replay');
    const replayCall = wire.calls[wire.calls.length - 1];
    const replayBody = JSON.stringify(replayCall.body.messages);
    check('I7 legal restore replayed the provider-native history into the next request',
      replayBody.includes('i7-call-1') && replayBody.includes('i7-replay'),
      replayBody.slice(0, 260));
    check('I7 the replayed history did NOT re-execute the tool',
      inst.counts.tool === toolRunsBefore + 0,
      JSON.stringify({ toolRuns: inst.counts.tool, before: toolRunsBefore }));

    // Corrupted checkpoint: durable metadata lies beyond the real tail.
    const corruptRow = persist._providerSessions.get(sessionId);
    corruptRow.replayCheckpointSequence = 999;
    ui.newTask();
    ui.openConversation(conv.id);
    const callsBeforeCorrupt = wire.calls.length;
    const toolsBeforeCorrupt = inst.counts.tool;
    const doneCorrupt = ui.submit('joint I7: corrupt checkpoint submit');
    await doneCorrupt;
    // The corrupted conversation takes the EXISTING silent-rejection path:
    // restoreInto marks it raw_invalid/degraded and prepareTask rejects
    // with zero lifecycle events — nothing may attach to a conversation
    // whose durable checkpoint is invalid.
    const corruptEvents = itemsOf(ui).filter((i) => i.conv === conv.id);
    check('I7 a corrupted checkpoint blocks replay: raw_invalid, zero model requests, zero tool re-run',
      conv.replayState === 'raw_invalid' && wire.calls.length === callsBeforeCorrupt
        && inst.counts.tool === toolsBeforeCorrupt
        && corruptEvents.every((i) => i.kind !== 'error'),
      JSON.stringify({ replayState: conv.replayState, calls: wire.calls.length - callsBeforeCorrupt,
        tools: inst.counts.tool, before: toolsBeforeCorrupt, events: corruptEvents.map((e) => e.kind + ':' + e.code) }));
    check('I7 the corrupted conversation was degraded and the task ended interrupted',
      conv.persistenceState === 'degraded' && conv.status === 'interrupted',
      JSON.stringify({ persistenceState: conv.persistenceState, status: conv.status }));
  } finally {
    delete globalThis.PersistenceServiceInstance;
    configureModel(null);
  }
}

// I7b — uncheckpointed suffix (fresh conversation, honest durable tail)
{
  const wire = createWire('joint-i7b');
  wires.set('joint-i7b', wire);
  configureModel(wire);
  const persist = createMemoryPersistence();
  globalThis.PersistenceServiceInstance = persist;
  try {
    const ui = await freshStore('joint-i7b');
    const inst = await instrument(ui);
  applyJointSettings(ui);
    wire.push(wire.openai(null, [wire.toolCall('i7b-call-1', 'echo i7b > /tmp/joint-i7b.txt')]));
    wire.push(wire.openai('Joint I7b first done'));
    await ui.submit('joint I7b: seeded task');
    const conv = findConv(ui, 'joint I7b: seeded task');
    const sessionId = conv.activeProviderSessionId;
    // Simulate the crash window: the tool_result frame was archived but the
    // checkpoint write never advanced (durable suffix beyond checkpoint).
    const tail = {
      id: sessionId + ':suffix', sessionId, conversationId: conv.id,
      sequence: sessionCheckpointOf(persist, sessionId) + 1,
      turnId: sessionId, direction: 'inbound', role: 'assistant', kind: 'tool_result',
      raw: { role: 'tool', tool_call_id: 'i7b-call-1', content: 'i7b' }, toolCallId: 'i7b-call-1',
    };
    persist._frames.get(sessionId).push(tail);
    ui.newTask();
    ui.openConversation(conv.id);
    const callsBefore = wire.calls.length;
    const toolsBefore = inst.counts.tool;
    await ui.submit('joint I7b: suffix must not replay');
    check('I7b an uncheckpointed suffix rejects replay: zero model requests, zero tool re-run',
      wire.calls.length === callsBefore && inst.counts.tool === toolsBefore
        && (conv.replayState === 'raw_invalid' || conv.replayState === 'blocked'
            || conv.persistenceState === 'degraded'),
      JSON.stringify({ replayState: conv.replayState, newCalls: wire.calls.length - callsBefore }));
    check('I7b the suffix conversation was not silently continued',
      conv.status === 'interrupted',
      JSON.stringify({ status: conv.status }));
    inst.restore();
  } finally {
    delete globalThis.PersistenceServiceInstance;
    configureModel(null);
  }
}

function sessionCheckpointOf(persist, sessionId) {
  for (const row of persist._providerSessions.values()) {
    if (row.id === sessionId) return row.replayCheckpointSequence || 0;
  }
  return 0;
}

// I7c — a REQUIRED write failure keeps persistence_error, zero further model
// requests (the run path stops at the failed necessary write).
{
  const wire = createWire('joint-i7c');
  wires.set('joint-i7c', wire);
  configureModel(wire);
  const persist = createMemoryPersistence();
  globalThis.PersistenceServiceInstance = persist;
  try {
    const ui = await freshStore('joint-i7c');
    const inst = await instrument(ui);
  applyJointSettings(ui);
    persist._failFrameWrites((frame) => frame.kind === 'tool_result');
    wire.push(wire.openai(null, [wire.toolCall('i7c-call-1', 'echo i7c > /tmp/joint-i7c.txt')]));
    wire.push(wire.openai('MUST NOT BE REQUESTED'));
    await ui.submit('joint I7c: required write failure');
    const conv = findConv(ui, 'joint I7c: required write failure');
    check('I7c the required-write failure stayed persistence_error and degraded the conversation',
      conv && conv.status === 'persistence_error' && conv.persistenceState === 'degraded'
        && conv.runState === 'interrupted',
      JSON.stringify({ status: conv && conv.status, ps: conv && conv.persistenceState }));
    check('I7c exactly one model request happened; the tool ran once; nothing followed',
      wire.calls.length === 1 && inst.counts.tool === 1,
      JSON.stringify({ calls: wire.calls.length, tools: inst.counts.tool }));
    inst.restore();
  } finally {
    delete globalThis.PersistenceServiceInstance;
    configureModel(null);
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
