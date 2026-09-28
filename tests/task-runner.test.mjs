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
//   S10 (F1) the real completion boundary: a recorded terminal intent does
//       NOT complete `ended`, open admission or open the storage gate
//       while the run body is still suspended; publication happens once,
//       after the run body returned; must-await onTaskEnd cleanup is
//       covered by `ended`; a throwing onTaskEnd is contained
//   S11 (F2) task event identity: foreign events — unstamped strays and
//       events stamped with an OLD task's id — cannot settle, start or
//       pollute the active task in its preparing OR running phase
//   S12 (F3) the quiesce gate closes admission SYNCHRONOUSLY and stays
//       closed across queued mutations; timeouts, throwing actions and
//       recovery keep the serial order without faking task ends
//   S13 (F4) one classification table for thrown AND structured failures:
//       persistence failures beat a concurrent cancel, AbortError is the
//       cancellation itself, session boundaries win over plain cancel,
//       and a post-intent necessary persistence failure is never silently
//       lost
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
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// One wiring per scenario, mirroring the product pipeline: the runner's
// sink records every event AND feeds it back through observeEvent; run
// bodies emit through the task-bound ctx.emit exactly like the Product
// passes it into AgentSession.run({ emit }).
function wire({ prepare, epoch, onTaskEnd }) {
  const events = [];
  let currentEpoch = epoch === undefined ? 1 : epoch;
  let runner;
  runner = createTaskRunner({
    emit: (e) => { events.push(e); runner.observeEvent(e); },
    prepare,
    sessionEpoch: () => currentEpoch,
    onTaskEnd,
  });
  return {
    runner, events,
    // Foreign-event injector: an event entering the pipeline WITHOUT the
    // active task's identity (an unstamped stray, or one stamped with an
    // old task's id). The runner must never attribute these to the
    // active task.
    emitForeign: (e) => { events.push(e); runner.observeEvent(e); },
    setEpoch: (v) => { currentEpoch = v; },
  };
}

// ---------- S1: normal order ----------
{
  const ends = [];
  const w = wire({
    prepare: () => Promise.resolve({
      status: 'ready',
      run: async (ctx) => {
        ctx.emit({ type: 'task_start', input: 'summarize' });
        ctx.emit({ type: 'tool_call', tool: 'bash', input: 'echo hi' });
        ctx.emit({ type: 'tool_result', tool: 'bash', success: true, output: '[written: /tmp/a]' });
        ctx.emit({ type: 'task_end', reason: 'completed' });
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
      run: async (ctx) => { ctx.emit({ type: 'task_start', input: 'b' }); ctx.emit({ type: 'task_end', reason: 'completed' }); },
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
        ctx.emit({ type: 'task_start', input: 'work' });
        ctx.emit({ type: 'tool_call', tool: 'bash', input: 'rm x' });
        ctx.emit({ type: 'tool_result', tool: 'bash', success: false, output: 'bash: cancelled\nrm: cancelled after committing 1 entrie(s): /w/x (not rolled back)' });
        ctx.signal.addEventListener('abort', () => {
          ctx.emit({ type: 'warning', code: 'task_cancelled_committed', message: '取消不会回滚已提交的更改。' });
          ctx.emit({ type: 'task_end', reason: 'cancelled' });
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
  check('S7 same-stack submit refused the moment quiesceAndRun is called', w.runner.submit('same-stack') === null);
  await tick(); await tick();
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
    prepare: () => {
      if (firstRun) {
        firstRun = false;
        return Promise.resolve({
          status: 'ready',
          run: async (ctx) => { ctx.emit({ type: 'task_start', input: 'A' }); ctx.emit({ type: 'task_end', reason: 'completed' }); },
        });
      }
      return gate.promise.then(() => ({
        status: 'ready',
        run: async (ctx) => { ctx.emit({ type: 'task_start', input: 'B' }); ctx.emit({ type: 'task_end', reason: 'completed' }); },
      }));
    },
  });
  const a = w.runner.submit('A');
  await a.ended;
  const b = w.runner.submit('B'); // same runner; B is PREPARING now
  check('S8 new task admitted after the old one ended', !!b && w.runner.activeTask() === b);
  check('S8 repeated cancel of the ended old task is a no-op', a.cancel('late') === false);
  // A's tail task_end flushes through the pipeline while B is preparing:
  w.emitForeign({ type: 'task_end', reason: 'completed' }); // unstamped stray
  w.emitForeign({ type: 'task_end', taskId: a.id, reason: 'completed' }); // stamped with the OLD task's id
  check('S8 late old terminal does not settle the preparing new task',
    b.outcome() === null && w.runner.activeTask() === b);
  gate.resolve();
  const outcomeB = await b.ended;
  check('S8 new task still completes normally with its own single terminal',
    outcomeB.reason === 'completed'
    && w.events.filter((e) => e.type === 'task_end' && e.taskId === b.id).length === 1
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

// ---------- S10 (F1): the real completion boundary ----------
{
  const order = [];
  let releaseRun;
  const suspension = new Promise((r) => { releaseRun = r; });
  let releaseCleanup;
  const cleanupGate = new Promise((r) => { releaseCleanup = r; });
  const w = wire({
    prepare: () => Promise.resolve({
      status: 'ready',
      run: async (ctx) => {
        ctx.emit({ type: 'task_start', input: 'A' });
        ctx.emit({ type: 'tool_result', tool: 'bash', success: true, output: 'partial' });
        ctx.emit({ type: 'task_end', reason: 'completed' }); // intent recorded
        await suspension; // run body still finishing (finally / persistence tail)
      },
    }),
    onTaskEnd: async (t, o) => {
      order.push('cleanup-start:' + o.reason);
      check('S10 onTaskEnd runs after the final task_end was published',
        w.events.some((e) => e.type === 'task_end' && e.taskId === t.id), JSON.stringify(w.events));
      await cleanupGate; // must-await cleanup
      order.push('cleanup-done');
    },
  });
  const handle = w.runner.submit('A');
  await tick(); await tick(); // enter run; intent recorded
  const endedEarly = await Promise.race([handle.ended.then(() => true), delay(40).then(() => false)]);
  check('S10 ended NOT resolved while the run body is still suspended', endedEarly === false);
  check('S10 final task_end not published while suspended',
    w.events.filter((e) => e.type === 'task_end').length === 0, JSON.stringify(w.events));
  check('S10 second submit refused before the real completion boundary', w.runner.submit('B') === null);
  check('S10 active task still held before the boundary', w.runner.activeTask() === handle);
  check('S10 onTaskEnd not fired before the boundary', order.length === 0, JSON.stringify(order));
  let storageRan = false;
  const mutation = w.runner.quiesceAndRun(async () => { storageRan = true; return 'ok'; }, { timeoutMs: 120 });
  const qResult = await mutation.then(() => 'resolved', (e) => 'rejected:' + (e.code || e.message));
  check('S10 storage action blocked and NOT started while suspended',
    qResult.indexOf('rejected') === 0 && storageRan === false, qResult + ' storageRan=' + storageRan);
  releaseRun();
  const endedDuringCleanup = await Promise.race([handle.ended.then(() => true), delay(60).then(() => false)]);
  check('S10 ended still pending while must-await cleanup is parked', endedDuringCleanup === false, JSON.stringify(order));
  releaseCleanup();
  const outcome = await handle.ended;
  check('S10 ended resolves only after the must-await cleanup completes',
    outcome.reason === 'completed' && order.join(',') === 'cleanup-start:completed,cleanup-done', JSON.stringify(order));
  check('S10 final task_end published exactly once, after the run body returned',
    w.events.filter((e) => e.type === 'task_end' && e.taskId === handle.id).length === 1
    && w.events[w.events.length - 1].reason === 'completed', JSON.stringify(w.events));
  const c = w.runner.submit('C');
  check('S10 admission reopens at the real boundary', !!c);
  await c.ended;
}
{
  // A throwing onTaskEnd must never wedge the runner or reject unhandled.
  const w = wire({
    prepare: () => Promise.resolve({
      status: 'ready',
      run: async (ctx) => { ctx.emit({ type: 'task_start', input: 'x' }); ctx.emit({ type: 'task_end', reason: 'completed' }); },
    }),
    onTaskEnd: () => { throw new Error('cleanup exploded'); },
  });
  const handle = w.runner.submit('cleanup-throw');
  const outcome = await handle.ended; // must resolve, not hang
  check('S10 onTaskEnd throw is contained: ended resolves with the outcome', outcome.reason === 'completed');
  check('S10 onTaskEnd throw surfaced as a task_cleanup_failed warning',
    w.events.some((e) => e.type === 'warning' && e.code === 'task_cleanup_failed'), JSON.stringify(w.events));
  check('S10 admission intact after a cleanup failure', !!w.runner.submit('after-throw'));
}
{
  // A REJECTED must-await cleanup promise is contained the same way.
  const w = wire({
    prepare: () => Promise.resolve({ status: 'ready', run: async () => {} }),
    onTaskEnd: async () => { throw new Error('async cleanup failed'); },
  });
  const handle = w.runner.submit('cleanup-reject');
  const outcome = await handle.ended;
  check('S10 rejected cleanup promise contained: ended resolves, warning surfaced',
    outcome.reason === 'completed'
    && w.events.some((e) => e.type === 'warning' && e.code === 'task_cleanup_failed'), JSON.stringify(w.events));
}

// ---------- S11 (F2): task event identity ----------
{
  // Foreign events during B PREPARING.
  const gate = deferred();
  let firstRun = true;
  const w = wire({
    prepare: () => {
      if (firstRun) {
        firstRun = false;
        return Promise.resolve({
          status: 'ready',
          run: async (ctx) => { ctx.emit({ type: 'task_start', input: 'A' }); ctx.emit({ type: 'task_end', reason: 'completed' }); },
        });
      }
      return gate.promise.then(() => ({ status: 'ready', run: async () => {} }));
    },
  });
  const a = w.runner.submit('A');
  await a.ended;
  const b = w.runner.submit('B'); // B is PREPARING
  w.emitForeign({ type: 'task_end', reason: 'completed' });                     // unstamped stray
  w.emitForeign({ type: 'task_end', taskId: a.id, reason: 'completed' });       // OLD task's identity
  w.emitForeign({ type: 'task_start', taskId: a.id, input: 'A-again' });        // OLD task's restart
  w.emitForeign({ type: 'warning', taskId: a.id, code: 'late_warning', message: 'stale' });
  check('S11 foreign events during B preparing do not settle or start B',
    b.outcome() === null && w.runner.activeTask() === b, JSON.stringify(b.outcome()));
  gate.resolve();
  const outcomeB = await b.ended;
  check('S11 B completes normally after the preparing-phase foreign events',
    outcomeB.reason === 'completed'
    && w.events.filter((e) => e.type === 'task_end' && e.taskId === b.id).length === 1, JSON.stringify(w.events));
}
{
  // Foreign events during B RUNNING.
  let releaseB;
  const suspension = new Promise((r) => { releaseB = r; });
  let firstRun = true;
  const w = wire({
    prepare: () => {
      if (firstRun) {
        firstRun = false;
        return Promise.resolve({
          status: 'ready',
          run: async (ctx) => { ctx.emit({ type: 'task_start', input: 'A' }); ctx.emit({ type: 'task_end', reason: 'completed' }); },
        });
      }
      return Promise.resolve({
        status: 'ready',
        run: async (ctx) => {
          ctx.emit({ type: 'task_start', input: 'B' });
          await suspension; // B suspends mid-run
          ctx.emit({ type: 'assistant_text', content: 'B done' });
          ctx.emit({ type: 'task_end', reason: 'completed' });
        },
      });
    },
  });
  const a = w.runner.submit('A');
  await a.ended;
  const b = w.runner.submit('B');
  await tick(); // B emitted its own task_start and is now suspended
  w.emitForeign({ type: 'task_end', reason: 'completed' });                     // unstamped stray
  w.emitForeign({ type: 'task_end', taskId: a.id, reason: 'completed' });       // OLD task's identity
  w.emitForeign({ type: 'task_start', taskId: a.id, input: 'A-again' });        // would double-start B
  w.emitForeign({ type: 'tool_result', taskId: a.id, tool: 'bash', success: true, output: 'stale' });
  check('S11 foreign events during B running do not settle B',
    b.outcome() === null && w.runner.activeTask() === b, JSON.stringify(b.outcome()));
  releaseB();
  const outcomeB = await b.ended;
  check('S11 B completes with exactly its own single terminal after the foreign events',
    outcomeB.reason === 'completed'
    && w.events.filter((e) => e.type === 'task_end' && e.taskId === b.id).length === 1
    && w.events.filter((e) => e.type === 'task_start' && e.input === 'B').length === 1,
    JSON.stringify(w.events));
}

// ---------- S12 (F3): the quiesce gate closes admission synchronously ----------
{
  const w = wire({ prepare: () => Promise.resolve({ status: 'silent' }) });
  let ran1 = false;
  const m = w.runner.quiesceAndRun(async () => { ran1 = true; return 1; });
  check('S12 same-stack submit refused the instant quiesceAndRun is called',
    w.runner.submit('same-turn') === null);
  check('S12 same-stack refusal holds for the activeTask check too',
    w.runner.activeTask() === null && w.runner.submit('same-turn-2') === null);
  await m;
  const afterFirst = w.runner.submit('next');
  check('S12 action ran and admission reopened after it', ran1 === true && !!afterFirst);
  await afterFirst.ended;
}
{
  // Two queued mutations: no admission reopening between them.
  const w = wire({ prepare: () => Promise.resolve({ status: 'silent' }) });
  let release1;
  const gate1 = new Promise((r) => { release1 = r; });
  const order = [];
  const m1 = w.runner.quiesceAndRun(async () => { await gate1; order.push('a1'); return 1; });
  const m2 = w.runner.quiesceAndRun(async () => { order.push('a2'); return 2; });
  check('S12 submit refused while two mutations are queued', w.runner.submit('x') === null);
  release1();
  await m1;
  check('S12 submit STILL refused while the second queued mutation is pending',
    w.runner.submit('y') === null, JSON.stringify(order));
  await m2;
  check('S12 queued actions stay strictly serial', JSON.stringify(order) === '["a1","a2"]', JSON.stringify(order));
  const afterQueue = w.runner.submit('z');
  check('S12 admission reopens after the LAST queued action completes', !!afterQueue);
  await afterQueue.ended;
}
{
  // A throwing action must not corrupt the gate or the queue order.
  const w = wire({ prepare: () => Promise.resolve({ status: 'silent' }) });
  const order = [];
  const m1 = w.runner.quiesceAndRun(async () => { order.push('a1'); throw new Error('a1 failed'); })
    .then(() => 'ok', (e) => 'threw:' + e.message);
  const m2 = w.runner.quiesceAndRun(async () => { order.push('a2'); return 'a2-ok'; });
  check('S12 submit refused between a throwing and a queued action', w.runner.submit('x') === null);
  check('S12 the first action error propagates to its own caller', await m1 === 'threw:a1 failed');
  check('S12 the second action still runs, in order', (await m2) === 'a2-ok' && JSON.stringify(order) === '["a1","a2"]');
  const afterFailures = w.runner.submit('after-failures');
  check('S12 admission reopens after the failures', !!afterFailures);
  await afterFailures.ended;
}
{
  // An old task that never really ends: timeout must not run the action
  // and must not pretend the old task ended.
  let releaseRun;
  const suspension = new Promise((r) => { releaseRun = r; });
  const w = wire({
    prepare: () => Promise.resolve({
      status: 'ready',
      run: async () => { await suspension; }, // ignores the abort signal entirely
    }),
  });
  const a = w.runner.submit('hung');
  await tick();
  let actionRan = false;
  const m = w.runner.quiesceAndRun(async () => { actionRan = true; return 'never'; }, { timeoutMs: 60 });
  const qResult = await m.then(() => 'resolved', (e) => 'rejected:' + (e.code || e.name));
  check('S12 timeout rejects the mutation without running the action',
    qResult.indexOf('rejected') === 0 && actionRan === false, qResult);
  const endedEarly = await Promise.race([a.ended.then(() => true), delay(20).then(() => false)]);
  check('S12 timeout does not pretend the old task ended', endedEarly === false);
  check('S12 admission stays closed while the hung task is still active',
    w.runner.submit('during-hang') === null);
  releaseRun();
  await a.ended;
  const afterHang = w.runner.submit('after-hang');
  check('S12 admission reopens only when the hung task really ends', !!afterHang);
  await afterHang.ended;
}

// ---------- S13 (F4): one classification table for both failure forms ----------
{
  // Structured failed persistence error + concurrent cancel.
  const gate = deferred();
  const w = wire({
    prepare: () => gate.promise.then(() => {
      const e = new Error('required write failed');
      e.persistenceFailure = true;
      return { status: 'failed', error: e };
    }),
  });
  const handle = w.runner.submit('persist-vs-cancel');
  handle.cancel('user');
  gate.resolve();
  const outcome = await handle.ended;
  check('S13 structured persistence failure + cancel → persistence_error',
    outcome.reason === 'persistence_error'
    && w.events.some((e) => e.type === 'error' && e.code === 'persistence_write_failed')
    && w.events.filter((e) => e.type === 'task_end').length === 1
    && w.events[w.events.length - 1].reason === 'persistence_error', JSON.stringify(w.events));
}
{
  // Structured failed GENERIC error + cancel: honest failure wins, exactly
  // like the thrown form (S9 parity).
  const gate = deferred();
  const w = wire({
    prepare: () => gate.promise.then(() => ({ status: 'failed', error: new Error('prepare exploded') })),
  });
  const handle = w.runner.submit('generic-vs-cancel');
  handle.cancel('user');
  gate.resolve();
  const outcome = await handle.ended;
  check('S13 structured generic failure + cancel → error (thrown-form parity)',
    outcome.reason === 'error'
    && w.events.some((e) => e.type === 'error' && e.code === 'task_rejected'), JSON.stringify(w.events));
}
{
  // A thrown AbortError from a normal cancel is the CANCELLATION, not an
  // independent error.
  const w = wire({
    prepare: async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); },
  });
  const handle = w.runner.submit('abort-error');
  handle.cancel('user');
  const outcome = await handle.ended;
  check('S13 thrown AbortError + cancel → cancelled (never upgraded to error)',
    outcome.reason === 'cancelled'
    && w.events.some((e) => e.type === 'warning' && e.code === 'task_cancelled')
    && !w.events.some((e) => e.type === 'error'), JSON.stringify(w.events));
}
{
  // An explicit session-boundary cancel reason during preparation.
  const gate = deferred();
  const w = wire({
    prepare: () => gate.promise.then(() => ({ status: 'ready', run: async () => {} })),
  });
  const handle = w.runner.submit('explicit-boundary');
  handle.cancel('session_changed');
  gate.resolve();
  const outcome = await handle.ended;
  check('S13 explicit cancel(\'session_changed\') → session_changed',
    outcome.reason === 'session_changed'
    && w.events.some((e) => e.type === 'warning' && e.code === 'session_changed'), JSON.stringify(w.events));
}
{
  // Epoch change + concurrent cancel: the session boundary wins.
  let epoch = 1;
  const gate = deferred();
  const w = wire({
    prepare: () => gate.promise.then(() => ({ status: 'ready', run: async () => {} })),
    epoch: epoch,
  });
  const handle = w.runner.submit('epoch-vs-cancel');
  handle.cancel('user');
  w.setEpoch(2);
  gate.resolve();
  const outcome = await handle.ended;
  check('S13 epoch change + cancel → session_changed', outcome.reason === 'session_changed', outcome.reason);
}
{
  // A NECESSARY persistence failure after the termination intent is never
  // silently lost: it overrides the recorded reason before publication.
  const w = wire({
    prepare: () => Promise.resolve({
      status: 'ready',
      run: async (ctx) => {
        ctx.emit({ type: 'task_start', input: 'work' });
        ctx.emit({ type: 'task_end', reason: 'completed' }); // intent
        const e = new Error('final flush failed');
        e.persistenceFailure = true;
        throw e; // run-body tail
      },
    }),
  });
  const handle = w.runner.submit('late-persist');
  const outcome = await handle.ended;
  check('S13 post-intent persistence failure overrides to persistence_error',
    outcome.reason === 'persistence_error', JSON.stringify(w.events));
  check('S13 exactly one task_end, with the persistence error event present',
    w.events.filter((e) => e.type === 'task_end').length === 1
    && w.events.some((e) => e.type === 'error' && e.code === 'persistence_write_failed'), JSON.stringify(w.events));
}
{
  // Any other post-intent throw is surfaced as a warning; the recorded
  // reason stands.
  const w = wire({
    prepare: () => Promise.resolve({
      status: 'ready',
      run: async (ctx) => {
        ctx.emit({ type: 'task_start', input: 'work' });
        ctx.emit({ type: 'task_end', reason: 'completed' }); // intent
        throw new Error('tail boom');
      },
    }),
  });
  const handle = w.runner.submit('late-boom');
  const outcome = await handle.ended;
  check('S13 post-intent non-persistence throw keeps the recorded reason',
    outcome.reason === 'completed'
    && w.events.some((e) => e.type === 'warning' && e.code === 'task_aftermath_failed')
    && w.events.filter((e) => e.type === 'task_end').length === 1, JSON.stringify(w.events));
}

console.log('---');
console.log('task-runner.test.mjs: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
