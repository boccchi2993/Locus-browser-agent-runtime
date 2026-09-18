// AgentSession × ApprovalController integration tests (node, NO DOM):
// proves approval is a SUSPENSION of the same async task, not a task
// boundary. The real AgentSession runs unchanged; the toolExecutor asks
// the real ApprovalController with the task's AbortSignal, exactly the
// seam a future image-gate / network / tool consumer will use.
//
//   run() → model → tool asks → PAUSE → human decides → SAME tool
//   continuation resumes → tool_result → SAME session continues →
//   final answer → exactly one task_end.
//
// Run: node tests/agent-approval.test.cjs

const fs = require('fs');
const path = require('path');

const approvalSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'approval.js'), 'utf8');
const toolsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'tools.js'), 'utf8');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent.js'), 'utf8');
const M = eval(approvalSrc + '\n' + toolsSrc + '\n' + src +
  '\n;({ AgentSession, buildSystemPrompt, ApprovalController });');

function envelope(text, extra) {
  return Object.assign({
    content: text,
    reasoning: null,
    stopReason: 'end_turn',
    usage: null,
    rawMessage: { role: 'assistant', content: text },
    truncated: false,
  }, extra || {});
}
const TOOL_CALL = envelope('```json\n{"tool":"bash","input":"ls"}\n```');
const FINAL = envelope('done');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + JSON.stringify(detail).slice(0, 400) : '')); }
}

async function waitFor(cond, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 3000);
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

function newController() {
  const events = [];
  const c = new M.ApprovalController({
    onChange: () => {},
    onEvent: (name, data) => events.push({ name, data }),
  });
  return { c, approvalEvents: events };
}

// Standard wiring: first model reply asks for the tool; the tool asks the
// ApprovalController with the TASK's signal (the exact future consumer
// shape); the decision routes to executed vs denied tool output.
function approvalSession(overrides) {
  const { c, approvalEvents } = newController();
  const state = { modelCalls: 0, toolEntries: 0, decisions: [] };
  const events = [];
  const session = new M.AgentSession(Object.assign({
    modelClient: async () => {
      state.modelCalls++;
      return state.modelCalls === 1 ? TOOL_CALL : FINAL;
    },
    toolExecutor: async (tool, input, workspace, opts) => {
      state.toolEntries++;
      const decision = await c.request({
        kind: 'permission',
        action: { type: 'tool', summary: 'Run ' + tool + ': ' + input },
        policyKey: 'perm:tool:' + tool,
        conversationId: 'conv-1',
        taskGeneration: session ? session.generation : null,
      }, { signal: opts && opts.signal });
      state.decisions.push(decision);
      if (decision.outcome === 'allow') {
        return { output: 'tool ran', success: true, backend: 'harness' };
      }
      return { output: 'not executed: ' + decision.outcome, success: false, backend: 'harness' };
    },
    buildSystemPrompt: M.buildSystemPrompt,
    emit: (e) => events.push(e),
  }, overrides || {}));
  return { session, events, c, approvalEvents, state };
}

const evTypes = (events) => events.map((e) => e.type).join(',');
const count = (events, type) => events.filter((e) => e.type === type).length;
const WS = { name: 'W' };

async function run() {
  // ---------- S1. suspension + same-task resume (the core invariant) ----------
  {
    const { session, events, c, state } = approvalSession();
    const generationBefore = session.generation;
    const runPromise = session.run('list files', { workspace: WS });
    check('S1 approval appears while task runs', await waitFor(() => c.hasPending()));
    check('S1 task paused: no second model call while pending', state.modelCalls === 1);
    check('S1 task paused: no task_end while pending', count(events, 'task_end') === 0);
    check('S1 task_start emitted exactly once', count(events, 'task_start') === 1);
    check('S1 session still holds the task (running)', !!session.task);

    const resolveOk = c.resolve(c.pending.id, { outcome: 'allow', scope: 'once' });
    const finished = await runPromise; // resolves — SAME task, no new submit
    check('S1 allow once resolved the request', resolveOk === true);
    check('S1 run() promise of the SAME task resolved (no rejection)', finished === undefined);
    check('S1 SAME tool continuation executed the tool', state.toolEntries === 1 && state.decisions[0].outcome === 'allow');
    check('S1 session continued to the next model request', state.modelCalls === 2);

    check('S1 event chain: one complete task, no restart',
      evTypes(events) === 'task_start,tool_call,tool_result,assistant_text,task_end', evTypes(events));
    check('S1 exactly one task_start and one task_end (completed)',
      count(events, 'task_start') === 1 && count(events, 'task_end') === 1
      && events[events.length - 1].reason === 'completed');
    check('S1 generation unchanged by the approval round-trip',
      session.generation === generationBefore);
    check('S1 no task left dangling', session.task === null);
    // Provider history: user task + assistant call + user tool feedback +
    // final assistant. The approval itself added NO user/assistant turn.
    const roles = session.history.map((m) => m.role).join(',');
    check('S1 provider history untouched by approval',
      roles === 'user,assistant,user,assistant'
      && session.history.every((m) => !String(m.content || '').includes('approval')),
      roles);
    check('S1 controller holds no grant after allow-once', !c.hasSessionGrant('perm:tool:bash'));
  }

  // ---------- S2. deny ≠ task cancel ----------
  {
    const { session, events, c, state } = approvalSession();
    const runPromise = session.run('list files', { workspace: WS });
    await waitFor(() => c.hasPending());
    c.resolve(c.pending.id, { outcome: 'deny', scope: 'once' });
    await runPromise;

    check('S2 denial reached the tool as deny', state.decisions[0].outcome === 'deny');
    check('S2 task CONTINUED after deny: next model call happened', state.modelCalls === 2);
    check('S2 task completed normally', count(events, 'task_end') === 1
      && events[events.length - 1].reason === 'completed');
    check('S2 failed tool_result fed back to the model (success: false)',
      session.history.some((m) => m.role === 'user'
        && typeof m.content === 'string' && m.content.includes('success: false')
        && m.content.includes('not executed: deny')));
    check('S2 no cancellation warning emitted',
      !events.some((e) => e.type === 'warning' && e.code === 'task_cancelled_committed'));
    check('S2 generation unchanged (deny is not a session boundary)', session.generation === 0);
  }

  // ---------- S3. cancel task while approval pending ----------
  {
    const { session, events, c, state } = approvalSession();
    const runPromise = session.run('list files', { workspace: WS });
    await waitFor(() => c.hasPending());
    const pendingId = c.pending.id;
    session.cancel(); // the ONLY cancel path — no approval-side shortcut
    await runPromise;
    const decision = state.decisions[0];

    check('S3 pending approval closed immediately as cancelled',
      decision.outcome === 'cancelled' && decision.reason === 'aborted');
    check('S3 no stale approval left pending', !c.hasPending());
    check('S3 tool did NOT execute the action', state.decisions[0].outcome === 'cancelled');
    check('S3 no further model call after cancel', state.modelCalls === 1);
    check('S3 task ended cancelled exactly once',
      count(events, 'task_end') === 1 && events[events.length - 1].reason === 'cancelled');
    check('S3 no new task_start was emitted', count(events, 'task_start') === 1);
    check('S3 run promise settled (no dangling await)', true);
    check('S3 stale resolve after cancel is a no-op',
      c.resolve(pendingId, { outcome: 'allow', scope: 'session' }) === false && !c.hasPending());
  }

  // ---------- S4. session switch (reset) while approval pending ----------
  {
    const { session, events, c, state } = approvalSession();
    const runPromise = session.run('list files', { workspace: WS });
    await waitFor(() => c.hasPending());
    const staleId = c.pending.id;
    session.reset(); // newTask()/workspace-switch boundary
    await runPromise;

    check('S4 old approval cancelled by the session boundary',
      state.decisions[0].outcome === 'cancelled' && !c.hasPending());
    check('S4 old task ended session_changed exactly once',
      count(events, 'task_end') === 1 && events[events.length - 1].reason === 'session_changed');
    check('S4 no further model call for the old task', state.modelCalls === 1);
    check('S4 generation bumped, history cleared', session.generation === 1 && session.history.length === 0);

    // A NEW task on the new generation runs cleanly; the stale approval id
    // from the old task cannot touch it.
    const staleResolve = c.resolve(staleId, { outcome: 'allow', scope: 'session' });
    state.modelCalls = 0; // second task must re-enter the tool-call branch
    const second = session.run('again', { workspace: WS });
    await waitFor(() => c.hasPending());
    check('S4 stale approval button cannot affect the NEW task',
      staleResolve === false && c.pending.id !== staleId);
    c.resolve(c.pending.id, { outcome: 'allow', scope: 'once' });
    await second;
    check('S4 new task completed on the new generation',
      state.modelCalls === 2 && count(events, 'task_end') === 2
      && events[events.length - 1].reason === 'completed');
    check('S4 grant from stale id was never minted', !c.hasSessionGrant('perm:tool:bash'));
  }

  // ---------- S5. session grant auto-allows inside the agent loop ----------
  {
    const { session, events, c, state } = approvalSession();
    // First task: allow for session.
    const first = session.run('list files', { workspace: WS });
    await waitFor(() => c.hasPending());
    c.resolve(c.pending.id, { outcome: 'allow', scope: 'session' });
    await first;
    // Second task, same session: tool re-asks the same policyKey — the
    // controller auto-allows with NO pending state and NO second model
    // stall, and the task runs straight through.
    state.modelCalls = 0;
    await session.run('list files again', { workspace: WS });
    check('S5 granted policy auto-allows inside a later task',
      state.decisions.length === 2 && state.decisions[1].viaGrant === true);
    check('S5 no approval round-trip stalled the granted task',
      !c.hasPending() && count(events, 'task_end') === 2
      && events[events.length - 1].reason === 'completed');
  }

  console.log('---');
  console.log(failed ? failed + ' check(s) FAILED' : 'all ' + passed + ' agent×approval integration checks passed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
