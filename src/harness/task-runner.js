// ============================================================
//  HARNESS TASK RUNNER (UI-independent ESM module)
//  Owns the TASK lifecycle extracted from src/ui/store.js in M1a:
//  one-active-task admission, the task-lifetime AbortController
//  (created before any async preparation step), prepare → run →
//  settle ordering with liveness checks, pre-run cancellation and
//  session-boundary outcomes, exactly-one task_start/task_end shape,
//  and the storage-mutation quiesce gate.
//  Contract: docs/REPOSITORY-SPLIT-CONTRACTS.md §2 (state machine)
//  and §3.4-Q1/Q2 (controller ownership, pre-run cancel).
//
//  This module knows NOTHING about Vue, the DOM, classic-script
//  globals (AgentSession / PythonRuntime / VFS / persistence) or the
//  Product conversation store. Everything concrete arrives via deps:
//
//    emit(event)              the single task-event sink (the Product
//                             projects it). The runner also observes
//                             the same stream through observeEvent()
//                             for start/end bookkeeping; observation
//                             is idempotent and never emits.
//    prepare(task)            Product preparation sequence. MUST
//                             self-check task.signal after its own
//                             awaits (the runner additionally guards
//                             after prepare resolves); returns a
//                             PrepareOutcome (below).
//    sessionEpoch()           current session-generation marker; a
//                             change after the task pinned its epoch
//                             is a session boundary for that task.
//    onTaskEnd(task, outcome) called EXACTLY once per task, before
//                             `ended` resolves — the place to release
//                             task-scoped bindings. Guard by task id:
//                             a late finish of an older task must not
//                             release a newer task's bindings.
//
//  PrepareOutcome:
//    { status: 'ready', run(ctx), epoch?, preRunStart?() }
//        run(ctx) starts the accepted work (ctx = {controller, signal});
//        the run body emits task_start … task_end through emit().
//        epoch pins the session generation this task belongs to AFTER
//        Product's own rebind (defaults: the epoch at submit time).
//        preRunStart() decides whether a PRE-RUN termination backfills
//        a task_start (Product projector semantics: only when the
//        bound conversation is still empty and idle).
//    { status: 'blocked', code, message, reason? }
//        preparation decided the task must not run; the runner emits
//        error {code, message} + task_end (reason || 'interrupted')
//        with NO task_start (matches today's raw-replay-blocked path).
//    { status: 'silent' }
//        rejected before any lifecycle event (the Product already
//        surfaced it); the task ends with { reason: 'rejected' } and
//        emits nothing.
//
//  Outcome reasons (single terminal truth):
//    completed | cancelled | session_changed | error |
//    persistence_error | interrupted | rejected
//  Priority when several conditions race: a THROWN error's class wins
//  over cancellation (persistence_error before error before the
//  cancelled/session_changed a liveness check would have picked) —
//  an honest failure report is never downgraded to "cancelled".
// ============================================================

const PREPARE_CANCELLED_MESSAGE = '任务已取消，尚未开始模型请求。';
const SESSION_CHANGED_MESSAGE = '会话已切换，丢弃本次任务的后续结果。';

function isPersistenceFailure(error) {
  return !!(error && (error.persistenceFailure || error.code === 'persistence_write_failed'
    || error.name === 'PersistenceError' || error.name === 'StorageClearError'));
}

function defaultId(seq) {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return 'task-' + seq + '-' + crypto.randomUUID();
  return 'task-' + seq + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

export function createTaskRunner(deps) {
  if (!deps || typeof deps.emit !== 'function') throw new Error('task runner: emit is required');
  if (typeof deps.prepare !== 'function') throw new Error('task runner: prepare is required');
  if (typeof deps.sessionEpoch !== 'function') throw new Error('task runner: sessionEpoch is required');

  const emit = deps.emit;
  const onTaskEnd = typeof deps.onTaskEnd === 'function' ? deps.onTaskEnd : null;

  let active = null;
  let submitSeq = 0;
  let mutationGateClosed = false;
  let mutationChain = Promise.resolve();

  // ---- handle construction (synchronous, before any async step) ----
  function createHandle(input, opts) {
    submitSeq++;
    const o = opts || {};
    const controller = new AbortController();
    const state = {
      id: typeof o.id === 'string' && o.id ? o.id : defaultId(submitSeq),
      input: input,
      controller: controller,
      signal: controller.signal,
      phase: 'preparing',
      started: false,
      settled: false,
      cancelRequested: false,
      cancelReason: null,
      epoch: null,
      submitEpoch: deps.sessionEpoch(),   // session generation at admission;
                                          // a ready-prepare without an explicit
                                          // epoch stays pinned to THIS one
      preRunStart: typeof o.preRunStart === 'function' ? o.preRunStart : null,
      outcomeValue: null,
      resolveEnded: null,
    };
    state.ended = new Promise((resolve) => { state.resolveEnded = resolve; });
    const handle = {
      get id() { return state.id; },
      get input() { return state.input; },
      get signal() { return state.signal; },
      get ended() { return state.ended; },
      phase: () => state.phase,
      cancelReason: () => state.cancelReason,
      outcome: () => state.outcomeValue,
      // Idempotent: only the FIRST call aborts the task controller, and
      // no call after the task ended has any effect.
      cancel(reason) {
        if (state.settled || state.cancelRequested) return false;
        state.cancelRequested = true;
        state.cancelReason = reason || 'cancelled';
        state.controller.abort();
        return true;
      },
    };
    state.handle = handle;   // settle() hands this to onTaskEnd
    return { handle: handle, state: state };
  }

  // ---- terminal bookkeeping (exactly once per task) ----
  function settle(task, outcome) {
    if (task.settled) return;
    task.settled = true;
    task.phase = 'ended';
    if (active && active.state === task) active = null;
    task.outcomeValue = outcome;
    if (onTaskEnd) onTaskEnd(task.handle, outcome);
    task.resolveEnded(outcome);
  }

  function emitStartIfPending(task) {
    if (task.started) return;
    task.started = true;
    emit({ type: 'task_start', input: task.input });
  }

  function emitTerminal(task, reason) {
    if (task.settled) return;
    emit({ type: 'task_end', reason: reason });
    settle(task, { reason: reason });
  }

  // Pre-run termination (nothing has run yet): backfill task_start only
  // when the Product's projector semantics ask for it.
  function terminatePreRun(task, reason) {
    if (task.settled) return;
    if (task.preRunStart) {
      let want = false;
      try { want = !!task.preRunStart(); } catch (e) { want = false; }
      if (want) emitStartIfPending(task);
    }
    if (reason === 'session_changed') {
      emit({ type: 'warning', code: 'session_changed', message: SESSION_CHANGED_MESSAGE });
      emitTerminal(task, 'session_changed');
      return;
    }
    emit({ type: 'warning', code: 'task_cancelled', message: PREPARE_CANCELLED_MESSAGE });
    emitTerminal(task, 'cancelled');
  }

  // Preparation or run failed: classify honestly, never downgrade to
  // cancelled even when a cancel is also pending. `preRunStart` (explicit
  // or the one the task already carries) decides the backfilled start.
  function failTask(task, error, preRunStart) {
    if (task.settled) return;
    const persistence = isPersistenceFailure(error);
    const startCheck = typeof preRunStart === 'function' ? preRunStart : task.preRunStart;
    if (startCheck) {
      let want = false;
      try { want = !!startCheck(); } catch (e) { want = false; }
      if (want) emitStartIfPending(task);
    }
    emit({
      type: 'error',
      code: persistence ? 'persistence_write_failed' : 'task_rejected',
      message: error && error.message ? error.message : String(error),
    });
    emitTerminal(task, persistence ? 'persistence_error' : 'error');
  }

  // ---- the driver: prepare → run → settle ----
  async function drive(task) {
    let prep = null;
    try {
      try {
        prep = await deps.prepare(task.handle);
      } catch (error) {
        failTask(task, error);
        return;
      }
      // Adopt the prepare outcome's pre-run-start predicate BEFORE any
      // liveness guard can terminate the task — a cancelled prepare still
      // backfills a task_start when the Product asks for it.
      if (prep && typeof prep.preRunStart === 'function') task.preRunStart = prep.preRunStart;
      // Runner-side liveness guard (Product prepare self-checks too).
      if (task.signal.aborted && !task.settled) {
        terminatePreRun(task, 'cancelled');
        return;
      }
      if (!prep || prep.status === 'silent') {
        settle(task, { reason: 'rejected' });
        return;
      }
      if (prep.status === 'blocked') {
        emit({ type: 'error', code: prep.code || 'task_prepare_blocked', message: prep.message || '' });
        emitTerminal(task, prep.reason || 'interrupted');
        return;
      }
      // Structured preparation failure: the Product reports the thrown
      // error plus (optionally) the pre-run-start predicate so the runner
      // can backfill a task_start exactly like the pre-run paths.
      if (prep.status === 'failed') {
        failTask(task, prep.error, prep.preRunStart);
        return;
      }
      if (prep.status !== 'ready' || typeof prep.run !== 'function') {
        emit({ type: 'error', code: 'task_prepare_invalid', message: 'prepare returned neither ready, blocked nor silent' });
        emitTerminal(task, 'error');
        return;
      }
      if (typeof prep.preRunStart === 'function') task.preRunStart = prep.preRunStart;
      // A ready-prepare may carry an explicit epoch when the Product rebind
      // the session during preparation (continuing an archived conversation
      // advances the generation legitimately); without one, the task stays
      // pinned to the session it was submitted into.
      task.epoch = prep.epoch !== undefined ? prep.epoch : task.submitEpoch;
      if (deps.sessionEpoch() !== task.epoch && !task.settled) {
        terminatePreRun(task, 'session_changed');
        return;
      }
      if (task.signal.aborted && !task.settled) {
        terminatePreRun(task, 'cancelled');
        return;
      }
      task.phase = 'running';
      try {
        await prep.run({ controller: task.controller, signal: task.signal });
        // The run body owns task_start…task_end; if it resolved without
        // a terminal event (unexpected), close honestly instead of
        // leaving a never-ending task.
        if (!task.settled) emitTerminal(task, 'completed');
      } catch (error) {
        if (!task.settled) failTask(task, error);
      }
    } finally {
      // A late finish of an older task must never clear a newer one.
      if (!task.settled) settle(task, { reason: 'error' });
    }
  }

  // ---- public surface ----
  function submit(input, opts) {
    if (active) return null;            // one active task per runner
    if (mutationGateClosed) return null; // storage mutation holds admission
    const created = createHandle(input, opts);
    active = created;
    drive(created.state);
    return created.handle;
  }

  function activeTask() {
    return active ? active.handle : null;
  }

  // Observe the product event pipeline (the same stream emit() feeds).
  // task_start/task_end bookkeeping for the CURRENT task only. A task_end
  // settles the active task ONLY after its own task_start was observed:
  // a late terminal of an ALREADY-ENDED task (which may still be flushing
  // through the pipeline while the next task is preparing) cannot settle
  // a task that has not started. This matches the single-session
  // invariant upstream (one AgentSession, one task at a time): a previous
  // task's tail events are flushed before the next run() body can emit
  // its own task_start.
  function observeEvent(event) {
    if (!active) return;
    const task = active.state;
    if (!event || typeof event.type !== 'string') return;
    if (event.type === 'task_start') task.started = true;
    else if (event.type === 'task_end' && task.started && !task.settled) {
      settle(task, { reason: event.reason });
    }
  }

  function storageMutationBlockedError() {
    const e = new Error('Storage action could not proceed because the running task did not stop.');
    e.name = 'StorageMutationBlockedError';
    e.code = 'active_task_did_not_stop';
    return e;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Storage-mutation gate: serializes mutations, closes admission for
  // the whole window, cancels the active task (preparation included)
  // and waits for its real end before the mutation runs. The gate is
  // released even when the action throws.
  async function quiesceAndRun(action, options) {
    const o = options || {};
    const timeoutMs = typeof o.timeoutMs === 'number' ? o.timeoutMs : 10000;
    const previous = mutationChain;
    let releaseChain;
    mutationChain = new Promise((resolve) => { releaseChain = resolve; });
    await previous;
    mutationGateClosed = true;
    try {
      const current = active;
      if (current) {
        current.handle.cancel(o.cancelReason || 'storage_mutation');
        const stopped = await Promise.race([current.state.ended.then(() => true), delay(timeoutMs).then(() => false)]);
        if (!stopped) throw storageMutationBlockedError();
      }
      return await action();
    } finally {
      mutationGateClosed = false;
      releaseChain();
    }
  }

  return { submit: submit, activeTask: activeTask, observeEvent: observeEvent, quiesceAndRun: quiesceAndRun };
}
