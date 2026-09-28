// Task-runner lifecycle tests (node, no DOM, no Vue, no ui/store.js import).
// Drives the PUBLIC entry of src/harness/task-runner.js with controlled
// async barriers and asserts ORDER, ISOLATION and SIDE-EFFECT bounds —
// not getter shapes:
//
//   S1  normal prepare → run → settle: exact event order, one terminal,
//       onTaskEnd fires exactly once per task
//   S2  cancel while preparing: zero run invocations, single terminal,
//       backfilled task_start only when the product asks for it
//   S3  session boundary during preparation: session_changed outcome and
//       the late prepare result never enters the run phase; an explicit
//       rebind epoch realignment still runs
//   S4  cancel mid-run: committed-effect report survives, exactly one
//       terminal, repeated cancel is a no-op
//   S5  required persistence failure: no run; persistence_error beats a
//       concurrent cancel
//   S6  concurrent submits: admission holds through the prepare window
//   S7  storage quiesce vs submit race: admission closed for the whole
//       mutation window, old task fully ended before the mutation runs,
//       cancelled task never reaches run (no late write-back)
//   S8  a late terminal of an OLD task cannot settle or clear a NEW task
//   S9  prepare throws + repeated cancel: exactly one error, one terminal,
//       one onTaskEnd, one ended resolution; runner reusable after cleanup
//
// Run: node tests/task-runner.test.mjs

import { createTaskRunner } from '../src/harness/task-runner.js';

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// One wiring per scenario, mirroring the product pipeline: every emitted
// event lands in `events` AND is fed back through observeEvent.
function wire({ prepare, epoch, onTaskEnd }) {
  const events = [];
  let currentEpoch = epoch === undefined ? 1 : epoch;
  const runner = createTaskRunner({
    emit: (e) => { events.push(e); runner.observeEvent(e); },
    prepare,
    sessionEpoch: () => currentEpoch,
    onTaskEnd,
  });
  return {
    runner, events,
    emitFromRun: (e) => { events.push(e); runner.observeEvent(e); },
    setEpoch: (v) => { currentEpoch = v; },
  };
}

// ---------- S1: normal order ----------
{
  const ends = [];
  const w = wire({
    prepare: () => Promise.resolve({
      status: 'ready',
      run: async () => {
        w.emitFromRun({ type: 'task_start', input: 'summarize' });
        w.emitFromRun({ type: 'tool_call', tool: 'bash', input: 'echo hi' });
        w.emitFromRun({ type: 'tool_result', tool: 'bash', success: true, output: '[written: /tmp/a]' });
        w.emitFromRun({ type: 'task_end', reason: 'completed' });
      },
    }),
    onTaskEnd: (t, o) => ends.push({ id: t.id, reason: o.reason }),
  });
  const handle = w.runner.submit('summarize');
  check('S1 submit accepted before any async step', !!handle && !!handle.signal && !handle.signal.aborted);
  const outcome = await handle.ended;
  check('S1 exact event order start→tool_call→tool_result→single task_end(completed)',
    JSON.stringify(w.events.map((e) => e.type)) === JSON.stringify(['task_start', 'tool_call', 'tool_result', 'task_end'])
    && w.events[3].reason === 'completed', JSON.stringify(w.events));
  check('S1 outcome completed on handle and ended promise', outcome.reason === 'completed' && handle.outcome().reason === 'completed');
  check('S1 onTaskEnd exactly once with matching id', ends.length === 1 && ends[0].id === handle.id && ends[0].reason === 'completed');
  check('S1 no active task after end', w.runner.activeTask() === null);
  await 0;
}

// ---------- S2: cancel during prepare ----------
{
  let runCalls = 0;
  const gate = deferred();
  const w = wire({ prepare: () => gate.promise.then(() => ({ status: 'ready', run: async () => { runCalls++; } })) });
  const handle = w.runner.submit('prepare-cancel-me', { preRunStart: () => true });
  check('S2 signal live at admission, cancel applies immediately',
    !handle.signal.aborted && handle.cancel('user') === true && handle.signal.aborted && handle.cancelReason() === 'user');
  gate.resolve(); // prepare settles LATE with a ready result — must be refused
  const outcome = await handle.ended;
  check('S2 late ready result refused: zero run invocations', runCalls === 0);
  check('S2 backfilled start + warning + single cancelled terminal',
    JSON.stringify(w.events.map((e) => e.type)) === JSON.stringify(['task_start', 'warning', 'task_end'])
    && w.events[1].code === 'task_cancelled' && w.events[2].reason === 'cancelled'
    && outcome.reason === 'cancelled', JSON.stringify(w.events));
}
{
  const gate = deferred();
  const w = wire({ prepare: () => gate.promise.then(() => ({ status: 'ready', run: async () => {} })) });
  const handle = w.runner.submit('x'); // no preRunStart option
  handle.cancel();
  gate.resolve();
  await handle.ended;
  check('S2 no preRunStart ⇒ no backfilled task_start',
    JSON.stringify(w.events.map((e) => e.type)) === JSON.stringify(['warning', 'task_end']), JSON.stringify(w.events));
}

// ---------- S3: session boundary during prepare ----------
{
  let runCalls = 0;
  const gate = deferred();
  const w = wire({ prepare: () => gate.promise.then(() => ({ status: 'ready', run: async () => { runCalls++; } })) });
  const handle = w.runner.submit('boundary');
  w.setEpoch(2); // user opened a new task / remounted while preparing
  gate.resolve();
  const outcome = await handle.ended;
  check('S3 boundary outcome: zero run, session_changed, one warning + one terminal',
    runCalls === 0 && outcome.reason === 'session_changed'
    && w.events.filter((e) => e.type === 'warning' && e.code === 'session_changed').length === 1
    && w.events.filter((e) => e.type === 'task_end').length === 1
    && w.events[w.events.length - 1].reason === 'session_changed', JSON.stringify(w.events));
}
{
  // Rebind realignment: prepare returns the NEW epoch (product rebind) — runs.
  const gate = deferred();
  const w = wire({
    prepare: () => gate.promise.then(() => ({
      status: 'ready', epoch: 2,
      run: async () => { w.emitFromRun({ type: 'task_start', input: 'b' }); w.emitFromRun({ type: 'task_end', reason: 'completed' }); },
    })),
  });
  const handle = w.runner.submit('rebound');
  w.setEpoch(2); // product rebind advanced the generation; task pinned the new epoch
  gate.resolve();
  const outcome = await handle.ended;
  check('S3 rebind epoch realignment still runs to completion', outcome.reason === 'completed'
    && w.events.some((e) => e.type === 'task_start'));
}

// ---------- S4: cancel mid-run ----------
{
  const w = wire({
    prepare: () => Promise.resolve({
      status: 'ready',
      run: async (ctx) => {
        w.emitFromRun({ type: 'task_start', input: 'work' });
        w.emitFromRun({ type: 'tool_call', tool: 'bash', input: 'rm x' });
        w.emitFromRun({ type: 'tool_result', tool: 'bash', success: false, output: 'bash: cancelled\nrm: cancelled after committing 1 entrie(s): /w/x (not rolled back)' });
        ctx.signal.addEventListener('abort', () => {
          w.emitFromRun({ type: 'warning', code: 'task_cancelled_committed', message: '取消不会回滚已提交的更改。' });
          w.emitFromRun({ type: 'task_end', reason: 'cancelled' });
        });
        // Suspend like a real model request would; only the abort resumes us.
        await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
      },
    }),
  });
  const handle = w.runner.submit('work');
  await tick(); // enter the run phase
  handle.cancel('user');
  const outcome = await handle.ended;
  check('S4 committed-effect report survives cancellation',
    w.events.some((e) => e.type === 'tool_result' && /not rolled back/.test(e.output || '')), JSON.stringify(w.events));
  check('S4 exactly one task_end with reason cancelled',
    w.events.filter((e) => e.type === 'task_end').length === 1 && w.events[w.events.length - 1].reason === 'cancelled');
  check('S4 no runner-added duplicate terminal; slot freed', outcome.reason === 'cancelled' && w.runner.activeTask() === null);
  check('S4 repeated cancel is a no-op', handle.cancel('again') === false);
}

// ---------- S5: required persistence failure ----------
{
  let runCalls = 0;
  const w = wire({
    prepare: async () => { const e = new Error('persistence failed: boom'); e.persistenceFailure = true; throw e; },
  });
  void runCalls;
  const handle = w.runner.submit('persist-fail');
  const outcome = await handle.ended;
  check('S5 persistence_error outcome with no run',
    outcome.reason === 'persistence_error'
    && w.events.some((e) => e.type === 'error' && e.code === 'persistence_write_failed')
    && w.events.filter((e) => e.type === 'task_end').length === 1
    && w.events[w.events.length - 1].reason === 'persistence_error', JSON.stringify(w.events));
}
{
  // Priority: a persistence failure thrown while cancelled is NOT downgraded.
  const w = wire({
    prepare: async (task) => {
      task.cancel('user');
      const e = new Error('persistence failed: boom');
      e.name = 'PersistenceError';
      throw e;
    },
  });
  const handle = w.runner.submit('race');
  const outcome = await handle.ended;
  check('S5 persistence_error wins over a concurrent cancel',
    outcome.reason === 'persistence_error' && w.events[w.events.length - 1].reason === 'persistence_error');
}

// ---------- S6: concurrent submit ----------
{
  const gate = deferred();
  const w = wire({ prepare: () => gate.promise.then(() => ({ status: 'silent' })) });
  const a = w.runner.submit('A');
  const b = w.runner.submit('B');
  check('S6 second submit refused inside the prepare window', !!a && b === null);
  gate.resolve();
  await a.ended;
  const c = w.runner.submit('C');
  check('S6 admission reopens after the first task ended', !!c);
  await c.ended;
}

// ---------- S7: storage quiesce vs submit ----------
{
  const gate = deferred();
  let runCalls = 0;
  let activeDuringAction = 'unset';
  const w = wire({ prepare: () => gate.promise.then(() => ({ status: 'ready', run: async () => { runCalls++; } })) });
  const a = w.runner.submit('A');
  const mutation = w.runner.quiesceAndRun(async () => {
    activeDuringAction = w.runner.activeTask() === null ? 'none' : 'task';
    return 'done';
  }, { timeoutMs: 2000 });
  await tick(); await tick(); // the gate closes admission asynchronously
  const b = w.runner.submit('B');
  check('S7 submit refused while the mutation gate is closed', b === null);
  gate.resolve(); // A's prepare settles; runner sees the cancel and ends A
  const result = await mutation;
  check('S7 mutation ran only after A fully ended', result === 'done' && activeDuringAction === 'none');
  check('S7 cancelled A never reached run (no late write-back)', runCalls === 0 && (await a.ended).reason === 'cancelled');
  const c = w.runner.submit('C');
  check('S7 admission reopens after the mutation', !!c);
  await c.ended;
}

// ---------- S8: late finish of an old task ----------
{
  const gate = deferred();
  let firstRun = true;
  const w = wire({
    prepare: () => firstRun
      ? Promise.resolve({
        status: 'ready',
        run: async () => { w.emitFromRun({ type: 'task_start', input: 'A' }); w.emitFromRun({ type: 'task_end', reason: 'completed' }); },
      })
      : gate.promise.then(() => ({
        status: 'ready',
        run: async () => { w.emitFromRun({ type: 'task_start', input: 'B' }); w.emitFromRun({ type: 'task_end', reason: 'completed' }); },
      })),
  });
  const a = w.runner.submit('A');
  await a.ended;
  firstRun = false;
  const b = w.runner.submit('B'); // same runner; B is PREPARING now
  check('S8 new task admitted after the old one ended', !!b && w.runner.activeTask() === b);
  check('S8 repeated cancel of the ended old task is a no-op', a.cancel('late') === false);
  // A's tail task_end flushes through the pipeline while B is preparing:
  w.runner.observeEvent({ type: 'task_end', reason: 'completed' });
  check('S8 late old terminal does not settle the preparing new task',
    b.outcome() === null && w.runner.activeTask() === b);
  gate.resolve();
  const outcomeB = await b.ended;
  check('S8 new task still completes normally with its own single terminal',
    outcomeB.reason === 'completed'
    && w.events.filter((e) => e.type === 'task_end').length === 2
    && w.events[w.events.length - 1].reason === 'completed');
}

// ---------- S9: prepare failure + repeated cancel ----------
{
  let terminals = 0, errors = 0, onTaskEndCount = 0;
  const w = wire({
    prepare: async (task) => { task.cancel('user'); task.cancel('user-again'); throw new Error('prepare exploded'); },
    onTaskEnd: () => { onTaskEndCount++; },
  });
  // emit counting via the events array instead of extra closures
  const handle = w.runner.submit('fail-me');
  handle.cancel('user'); // third cancel — still a no-op
  const outcome = await handle.ended;
  terminals = w.events.filter((e) => e.type === 'task_end').length;
  errors = w.events.filter((e) => e.type === 'error').length;
  check('S9 exactly one terminal, one error, one onTaskEnd',
    terminals === 1 && errors === 1 && onTaskEndCount === 1,
    JSON.stringify({ terminals, errors, onTaskEndCount }));
  check('S9 honest error outcome (not downgraded to cancelled)',
    outcome.reason === 'error' && w.events[0].type === 'error');
  const next = w.runner.submit('after-failure');
  check('S9 runner reusable after a failed prepare', !!next);
  await next.ended;
}

console.log('---');
console.log('task-runner.test.mjs: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
