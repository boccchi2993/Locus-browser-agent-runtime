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
//       protocol version, harness REGISTRY version, harness PUBLIC PORT
//       version, required policy capability, hostile declaration shape →
//       core_incompatible, zero model requests / zero required writes /
//       zero prepare+execute / zero tool dispatch, slot released, next
//       legal task runs
//   I7  replay + required persistence over an in-memory store with the
//       REAL harness replay validators: legal history replays without
//       tool re-execution; corrupted checkpoint and uncheckpointed suffix
//       reject replay (zero model, zero tool); required-write failure
//       stays persistence_error with zero further model requests
//   OPT optional-capability decisions (review F1): the per-task frozen
//       compatibility decision is CONSUMED on the task path —
//       OPT-A imageInputGate missing → text-only with zero ingest/probe,
//       upload kept; same stores, next task with the real declaration
//       sends the image (per-task re-check)
//       OPT-B/C capabilityComposition missing → zero capability work,
//       task completes; with user-enabled capabilities → explicit
//       rejection before any side effect
//       OPT-D a declaration change mid-task cannot rebind the adopted
//       decision; the next task re-checks
//       OPT-E nativeToolCalls missing → the strict text-fallback
//       protocol completes a real fenced-JSON tool round trip
//       OPT-F runtime executionKinds without python → shell-only chain
//       completes (the declared optional rule)
//   I8  execution-phase lifecycle (review F2): the real chain parked
//       INSIDE a VFS provider write — cancel/reset while the dispatched
//       operation is unsettled cannot end the task (slot stays occupied);
//       release settles the effect honestly (kept, never rolled back,
//       never a fake success), zero further dispatch; reset stays
//       reusable; dispose refuses new executions before side effects
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
// Review F2 fix: an async condFn's Promise is AWAITED, never treated as an
// immediate truthy value — a false async condition holds the barrier until
// it turns true (or the failure-bound timeout fires). Sync conditions keep
// working unchanged (await on a non-Promise value is a no-op).
async function waitFor(desc, condFn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try { ok = !!(await condFn()); } catch (e) { ok = false; }
    if (ok) return true;
    if (Date.now() > deadline) throw new Error('waitFor timeout: ' + desc);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Review F2: a targeted proof OF THE BARRIER ITSELF — under the old
// implementation (`ok = !!condFn()`) both checks below would pass/fail
// wrongly: a pending Promise is truthy, so the first wait would return
// before its condition ever held, and a never-true async condition would
// pass instantly instead of hitting the failure bound.
{
  let polls = 0;
  await waitFor('self-test: an async condition starting false is awaited',
    async () => { polls++; return polls >= 3; }, 2000);
  check('waitFor awaits async conditions (a false Promise is never treated as truthy)',
    polls >= 3, JSON.stringify({ polls }));
  let timedOut = false;
  let neverTruePolls = 0;
  await waitFor('self-test: a never-true async condition runs to the failure bound',
    async () => { neverTruePolls++; return false; }, 80).catch(() => { timedOut = true; });
  check('waitFor timeout is only the failure bound for async conditions',
    timedOut === true && neverTruePolls >= 2, JSON.stringify({ timedOut, neverTruePolls }));
}

// The Product hooks seam is read through `window`; joint graphs run in
// Node, so host the same global here. Blocks that inject a seam MUST
// delete globalThis.__LOCUS_HOOKS__ in their finally.
globalThis.window = globalThis;

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
// Review F1 (OPT-A): the REAL AttachmentStore (the Product image storage
// implementation) so the missing-imageInputGate test proves the DECISION
// path with a live store — never the "store unavailable" fallback.
const attGlobals = (0, eval)(readSrc('src', 'attachments.js')
  + '\n;[AttachmentStore, resolveImageMime]');
globalThis.AttachmentStore = attGlobals[0];

// Review F1: a genuinely different-declaring HARNESS generation, hosted
// through the store's narrow declaration seam (hooks.harnessCapabilities —
// the production default is the REAL public entry; the seam substitutes
// the DECLARATION only, and the SAME compatibility check runs — there is
// no skip mode). The variant derives from the real declaration so only the
// patched capability differs.
function harnessDeclarationVariant(patch) {
  const base = JSON.parse(JSON.stringify(harnessEntry.harnessCapabilities()));
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) delete base.capabilities[k];
    else base.capabilities[k] = v;
  }
  return Object.freeze(base);
}

// ---------- the scripted provider transport (the ONLY fake) ----------
function createWire(name) {
  const calls = [];
  const queue = [];
  // Review F2 (I4): manually-released parks — a response held by the test
  // and delivered to the chain LATER, ignoring abort. This is what makes a
  // late-delivery isolation proof real: an abort-aware park merely rejects,
  // so nothing is ever actually delivered late.
  const manualParks = new Set();
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
    // { parkManual: true } -> the response is held in the test's hands and
    // NEVER rejects; releaseParked() delivers it whenever the test decides
    // — even after a boundary and a successor were established.
    if (next && next.__parkManual) {
      return new Promise((resolve) => { manualParks.add(resolve); });
    }
    if (typeof next === 'function') return next(record, respond);
    return respond(next);
  };
  return {
    calls, transport,
    push: (r) => queue.push(r),
    manualParksPending: () => manualParks.size,
    releaseParked: (obj) => {
      const rs = [...manualParks];
      manualParks.clear();
      for (const r of rs) r(respond(obj));
      return rs.length;
    },
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

// Review F1: counters wrapped ONTO the real CapabilityManager + the real
// product task-mount adapter of one store graph — the disable path must
// make ZERO capability work (refresh / environment build / plugin payload
// / task mounts), not merely survive it.
function instrumentCapabilities(ui) {
  const counts = { refresh: 0, build: 0, payload: 0, mounts: 0 };
  const cm = ui.capabilityManager;
  if (!cm) return { counts, restore: () => {} };
  const oRefresh = cm.refreshSkillPresence.bind(cm);
  cm.refreshSkillPresence = async (...a) => { counts.refresh++; return oRefresh(...a); };
  const oBuild = cm.buildTaskEnvironment.bind(cm);
  cm.buildTaskEnvironment = (...a) => { counts.build++; return oBuild(...a); };
  const oPayload = cm.pythonExtensionPayload.bind(cm);
  cm.pythonExtensionPayload = (...a) => { counts.payload++; return oPayload(...a); };
  const oMounts = globalThis.productTaskVfsMounts;
  globalThis.productTaskVfsMounts = (...a) => { counts.mounts++; return oMounts(...a); };
  return {
    counts,
    restore: () => {
      cm.refreshSkillPresence = oRefresh;
      cm.buildTaskEnvironment = oBuild;
      cm.pythonExtensionPayload = oPayload;
      globalThis.productTaskVfsMounts = oMounts;
    },
  };
}

// Review F1 (OPT-A): counters wrapped ONTO the real AttachmentStore so a
// zero-ingest result is directly observed (never inferred).
function instrumentAttachmentIngest(ui) {
  const s = ui.getAttachmentStore();
  if (!s) return { counts: { ingest: 0 }, restore: () => {} };
  const counts = { ingest: 0 };
  const orig = s.ingestImage.bind(s);
  s.ingestImage = async (...a) => { counts.ingest++; return orig(...a); };
  return { counts, restore: () => { s.ingestImage = orig; } };
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
// I4 — session isolation against a LATE old-task answer (review F2:
// an ACTUAL late delivery, not an aborted park)
// =====================================================================
// The old task parks on its second model request with a MANUAL park — the
// response is held in the test's hands and never rejects, so the old run
// body stays genuinely in flight. The boundary strikes anyway (newTask):
// the successor conversation + session generation are established, the old
// slot is still honestly occupied. Only THEN is the old response released
// — with a NEW tool call inside — and the successor is admitted after the
// old task fully settled. (One-active-task admission means a still-open
// old run delays the successor's ADMISSION; the successor's conversation
// and session boundary precede the release, and every successor
// event/file/session write happens after the late delivery was discarded.)
{
  const wire = createWire('i4');
  wires.set('i4', wire);
  configureModel(wire);
  const ui = await freshStore('joint-i4');
  const inst = await instrument(ui);
  applyJointSettings(ui);
  // The old task commits a real VFS write, then parks on its SECOND model
  // request — a MANUAL park: nothing rejects, nothing settles.
  wire.push(wire.openai(null, [wire.toolCall('i4-call-1', 'echo i4-old > /tmp/joint-i4-old.txt')]));
  wire.push({ __parkManual: true });
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
  check('I4 the boundary established the successor while the old run was still parked',
    successorConvId !== oldConvId && ui.store.busy === true && wire.manualParksPending() === 1,
    JSON.stringify({ succ: successorConvId !== oldConvId, busy: ui.store.busy, parks: wire.manualParksPending() }));

  // THE ACTUAL LATE DELIVERY: a real response — carrying a NEW tool call —
  // released to the already-boundaried session.
  const released = wire.releaseParked(wire.openai(null, [
    wire.toolCall('i4-call-late', 'echo i4-late > /tmp/joint-i4-late.txt'),
  ]));
  await doneOld;
  const lateFile = await ui.vfs.read('/tmp/joint-i4-late.txt').catch(() => null);
  check('I4 the late response was actually delivered (released to the old session)',
    released === 1, JSON.stringify({ released }));
  check('I4 the boundary invalidated the old continuation: the late tool call never dispatched, no late file',
    inst.counts.tool === oldTools && lateFile === null,
    JSON.stringify({ tools: inst.counts.tool, old: oldTools, lateFile: String(lateFile).slice(0, 40) }));
  check('I4 the old task still ended honestly (session_changed) after absorbing the late delivery',
    ui.store.conversations.find((c) => c.id === oldConvId).status === 'session_changed',
    JSON.stringify({ status: ui.store.conversations.find((c) => c.id === oldConvId).status }));

  // The successor runs AFTER the old task settled with the late delivery —
  // its events, files and session must be unpolluted.
  wire.push(wire.openai('Joint I4 successor answer'));
  await ui.submit('joint I4: successor');
  const succConv = ui.store.conversations.find((c) => c.id === successorConvId);
  const succItems = itemsOf(ui).filter((i) => i.conv === successorConvId);
  const succCall = wire.calls[wire.calls.length - 1];
  const succBody = JSON.stringify(succCall.body.messages);
  check('I4 the successor completed in a fresh conversation on the same graph',
    succConv && succConv.status === 'completed'
      && itemsOf(ui).some((i) => i.conv === successorConvId && i.text.includes('Joint I4 successor answer')),
    JSON.stringify({ status: succConv && succConv.status }));
  check('I4 the successor timeline holds only its own items (no old/late leakage)',
    succItems.every((i) => !String(i.text).includes('i4-old') && !String(i.text).includes('i4-late')),
    JSON.stringify(succItems.map((i) => i.kind + ':' + String(i.text).slice(0, 40))));
  check('I4 the successor provider request carries no old-task content',
    !succBody.includes('i4-old') && !succBody.includes('i4-late'),
    succBody.slice(0, 200));
  check('I4 the old conversation kept exactly its own timeline',
    itemsOf(ui).filter((i) => i.conv === oldConvId).every((i) => !String(i.text).includes('Joint I4 successor'))
      && itemsOf(ui).some((i) => i.conv === oldConvId && i.code === 'session_changed'),
    JSON.stringify(itemsOf(ui).filter((i) => i.conv === oldConvId).map((i) => i.kind + ':' + i.code)));
  inst.restore();
  configureModel(null);
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
// (a)–(e) each drives a REAL store graph over an in-memory persistence
// stub: the runtime negatives patch the RETAINED host's capabilities()
// (a genuinely incompatible runtime declaration); the harness negatives
// host a genuinely different-declaring harness — (b) via the declared
// core table (tests-as-hosts), (e) via the store's narrow declaration
// seam (the production path runs the SAME check; no skip mode exists).
// Rejections must surface through store.submit() — pure-checker
// rejections do not count. Review F2: every negative additionally
// asserts a ZERO delta of REQUIRED persistence writes around the submit
// (the error projection's optional saves are allowed — normal app
// behavior), exactly one error event, and a releasable slot.
function requiredWriteDelta(persist, before) {
  const c = persist._counts;
  return {
    requiredConversation: c.requiredConversation - before.requiredConversation,
    providerSession: c.providerSession - before.providerSession,
    frame: c.frame - before.frame,
    normalized: c.normalized - before.normalized,
  };
}
const requiredWritesAreZero = (d) => d.requiredConversation === 0 && d.providerSession === 0
  && d.frame === 0 && d.normalized === 0;

{
  const wire = createWire('joint-i6a');
  wires.set('joint-i6a', wire);
  configureModel(wire);
  const persist = createMemoryPersistence();
  globalThis.PersistenceServiceInstance = persist;
  try {
    const ui = await freshStore('joint-i6a');
    const inst = await instrument(ui);
    applyJointSettings(ui);
    const host = ui.runtimeHost();
    const real = host.capabilities.bind(host);
    host.capabilities = () => ({ ...real(), contractVersion: 999 });
    const convId_joint_6a = ui.store.liveConversationId;
    const w0 = { ...persist._counts };
    await ui.submit('joint i6a: runtime version must be rejected');
    const conv = ui.store.conversations.find((c) => c.id === convId_joint_6a);
    const events = itemsOf(ui).filter((i) => i.conv === conv.id);
    const wd = requiredWriteDelta(persist, w0);
    check('I6.runtime-version rejected core_incompatible through the REAL entry',
      conv.status === 'interrupted' && events.some((i) => i.kind === 'error' && i.code === 'core_incompatible'
        && i.text.includes('999')),
      JSON.stringify(events.map((e) => e.kind + ':' + e.code + ':' + e.text.slice(0, 110))));
    check('I6.runtime-version exactly ONE error event (a single honest termination)',
      events.filter((i) => i.kind === 'error').length === 1,
      JSON.stringify(events.map((e) => e.kind + ':' + e.code)));
    check('I6.runtime-version zero model/prepare/execute/tool',
      wire.calls.length === 0 && inst.counts.prepare === 0 && inst.counts.execute === 0 && inst.counts.tool === 0,
      JSON.stringify({ calls: wire.calls.length, ...inst.counts }));
    check('I6.runtime-version zero REQUIRED persistence writes',
      requiredWritesAreZero(wd), JSON.stringify(wd));
    host.capabilities = real;
    wire.push(wire.openai('joint i6a follow-up ok'));
    await ui.submit('joint i6a: legal follow-up');
    check('I6.runtime-version slot released, next legal task ran',
      ui.store.conversations.find((c) => c.id === convId_joint_6a).status === 'completed',
      JSON.stringify({ calls: wire.calls.length }));
    inst.restore();
  } finally {
    delete globalThis.PersistenceServiceInstance;
    configureModel(null);
  }
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
  const persist = createMemoryPersistence();
  globalThis.PersistenceServiceInstance = persist;
  try {
    const ui = await freshStore('joint-i6b');
    const inst = await instrument(ui);
    applyJointSettings(ui);
    const convId_joint_6b = ui.store.liveConversationId;
    const w0 = { ...persist._counts };
    await ui.submit('joint i6b: harness registry version must be rejected');
    const conv = ui.store.conversations.find((c) => c.id === convId_joint_6b);
    const events = itemsOf(ui).filter((i) => i.conv === conv.id);
    const wd = requiredWriteDelta(persist, w0);
    check('I6.registry-version rejected (real harnessCapabilities reported the different generation)',
      conv.status === 'interrupted'
        && events.some((i) => i.kind === 'error' && i.code === 'core_incompatible'
          && i.text.includes('999') && i.text.includes('harness')),
      JSON.stringify(events.map((e) => e.kind + ':' + e.code + ':' + e.text.slice(0, 110))));
    check('I6.registry-version zero model/prepare/execute/tool',
      wire.calls.length === 0 && inst.counts.prepare === 0 && inst.counts.execute === 0 && inst.counts.tool === 0,
      JSON.stringify({ calls: wire.calls.length, ...inst.counts }));
    check('I6.registry-version zero REQUIRED persistence writes',
      requiredWritesAreZero(wd), JSON.stringify(wd));
    inst.restore();
  } finally {
    globalThis.__LOCUS_HARNESS_CORE__ = savedTable;
    delete globalThis.PersistenceServiceInstance;
    configureModel(null);
  }
}

// (b2) review F2: the harness PUBLIC PORT version negative — the internal
// registryVersion mismatch never substitutes for it. A genuinely
// different-declaring harness generation moved the taskLifecycle PORT to
// version 2, hosted through the narrow declaration seam; the production
// entry runs the SAME check and rejects with port_version_unsupported.
{
  const wire = createWire('joint-i6b2');
  wires.set('joint-i6b2', wire);
  configureModel(wire);
  const persist = createMemoryPersistence();
  globalThis.PersistenceServiceInstance = persist;
  try {
    const ui = await freshStore('joint-i6b2');
    const inst = await instrument(ui);
    applyJointSettings(ui);
    globalThis.__LOCUS_HOOKS__ = {
      harnessCapabilities: () => {
        const d = JSON.parse(JSON.stringify(harnessEntry.harnessCapabilities()));
        d.ports.taskLifecycle.version = 2;
        return Object.freeze(d);
      },
    };
    const convId = ui.store.liveConversationId;
    const w0 = { ...persist._counts };
    await ui.submit('joint i6b2: harness port version must be rejected');
    const conv = ui.store.conversations.find((c) => c.id === convId);
    const events = itemsOf(ui).filter((i) => i.conv === conv.id);
    const wd = requiredWriteDelta(persist, w0);
    check('I6.port-version rejected on the PUBLIC port.version (not the internal registry)',
      conv.status === 'interrupted'
        && events.some((i) => i.kind === 'error' && i.code === 'core_incompatible'
          && String(i.text).includes('taskLifecycle') && String(i.text).includes('2')),
      JSON.stringify(events.map((e) => e.kind + ':' + e.code + ':' + e.text.slice(0, 160))));
    check('I6.port-version zero model/prepare/execute/tool',
      wire.calls.length === 0 && inst.counts.prepare === 0 && inst.counts.execute === 0 && inst.counts.tool === 0,
      JSON.stringify({ calls: wire.calls.length, ...inst.counts }));
    check('I6.port-version zero REQUIRED persistence writes',
      requiredWritesAreZero(wd), JSON.stringify(wd));
    // Slot released; the SAME graph, back on the REAL declaration, runs.
    delete globalThis.__LOCUS_HOOKS__;
    wire.push(wire.openai('joint i6b2 follow-up ok'));
    await ui.submit('joint i6b2: legal follow-up');
    check('I6.port-version slot released, next legal task ran',
      conv.status === 'completed',
      JSON.stringify({ status: conv.status }));
    inst.restore();
  } finally {
    delete globalThis.__LOCUS_HOOKS__;
    delete globalThis.PersistenceServiceInstance;
    configureModel(null);
  }
}

// (c) required policy capability: the runtime no longer declares the
// authorization mechanism.
{
  const wire = createWire('joint-i6c');
  wires.set('joint-i6c', wire);
  configureModel(wire);
  const persist = createMemoryPersistence();
  globalThis.PersistenceServiceInstance = persist;
  try {
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
    const w0 = { ...persist._counts };
    await ui.submit('joint i6c: missing authorization capability must be rejected');
    const conv = ui.store.conversations.find((c) => c.id === convId_joint_6c);
    const events = itemsOf(ui).filter((i) => i.conv === conv.id);
    const wd = requiredWriteDelta(persist, w0);
    check('I6.policy-capability rejected (authorization is authority, not a convenience)',
      conv.status === 'interrupted'
        && events.some((i) => i.kind === 'error' && i.code === 'core_incompatible'
          && i.text.includes('authorization')),
      JSON.stringify(events.map((e) => e.kind + ':' + e.code + ':' + e.text.slice(0, 110))));
    check('I6.policy-capability zero model/prepare/execute/tool',
      wire.calls.length === 0 && inst.counts.prepare === 0 && inst.counts.execute === 0 && inst.counts.tool === 0,
      JSON.stringify({ calls: wire.calls.length, ...inst.counts }));
    check('I6.policy-capability zero REQUIRED persistence writes',
      requiredWritesAreZero(wd), JSON.stringify(wd));
    host.capabilities = real;
    wire.push(wire.openai('joint i6c follow-up ok'));
    await ui.submit('joint i6c: legal follow-up');
    check('I6.policy-capability slot released, next legal task ran',
      ui.store.conversations.find((c) => c.id === convId_joint_6c).status === 'completed',
      JSON.stringify({ calls: wire.calls.length }));
    inst.restore();
  } finally {
    delete globalThis.PersistenceServiceInstance;
    configureModel(null);
  }
}

// (d) hostile declaration SHAPE: the retained host reports garbage.
{
  const wire = createWire('joint-i6d');
  wires.set('joint-i6d', wire);
  configureModel(wire);
  const persist = createMemoryPersistence();
  globalThis.PersistenceServiceInstance = persist;
  try {
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
    const w0 = { ...persist._counts };
    await ui.submit('joint i6d: hostile declaration shape must be rejected');
    const conv = ui.store.conversations.find((c) => c.id === convId_joint_6d);
    const events = itemsOf(ui).filter((i) => i.conv === conv.id);
    const wd = requiredWriteDelta(persist, w0);
    check('I6.declaration-shape rejected as declaration_invalid/contract_version_unsupported',
      conv.status === 'interrupted'
        && events.some((i) => i.kind === 'error' && i.code === 'core_incompatible'),
      JSON.stringify(events.map((e) => e.kind + ':' + e.code + ':' + e.text.slice(0, 130))));
    check('I6.declaration-shape zero model/prepare/execute/tool',
      wire.calls.length === 0 && inst.counts.prepare === 0 && inst.counts.execute === 0 && inst.counts.tool === 0,
      JSON.stringify({ calls: wire.calls.length, ...inst.counts }));
    check('I6.declaration-shape zero REQUIRED persistence writes',
      requiredWritesAreZero(wd), JSON.stringify(wd));
    host.capabilities = real;
    wire.push(wire.openai('joint i6d follow-up ok'));
    await ui.submit('joint i6d: legal follow-up');
    check('I6.declaration-shape slot released, next legal task ran',
      ui.store.conversations.find((c) => c.id === convId_joint_6d).status === 'completed',
      JSON.stringify({ calls: wire.calls.length }));
    inst.restore();
  } finally {
    delete globalThis.PersistenceServiceInstance;
    configureModel(null);
  }
}

// =====================================================================
// I7 — replay + required persistence (in-memory store, REAL validators)
// =====================================================================
// Review F2 (I6 oracle): the stub COUNTS writes in two classes —
//   required    requiredConversation (persistConversation {required:true}),
//               providerSession/frame/normalized (ensureSession + the
//               onUserMessage path): the writes the task path treats as
//               completion conditions;
//   optional    plain conversation snapshots + presentation-event saves
//               (error projection) — normal app behavior, never forbidden.
// The compatibility negatives assert a delta of ZERO required writes
// around the rejected submit (boot-time writes are outside the delta).
function createMemoryPersistence() {
  const conversations = new Map();
  const providerSessions = new Map();
  const sessionsByConv = new Map();
  const frames = new Map();
  const normalized = new Map();
  const attachmentsMeta = new Map();
  const attachmentBytes = new Map();
  const kvStores = new Map();
  const counts = {
    requiredConversation: 0, optionalConversation: 0, presentation: 0,
    providerSession: 0, frame: 0, normalized: 0, attachment: 0,
  };
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
    async saveConversation(row, opts) {
      if (opts && opts.required) counts.requiredConversation++;
      else counts.optionalConversation++;
      conversations.set(row.id, JSON.parse(JSON.stringify(row)));
    },
    async loadConversations() { return [...conversations.values()]; },
    async appendPresentationEvent(convId, seq, event) { counts.presentation++; /* recorded implicitly via conversations */ },
    async notePersistenceError() {},
    async get(name, key) {
      return name === 'providerSessions' ? (providerSessions.get(key) || null) : null;
    },
    // Generic kv (the capability registry's store): enough for the image
    // gate to record decisions during the OPT-A flows.
    async put(name, row) { (kvStores.get(name) || kvStores.set(name, new Map()).get(name)).set(row.key, row); return row; },
    async delete(name, key) { const s = kvStores.get(name); if (s) s.delete(key); },
    async loadProviderSession(convId) {
      const sid = sessionsByConv.get(convId);
      return sid ? (providerSessions.get(sid) || null) : null;
    },
    async saveProviderSession(row) {
      counts.providerSession++;
      providerSessions.set(row.id, row);
      if (!sessionsByConv.has(row.conversationId)) sessionsByConv.set(row.conversationId, row.id);
    },
    async appendProviderFrame(frame) {
      if (frameWriteFail && frameWriteFail(frame)) throw new Error('simulated durable write failure');
      counts.frame++;
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
      counts.normalized++;
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
    // Attachment storage (review F1: the OPT-A image path needs a LIVE
    // AttachmentStore backend; the counter makes "zero ingest" directly
    // observable).
    async findAttachmentMetaBySha256(sha) { return attachmentsMeta.get(sha) || null; },
    async hasAttachmentBytes(sha) { return attachmentBytes.has(sha); },
    async writeAttachmentBytes(sha, bytes) { counts.attachment++; attachmentBytes.set(sha, Uint8Array.from(bytes)); },
    async saveAttachmentMeta(record) { counts.attachment++; attachmentsMeta.set(record.sha256, JSON.parse(JSON.stringify(record))); return record; },
    async getAttachmentMeta(id) { return [...attachmentsMeta.values()].find((r) => r.id === id) || null; },
    async readAttachmentBytes(key) {
      const rec = [...attachmentsMeta.values()].find((r) => r.storageKey === key);
      const bytes = rec && attachmentBytes.get(rec.sha256);
      if (!bytes) throw new Error('attachment bytes missing: ' + key);
      return bytes.slice();
    },
    _conversations: conversations, _providerSessions: providerSessions,
    _sessionsByConv: sessionsByConv, _frames: frames, _normalized: normalized,
    _counts: counts,
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

// =====================================================================
// OPT — optional-capability decisions CONSUMED on the task path (F1)
// =====================================================================
// OPT-A: the harness does not declare imageInputGate, but the Product
// image path is FULLY live (real AttachmentStore, real persistence, a
// readable image in /mnt/upload) — the text-only degrade must come from
// the TASK's frozen compatibility decision, never from the
// store-unavailable fallback, and the same stores must send the image on
// the NEXT task once the real declaration is back (per-task re-check).
{
  const wire = createWire('joint-opt-a');
  wires.set('joint-opt-a', wire);
  configureModel(wire);
  const persist = createMemoryPersistence();
  globalThis.PersistenceServiceInstance = persist;
  try {
    const ui = await freshStore('joint-opt-a');
    const inst = await instrument(ui);
    const ingest = instrumentAttachmentIngest(ui);
    applyJointSettings(ui);
    // A genuinely different-declaring harness generation WITHOUT the
    // imageInputGate capability (the narrow declaration seam; the SAME
    // production check runs).
    globalThis.__LOCUS_HOOKS__ = {
      harnessCapabilities: () => harnessDeclarationVariant({ imageInputGate: false }),
    };
    // A REAL readable image on the user upload path.
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 1, 2, 3, 4]);
    ui.addUploadFiles([new File([pngBytes], 'joint-opt-a.png', { type: 'image/png' })]);
    const convA = ui.store.liveConversationId;
    const att0 = persist._counts.attachment;
    wire.push(wire.openai('joint opt-a text-only answer'));
    await ui.submit('joint opt-a: imageInputGate missing degrades to text');
    const conv = ui.store.conversations.find((c) => c.id === convA);
    const events = itemsOf(ui).filter((i) => i.conv === convA);
    check('OPT-A the missing imageInputGate degraded to text-only with the explicit capability warning',
      conv.status === 'completed'
        && events.some((i) => i.kind === 'warning' && i.code === 'image_attachment_rejected'
          && String(i.text).includes('imageInputGate')),
      JSON.stringify(events.map((e) => e.kind + ':' + e.code + ':' + String(e.text).slice(0, 90))));
    check('OPT-A zero attachment ingest and zero attachment bytes (decision-driven, not store-unavailable)',
      ingest.counts.ingest === 0 && persist._counts.attachment - att0 === 0,
      JSON.stringify({ ingest: ingest.counts.ingest, att: persist._counts.attachment - att0 }));
    const firstCall = wire.calls[0];
    const userMsg = firstCall.body.messages.find((m) => m.role === 'user');
    check('OPT-A the model request was text only (plain string user content, no image wire part, no probe, no approval)',
      wire.calls.length === 1 && typeof userMsg.content === 'string'
        && !JSON.stringify(firstCall.body.messages).includes('image_url')
        && !JSON.stringify(firstCall.body.messages).includes('data:image')
        && !JSON.stringify(firstCall.body.messages).includes('joint-opt-a.png')
        && !ui.store.pendingApproval,
      JSON.stringify({ calls: wire.calls.length, contentType: typeof userMsg.content }));
    check('OPT-A the user upload was kept (no deletion)',
      ui.store.attachments.length === 1
        && await ui.vfs.readBytes('/mnt/upload/joint-opt-a.png').then((b) => b.length === pngBytes.length, () => false),
      JSON.stringify({ attachments: ui.store.attachments.length }));

    // The SAME graph, the REAL declaration restored: the very next task
    // re-checks and the image goes out (per-task decision, no sticky
    // page-level state).
    delete globalThis.__LOCUS_HOOKS__;
    wire.push(wire.openai('joint opt-a task2 answer'));
    const done2 = ui.submit('joint opt-a: image sent under the real declaration');
    await waitFor('OPT-A the image capability ask is pending', () => !!ui.store.pendingApproval);
    check('OPT-A the real gate asked through the approval framework (capability kind)',
      ui.store.pendingApproval && ui.store.pendingApproval.kind === 'capability',
      JSON.stringify(ui.store.pendingApproval && ui.store.pendingApproval.kind));
    ui.resolveApproval(ui.store.pendingApproval.id, { outcome: 'confirm', scope: 'once' });
    await done2;
    const imgBody = JSON.stringify(wire.calls[1].body.messages);
    check('OPT-A the next task ingested once and actually sent the image',
      ingest.counts.ingest === 1 && imgBody.includes('image_url') && imgBody.includes('image/png'),
      JSON.stringify({ ingest: ingest.counts.ingest, hasImage: imgBody.includes('image_url') }));
    check('OPT-A the second task completed (the full image path still works after the degrade task)',
      ui.store.conversations.find((c) => c.id === convA).status === 'completed',
      JSON.stringify({ status: ui.store.conversations.find((c) => c.id === convA).status }));
    inst.restore();
    ingest.restore();
  } finally {
    delete globalThis.__LOCUS_HOOKS__;
    delete globalThis.PersistenceServiceInstance;
    configureModel(null);
  }
}

// OPT-B/C: capabilityComposition missing while the implementation objects
// are FULLY present (a real manager). With a user-enabled capability the
// task is REFUSED explicitly before any side effect; with nothing enabled
// the declared degrade performs ZERO capability work and the task completes.
{
  const wire = createWire('joint-opt-b');
  wires.set('joint-opt-b', wire);
  configureModel(wire);
  const persist = createMemoryPersistence();
  globalThis.PersistenceServiceInstance = persist;
  try {
    const ui = await freshStore('joint-opt-b');
    const inst = await instrument(ui);
    applyJointSettings(ui);
    // A capability the user enabled (production catalogs are empty; the
    // synthetic injection is the documented test path).
    ui.injectCapabilityCatalogs({ capabilities: [{
      id: 'joint.cap', version: '1.0.0', displayName: 'Joint Capability',
      description: 'review-F1 negative fixture', plugins: [], skills: [], mcps: [],
    }] });
    await ui.enableCapability('joint.cap');
    globalThis.__LOCUS_HOOKS__ = {
      harnessCapabilities: () => harnessDeclarationVariant({ capabilityComposition: false }),
    };
    const convC = ui.store.liveConversationId;
    const w0 = { ...persist._counts };
    await ui.submit('joint opt-c: enabled capability under missing composition must be refused');
    const conv = ui.store.conversations.find((c) => c.id === convC);
    const events = itemsOf(ui).filter((i) => i.conv === convC);
    const wd = requiredWriteDelta(persist, w0);
    check('OPT-C the task was refused explicitly (capability_composition_unavailable), naming the enabled item',
      conv.status === 'interrupted'
        && events.some((i) => i.kind === 'error' && i.code === 'capability_composition_unavailable'
          && String(i.text).includes('joint.cap')),
      JSON.stringify(events.map((e) => e.kind + ':' + e.code + ':' + String(e.text).slice(0, 130))));
    check('OPT-C the refusal happened before every side effect (zero model/prepare/execute/tool, zero required writes)',
      wire.calls.length === 0 && inst.counts.prepare === 0 && inst.counts.execute === 0
        && inst.counts.tool === 0 && requiredWritesAreZero(wd),
      JSON.stringify({ calls: wire.calls.length, ...inst.counts, wd }));

    // The declared degrade: nothing enabled anymore → the SAME
    // declaration, ZERO capability work, task completes on the shell path.
    await ui.disableCapability('joint.cap');
    const caps = instrumentCapabilities(ui);
    wire.push(wire.openai('joint opt-b degraded answer'));
    await ui.submit('joint opt-b: composition missing degrades to zero capability work');
    check('OPT-B the degraded task completed on the real chain',
      ui.store.conversations.find((c) => c.id === convC).status === 'completed',
      JSON.stringify({ status: ui.store.conversations.find((c) => c.id === convC).status }));
    check('OPT-B zero capability work on the disable path (refresh/build/payload/mounts)',
      caps.counts.refresh === 0 && caps.counts.build === 0 && caps.counts.payload === 0 && caps.counts.mounts === 0,
      JSON.stringify(caps.counts));
    inst.restore();
    caps.restore();
  } finally {
    delete globalThis.__LOCUS_HOOKS__;
    delete globalThis.PersistenceServiceInstance;
    configureModel(null);
  }
}

// OPT-D: a declaration change MID-TASK cannot rebind the decision the task
// already adopted; the NEXT task re-checks.
{
  const wire = createWire('joint-opt-d');
  wires.set('joint-opt-d', wire);
  configureModel(wire);
  const ui = await freshStore('joint-opt-d');
  const inst = await instrument(ui);
  applyJointSettings(ui);
  const convD = ui.store.liveConversationId;
  wire.push({ __parkManual: true });
  const doneA = ui.submit('joint opt-d: decision adopted at the gate');
  await waitFor('OPT-D the task dispatched its first request', () => wire.calls.length === 1);
  const host = ui.runtimeHost();
  const real = host.capabilities.bind(host);
  host.capabilities = () => ({ ...real(), contractVersion: 999 }); // hostile MID-TASK
  wire.releaseParked(wire.openai('joint opt-d adopted answer'));
  await doneA;
  check('OPT-D the in-flight task completed under its ADOPTED decision despite the mid-task change',
    ui.store.conversations.find((c) => c.id === convD).status === 'completed'
      && !itemsOf(ui).some((i) => i.conv === convD && i.code === 'core_incompatible'),
    JSON.stringify({ status: ui.store.conversations.find((c) => c.id === convD).status }));
  const callsAfterA = wire.calls.length;
  wire.push(wire.openai('MUST NOT BE REQUESTED'));
  await ui.submit('joint opt-d: next task re-checks');
  check('OPT-D the next task re-checked and was rejected against the CHANGED declaration',
    itemsOf(ui).some((i) => i.conv === convD && i.kind === 'error' && i.code === 'core_incompatible')
      && wire.calls.length === callsAfterA,
    JSON.stringify({ calls: wire.calls.length - callsAfterA }));
  host.capabilities = real;
  wire.push(wire.openai('joint opt-d restored answer'));
  await ui.submit('joint opt-d: legal again after restore');
  check('OPT-D a later task runs again on the restored declaration',
    ui.store.conversations.find((c) => c.id === convD).status === 'completed',
    JSON.stringify({ status: ui.store.conversations.find((c) => c.id === convD).status }));
  inst.restore();
  configureModel(null);
}

// OPT-E: nativeToolCalls missing → the strict TEXT-FALLBACK protocol
// completes a real fenced-JSON tool round trip through the production
// chain (the declared degrade rule, with behavior evidence).
{
  const wire = createWire('joint-opt-e');
  wires.set('joint-opt-e', wire);
  configureModel(wire);
  const ui = await freshStore('joint-opt-e');
  const inst = await instrument(ui);
  applyJointSettings(ui);
  globalThis.__LOCUS_HOOKS__ = {
    harnessCapabilities: () => harnessDeclarationVariant({ nativeToolCalls: false }),
  };
  const fenced = '```json\n{"tool":"bash","input":"echo opt-e-ok > /tmp/joint-opt-e.txt && cat /tmp/joint-opt-e.txt"}\n```';
  wire.push(wire.openai(fenced));          // text fallback: NO native tool_calls
  wire.push(wire.openai('joint opt-e final'));
  const convE = ui.store.liveConversationId;
  await ui.submit('joint opt-e: text-fallback round trip');
  const file = await ui.vfs.read('/tmp/joint-opt-e.txt').catch(() => null);
  const secondBody = JSON.stringify(wire.calls[1].body.messages);
  check('OPT-E the missing nativeToolCalls never rejects the task',
    ui.store.conversations.find((c) => c.id === convE).status === 'completed'
      && !itemsOf(ui).some((i) => i.conv === convE && i.code === 'core_incompatible'),
    JSON.stringify({ status: ui.store.conversations.find((c) => c.id === convE).status }));
  check('OPT-E the fenced-JSON text fallback dispatched the real tool and the file was written',
    inst.counts.tool === 1 && typeof file === 'string' && file.includes('opt-e-ok'),
    JSON.stringify({ tools: inst.counts.tool, file: String(file).slice(0, 40) }));
  check('OPT-E the result was fed back through the strict text-fallback protocol',
    secondBody.includes('<tool_result>') && secondBody.includes('opt-e-ok'),
    secondBody.slice(0, 160));
  inst.restore();
  configureModel(null);
}

// OPT-F: the runtime stops declaring the direct python execution kind —
// the optional rule ("the product tools call shell only") holds with
// behavior evidence: the shell chain completes, nothing rejects.
{
  const wire = createWire('joint-opt-f');
  wires.set('joint-opt-f', wire);
  configureModel(wire);
  const ui = await freshStore('joint-opt-f');
  const inst = await instrument(ui);
  applyJointSettings(ui);
  const host = ui.runtimeHost();
  const real = host.capabilities.bind(host);
  host.capabilities = () => ({ ...real(), executionKinds: ['shell'] });
  wire.push(wire.openai(null, [wire.toolCall('opt-f-call-1', 'echo opt-f-ok > /tmp/joint-opt-f.txt && cat /tmp/joint-opt-f.txt')]));
  wire.push(wire.openai('joint opt-f final'));
  const convF = ui.store.liveConversationId;
  await ui.submit('joint opt-f: shell-only executionKinds');
  const file = await ui.vfs.read('/tmp/joint-opt-f.txt').catch(() => null);
  check('OPT-F the shell-only runtime completed the real tool task (the python kind is optional)',
    ui.store.conversations.find((c) => c.id === convF).status === 'completed'
      && inst.counts.tool === 1 && typeof file === 'string' && file.includes('opt-f-ok')
      && !itemsOf(ui).some((i) => i.conv === convF && i.code === 'core_incompatible'),
    JSON.stringify({ status: ui.store.conversations.find((c) => c.id === convF).status,
      tools: inst.counts.tool, file: String(file).slice(0, 40) }));
  inst.restore();
  configureModel(null);
}

// =====================================================================
// I8 — execution-phase lifecycle over the REAL chain (review F2)
// =====================================================================
// The real chain is parked INSIDE a VFS provider write (the shell's `>`
// redirection lands in the /tmp provider — fork() shares provider
// instances, so wrapping the provider parks the REAL RuntimeSession
// execution). Real Runtime execution throughout; only the provider method
// is held by the test.
function parkProviderWrite(ui, marker) {
  const provider = ui.vfs.resolveMount('/tmp').provider;
  const origWrite = provider.write.bind(provider);
  const state = { entered: 0, release: null };
  provider.write = (path, data) => {
    if (!String(path).includes(marker)) return origWrite(path, data);
    state.entered++;
    return new Promise((resolve, reject) => {
      state.release = () => origWrite(path, data).then(resolve, reject);
    });
  };
  state.restore = () => { provider.write = origWrite; };
  return state;
}

// I8a — cancel while the dispatched operation is unsettled.
{
  const wire = createWire('joint-i8a');
  wires.set('joint-i8a', wire);
  configureModel(wire);
  const ui = await freshStore('joint-i8a');
  const inst = await instrument(ui);
  applyJointSettings(ui);
  const park = parkProviderWrite(ui, 'joint-i8a');
  wire.push(wire.openai(null, [wire.toolCall('i8a-call-1', 'echo i8a-committed > /tmp/joint-i8a.txt')]));
  // No second response queued on purpose: any follow-up request would
  // surface as an extra call and fail the zero-further-dispatch checks.
  const bashRecordsBefore = globalThis.Telemetry.records.filter((r) => r.tool === 'bash').length;
  const conv8 = ui.store.liveConversationId;
  const done8 = ui.submit('joint I8a: parked provider write then cancel');
  await waitFor('I8a the real execution parked inside the provider write', () => park.entered === 1 && !!park.release);
  check('I8a the execution is inside the real RuntimeSession (prepare+execute counted once)',
    inst.counts.prepare === 1 && inst.counts.execute === 1,
    JSON.stringify(inst.counts));
  ui.cancelTask();
  let endedEarly = false;
  done8.then(() => { endedEarly = true; }, () => { endedEarly = true; });
  await new Promise((r) => setTimeout(r, 150));
  const convObj = ui.store.conversations.find((c) => c.id === conv8);
  check('I8a the cancel cannot end the task while its dispatched write is unsettled (slot honestly occupied)',
    endedEarly === false && ui.store.busy === true && convObj.status !== 'cancelled'
      && !itemsOf(ui).some((i) => i.conv === conv8 && i.kind === 'warning' && i.code === 'task_cancelled_committed'),
    JSON.stringify({ endedEarly, busy: ui.store.busy, status: convObj.status }));
  check('I8a admission stays closed while the old execution is unsettled',
    (await ui.submit('joint I8a: must not be admitted')) === undefined
      && ui.store.conversations.length === 1,
    JSON.stringify({ convs: ui.store.conversations.length }));
  park.release(); // the dispatched operation settles on the real provider
  await done8;
  const file = await ui.vfs.read('/tmp/joint-i8a.txt').catch(() => null);
  check('I8a the dispatched operation settled honestly: the committed bytes STAY (no fake rollback)',
    typeof file === 'string' && file.includes('i8a-committed'),
    JSON.stringify(String(file).slice(0, 40)));
  const bashRecords = globalThis.Telemetry.records.filter((r) => r.tool === 'bash');
  check('I8a the tool result was NOT converted into a success (telemetry records the failure)',
    bashRecords.length === bashRecordsBefore + 1 && bashRecords[bashRecords.length - 1].success === false,
    JSON.stringify(bashRecords[bashRecords.length - 1] || null).slice(0, 160));
  const endConv = ui.store.conversations.find((c) => c.id === conv8);
  check('I8a exactly one honest cancelled termination, zero further dispatch',
    endConv.status === 'cancelled' && ui.store.busy === false
      && inst.counts.tool === 1 && inst.counts.execute === 1 && wire.calls.length === 1,
    JSON.stringify({ status: endConv.status, busy: ui.store.busy, ...inst.counts, calls: wire.calls.length }));
  park.restore();
  inst.restore();
  configureModel(null);
}

// I8b — Runtime reset boundary (newTask) while the dispatched operation is
// unsettled; the session stays reusable afterwards.
{
  const wire = createWire('joint-i8b');
  wires.set('joint-i8b', wire);
  configureModel(wire);
  const ui = await freshStore('joint-i8b');
  const inst = await instrument(ui);
  applyJointSettings(ui);
  const park = parkProviderWrite(ui, 'joint-i8b');
  wire.push(wire.openai(null, [wire.toolCall('i8b-call-1', 'echo i8b-committed > /tmp/joint-i8b.txt')]));
  const convOld = ui.store.liveConversationId;
  const sessionBefore = await ui.whenRuntimeSession();
  const doneB = ui.submit('joint I8b: parked provider write then boundary');
  await waitFor('I8b the real execution parked inside the provider write', () => park.entered === 1 && !!park.release);
  ui.newTask(); // the REAL session boundary: cancel + runtime reset + new conversation
  const convNew = ui.store.liveConversationId;
  const sessionAfter = await ui.whenRuntimeSession();
  let endedEarly = false;
  doneB.then(() => { endedEarly = true; }, () => { endedEarly = true; });
  await new Promise((r) => setTimeout(r, 150));
  check('I8b the boundary cannot end the parked task; the SAME session object stays bound',
    endedEarly === false && ui.store.busy === true && convNew !== convOld && sessionAfter === sessionBefore,
    JSON.stringify({ endedEarly, busy: ui.store.busy, sameSession: sessionAfter === sessionBefore }));
  park.release();
  await doneB;
  const file = await ui.vfs.read('/tmp/joint-i8b.txt').catch(() => null);
  const oldConvObj = ui.store.conversations.find((c) => c.id === convOld);
  check('I8b the boundary-struck task ended session_changed and its settled effect stayed',
    oldConvObj.status === 'session_changed' && typeof file === 'string' && file.includes('i8b-committed'),
    JSON.stringify({ status: oldConvObj.status, file: String(file).slice(0, 40) }));
  check('I8b zero further dispatch after the boundary',
    inst.counts.tool === 1 && inst.counts.execute === 1 && wire.calls.length === 1,
    JSON.stringify({ ...inst.counts, calls: wire.calls.length }));
  // The SAME session is reusable after the reset boundary.
  wire.push(wire.openai('joint I8b successor answer'));
  await ui.submit('joint I8b: successor after reset');
  check('I8b the runtime session is reusable after the reset boundary',
    ui.store.conversations.find((c) => c.id === convNew).status === 'completed',
    JSON.stringify({ status: ui.store.conversations.find((c) => c.id === convNew).status }));
  park.restore();
  inst.restore();
  configureModel(null);
}

// I8c — dispose: the public port refuses new executions, and through the
// REAL product entry the refusal lands BEFORE any side effect.
{
  const wire = createWire('joint-i8c');
  wires.set('joint-i8c', wire);
  configureModel(wire);
  const ui = await freshStore('joint-i8c');
  const inst = await instrument(ui);
  applyJointSettings(ui);
  const convC = ui.store.liveConversationId;
  wire.push(wire.openai(null, [wire.toolCall('i8c-call-1', 'echo i8c-alive > /tmp/joint-i8c.txt')]));
  wire.push(wire.openai('joint I8c first answer'));
  await ui.submit('joint I8c: alive before dispose');
  check('I8c the graph ran a real tool task before the disposal',
    ui.store.conversations.find((c) => c.id === convC).status === 'completed' && inst.counts.tool === 1,
    JSON.stringify({ status: ui.store.conversations.find((c) => c.id === convC).status, tools: inst.counts.tool }));
  const sess = await ui.whenRuntimeSession();
  sess.dispose('joint i8c disposal');
  let execErr = null;
  try { await sess.execute({ kind: 'shell', input: 'echo never', context: {} }); } catch (e) { execErr = e; }
  let prepErr = null;
  try { await sess.prepare({ python: null }); } catch (e) { prepErr = e; }
  check('I8c the public port refuses execute and prepare after dispose',
    execErr && String(execErr.message).includes('disposed')
      && prepErr && String(prepErr.message).includes('disposed'),
    JSON.stringify({ exec: execErr && execErr.message, prep: prepErr && prepErr.message }));
  const callsBefore = wire.calls.length;
  await ui.submit('joint I8c: must be refused after dispose');
  const events = itemsOf(ui).filter((i) => i.conv === convC);
  check('I8c the post-dispose task was refused through the REAL entry before any side effect',
    events.some((i) => i.kind === 'error' && String(i.text).includes('disposed'))
      && wire.calls.length === callsBefore && inst.counts.tool === 1,
    JSON.stringify({ calls: wire.calls.length - callsBefore, tools: inst.counts.tool }));
  inst.restore();
  configureModel(null);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
