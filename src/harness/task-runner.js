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
//                             for bookkeeping; observation is
//                             idempotent and never settles a task on
//                             its own.
//    prepare(task)            Product preparation sequence. MUST
//                             self-check task.signal after its own
//                             awaits (the runner additionally guards
//                             after prepare resolves); returns a
//                             PrepareOutcome (below).
//    sessionEpoch()           current session-generation marker; a
//                             change after the task pinned its epoch
//                             is a session boundary for that task.
//    finalizeTask(handle,     OPTIONAL necessary-finalize step, called
//                outcome)     EXACTLY once per task BEFORE the final
//                             task_end is published — the only phase
//                             whose failure may still CHANGE the
//                             outcome: a persistence failure here
//                             becomes the terminal `persistence_error`
//                             (never downgraded to a warning), while
//                             any other failure is contained and
//                             surfaced after publication as a
//                             `task_cleanup_failed` warning without
//                             changing the outcome. A thenable return
//                             is awaited; the single task_end, `ended`,
//                             admission and the storage gate all wait
//                             for it. Skip registration unless a write
//                             is PROVABLY a completion condition of the
//                             task — telemetry and optional UI saves
//                             are never necessary writes.
//    onTaskEnd(task, outcome) called EXACTLY once per task, AFTER the
//                             final task_end was published and BEFORE
//                             `ended` resolves — the place to release
//                             task-scoped bindings (the task→conversation
//                             map must still be ALIVE when the final
//                             task_end projects; release happens after).
//                             Callback roles:
//                             onTaskEnd MAY return a Promise; a
//                             thenable return is MUST-AWAIT cleanup
//                             (the runner awaits it before resolving
//                             `ended`, so admission and the storage
//                             quiesce gate cover it). A synchronous
//                             return is a plain observer. A throw (or
//                             a rejected cleanup Promise) never
//                             wedges the runner: it is contained,
//                             surfaced as a `task_cleanup_failed`
//                             warning, and `ended` still resolves.
//                             Guard by task id: a late finish of an
//                             older task must not release a newer
//                             task's bindings.
//
//  Task event identity (every event carries `taskId`):
//    Each task owns an unforgeable identity — the task id — captured
//    at EXECUTION START, never stamped "whoever is active now". The
//    runner stamps its own lifecycle emissions; the run body emits
//    through the task-bound sink handed to it as ctx.emit (the
//    Product passes it into AgentSession.run({ emit })). observeEvent
//    ignores any event whose taskId is not the active task's id, so a
//    late task_start/task_end/warning/tool_result of an OLD task can
//    neither settle nor pollute the new one. The marker lives on the
//    event envelope only — it never enters provider messages, and the
//    model protocol's toolCallId semantics are untouched.
//
//  PrepareOutcome:
//    { status: 'ready', run(ctx), epoch?, preRunStart?() }
//        run(ctx) starts the accepted work (ctx = {controller, signal,
//        emit}); the run body emits task_start … task_end through
//        ctx.emit. task_end handed to ctx.emit records the
//        termination intent — the runner publishes the single final
//        task_end itself once the run body has RETURNED (the real
//        completion boundary), so `ended`, admission and the storage
//        gate never open early.
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
//
//  Classification (one table for THROWN and STRUCTURED failures —
//  the Product reports failures via { status: 'failed', error } and
//  the runner owns the semantics):
//    1. persistence_error  a necessary persistence failure (either
//                          form) is never downgraded, not even by a
//                          concurrent cancel or session boundary, and
//                          never silently lost when it surfaces after
//                          a termination intent but before publication;
//    2. error              an honest independent (non-abort) failure
//                          beats a pending cancellation;
//    3. session_changed    an epoch change, an explicit
//                          cancel('session_changed') or an abort with
//                          that reason;
//    4. cancelled          everything else a plain cancel produces.
//    An AbortError thrown by a cancelled operation IS the
//    cancellation (classified by 3/4), never an independent error.
//
//  Effective epoch (one rule for thrown AND structured failures, at
//  ANY phase): the task's binding is `epoch` once pinned (ready
//  adoption) and `submitEpoch` before that — never the CURRENT epoch
//  read at failure time, which would mask a real boundary. During
//  preparation a Product-internal rebind is LEGITIMATE: the Product
//  adopts the rebound generation explicitly via handle.adoptEpoch()
//  at the rebind point, so a later failure compares against the
//  adopted value and is not misread as a boundary. With no explicit
//  adoption, a preparation-phase epoch change IS an external
//  session boundary and wins over a plain cancel.
//
//  Termination publication (staged — one task_end, one truth):
//    1. the run body returned/threw (or a pre-run decision) and the
//       termination intent is collected;
//    2. NECESSARY finalize runs (optional finalizeTask dep): a
//       persistence failure here REPLACES the outcome with
//       persistence_error before anything is published;
//    3. the single final task_end is published with the final
//       outcome (the Product task→conversation map is still alive
//       for this projection);
//    4. bindings are released and the end notification runs
//       (onTaskEnd): awaited, but its failures never change the
//       published outcome — contained as task_cleanup_failed;
//    5. admission is released and `ended` resolves. quiesce and the
//       next task wait for this whole necessary-completion boundary.
//  `ended` resolves after publication and both awaited phases;
//  admission (submit) and the storage quiesce gate key off this
//  same boundary — observing a terminal EVENT alone never reopens
//  admission.
// ============================================================

const PREPARE_CANCELLED_MESSAGE = '任务已取消，尚未开始模型请求。';
const SESSION_CHANGED_MESSAGE = '会话已切换，丢弃本次任务的后续结果。';

// M2c: the REAL outcome-reason enum of this runner, exported so the public
// entry's harnessCapabilities() declares the actual taskLifecycle semantics
// (contract §5 — declared from the implementation, never hand-copied).
// Any change here is a taskLifecycle port change and belongs in the public
// declaration.
export const TASK_OUTCOME_REASONS = Object.freeze([
  'completed', 'cancelled', 'session_changed', 'error',
  'persistence_error', 'iteration_limit', 'interrupted', 'rejected',
]);

export function isPersistenceFailure(error) {
  return !!(error && (error.persistenceFailure || error.code === 'persistence_write_failed'
    || error.name === 'PersistenceError' || error.name === 'StorageClearError'));
}

function isAbortError(error) {
  if (!error) return false;
  if (error.name === 'AbortError' || error.code === 'ABORT_ERR') return true;
  return typeof DOMException !== 'undefined' && error instanceof DOMException && error.code === 20;
}

// One effective-epoch rule for EVERY phase: the pinned binding once the
// ready adoption happened, the submit-time generation before that. Never
// the CURRENT epoch — reading that at failure time would compare the
// session with itself and mask a real boundary.
function effectiveEpoch(task) {
  return task.epoch !== null ? task.epoch : task.submitEpoch;
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
  const finalizeTask = typeof deps.finalizeTask === 'function' ? deps.finalizeTask : null;

  let active = null;
  let submitSeq = 0;
  let pendingMutations = 0;   // quiesce windows currently open; admission is
                              // closed whenever this is > 0 (F3: closed
                              // SYNCHRONOUSLY at the quiesce call itself)
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
      terminal: null,               // recorded termination intent, awaiting
                                    // publication at the real boundary (F1)
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
      // Explicit adoption of a REBOUND session generation during
      // preparation (the Product's intentional provider-session rebind).
      // This is the ONLY way a preparation-phase epoch change stops being
      // an external boundary: after adoption, failure classification
      // compares against the adopted value, so a legitimate recovery is
      // never misread as a session switch. Refused once the task is no
      // longer preparing or already settled; never overwrites the ready
      // adoption that follows.
      adoptEpoch(epoch) {
        if (state.settled || state.phase !== 'preparing') return false;
        if (epoch === undefined || epoch === null) return false;
        state.epoch = epoch;
        return true;
      },
    };
    state.handle = handle;   // complete() hands this to onTaskEnd
    return { handle: handle, state: state };
  }

  // ---- event identity stamping (F2) ----
  // The task id is captured at the SOURCE: the runner stamps its own
  // emissions with the terminating task's id, and the run body emits
  // through the per-task sink below. Nothing is ever stamped with
  // "whoever is active when the event arrives".
  function stampTask(task, event) {
    if (event.taskId === undefined) event.taskId = task.id;
    return event;
  }

  function emitFor(task, event) {
    emit(stampTask(task, event));
  }

  // The task-bound event sink handed to the run body as ctx.emit. It
  // captures the task identity at execution start; a task_end handed here
  // records the termination INTENT — publication happens once, at the real
  // completion boundary (F1).
  function taskBoundEmit(task) {
    return function boundEmit(event) {
      if (!event || typeof event.type !== 'string') return;
      if (event.type === 'task_end') {
        recordTerminalIntent(task, event.reason);
        return;
      }
      emitFor(task, event);
    };
  }

  function recordTerminalIntent(task, reason) {
    if (task.settled || task.terminal) return;   // first intent wins; single termination
    task.terminal = { reason: typeof reason === 'string' && reason ? reason : 'completed' };
  }

  // ---- termination publication, staged (S15) ----
  //   1. (caller) the run body returned/threw or a pre-run decision was
  //      made — the termination intent is collected;
  //   2. NECESSARY finalize (finalizeTask dep): awaited BEFORE the outcome
  //      is fixed; a persistence failure here REPLACES the outcome with
  //      persistence_error (never downgraded to a warning); any other
  //      failure is contained and surfaced after publication without
  //      changing the outcome;
  //   3. the single final task_end is published with the final outcome —
  //      the Product task→conversation map is still alive for this
  //      projection (its release belongs to phase 4);
  //   4. bindings released + end notification (onTaskEnd): awaited so
  //      admission and the storage gate cover it, but a throw/rejection
  //      never changes the published outcome — task_cleanup_failed;
  //   5. admission released, `ended` resolved. quiesce and the next task
  //      wait for this whole necessary-completion boundary.
  async function complete(task, outcome) {
    if (task.settled) return;
    task.settled = true;
    task.phase = 'ended';
    let cleanupFailure = null;
    if (finalizeTask && outcome.reason !== 'rejected') {   // 'rejected' ends silently (contract)
      try {
        const done = finalizeTask(task.handle, outcome);
        if (done && typeof done.then === 'function') await done;
      } catch (e) {
        if (isPersistenceFailure(e)) {
          outcome.reason = 'persistence_error';
          emitFor(task, {
            type: 'error', code: 'persistence_write_failed',
            message: e && e.message ? e.message : String(e),
          });
        } else {
          cleanupFailure = e;       // contained; surfaced below, outcome stands
        }
      }
    }
    task.outcomeValue = outcome;
    if (outcome.reason !== 'rejected') {          // 'rejected' emits nothing (contract)
      try {
        emitFor(task, { type: 'task_end', reason: outcome.reason });
      } catch (e) {
        cleanupFailure = cleanupFailure || e;     // a throwing sink must not wedge admission
      }
    }
    if (onTaskEnd) {
      try {
        const released = onTaskEnd(task.handle, outcome);
        if (released && typeof released.then === 'function') await released;  // must-await cleanup
      } catch (e) {
        cleanupFailure = cleanupFailure || e;
      }
    }
    if (cleanupFailure) {
      // Surfaced unstamped on purpose: the task binding may already be
      // released by onTaskEnd, so identity routing no longer applies.
      try {
        emit({
          type: 'warning', code: 'task_cleanup_failed',
          message: '任务收尾回调失败：' + (cleanupFailure && cleanupFailure.message ? cleanupFailure.message : String(cleanupFailure)),
        });
      } catch (e) { /* the sink itself is failing; admission is already protected */ }
    }
    if (active && active.state === task) active = null;
    task.resolveEnded(outcome);
  }

  function emitStartIfPending(task) {
    if (task.started) return;
    task.started = true;
    emitFor(task, { type: 'task_start', input: task.input });
  }

  function backfillStartIfWanted(task, startCheck) {
    if (task.started) return;
    const check = typeof startCheck === 'function' ? startCheck : task.preRunStart;
    if (!check) return;
    let want = false;
    try { want = !!check(); } catch (e) { want = false; }
    if (want) emitStartIfPending(task);
  }

  // Pre-run termination (nothing has run yet): backfill task_start only
  // when the Product's projector semantics ask for it.
  async function terminatePreRun(task, reason) {
    if (task.settled) return;
    backfillStartIfWanted(task);
    if (reason === 'session_changed') {
      emitFor(task, { type: 'warning', code: 'session_changed', message: SESSION_CHANGED_MESSAGE });
    } else {
      emitFor(task, { type: 'warning', code: 'task_cancelled', message: PREPARE_CANCELLED_MESSAGE });
    }
    await complete(task, { reason: reason });
  }

  // One classification for BOTH failure forms (thrown from prepare/run and
  // structured { status: 'failed', error }) — see the priority table in the
  // header. A concurrent cancel never downgrades 1 or 2; an AbortError is
  // the cancellation itself, never an independent error (F4). The epoch
  // comparison uses the EFFECTIVE binding (pinned, explicitly adopted rebind,
  // or submitEpoch) — so a preparation-phase boundary is detected too, while
  // a Product-internal rebind adopted via handle.adoptEpoch() is not misread
  // as one, and the CURRENT epoch is never read back into the task to mask
  // a real switch (S14).
  function classifyFailure(task, error) {
    if (isPersistenceFailure(error)) return 'persistence_error';
    if (isAbortError(error)) {
      if (task.cancelReason === 'session_changed') return 'session_changed';
      if (deps.sessionEpoch() !== effectiveEpoch(task)) return 'session_changed';
      return 'cancelled';
    }
    return 'error';
  }

  // Preparation or run failed: report honestly, backfilling the pre-run
  // start exactly like the pre-run paths when the Product asks for it.
  async function failTask(task, error, preRunStart) {
    if (task.settled) return;
    const reason = classifyFailure(task, error);
    backfillStartIfWanted(task, preRunStart);
    if (reason === 'persistence_error') {
      emitFor(task, {
        type: 'error', code: 'persistence_write_failed',
        message: error && error.message ? error.message : String(error),
      });
    } else if (reason === 'error') {
      emitFor(task, {
        type: 'error', code: 'task_rejected',
        message: error && error.message ? error.message : String(error),
      });
    } else if (reason === 'session_changed') {
      emitFor(task, { type: 'warning', code: 'session_changed', message: SESSION_CHANGED_MESSAGE });
    } else {
      emitFor(task, { type: 'warning', code: 'task_cancelled', message: PREPARE_CANCELLED_MESSAGE });
    }
    await complete(task, { reason: reason });
  }

  // Run-phase completion at the real boundary: the run body returned (or
  // threw). A recorded intent is honored; a NECESSARY persistence failure
  // discovered afterwards overrides it before the single publication and is
  // never silently lost (F1); any other post-intent throw is surfaced as a
  // warning without corrupting the terminal.
  async function finishRun(task, runError) {
    backfillStartIfWanted(task);
    if (task.terminal) {
      let reason = task.terminal.reason;
      if (runError && isPersistenceFailure(runError)) {
        emitFor(task, {
          type: 'error', code: 'persistence_write_failed',
          message: runError && runError.message ? runError.message : String(runError),
        });
        reason = 'persistence_error';
      } else if (runError) {
        emitFor(task, {
          type: 'warning', code: 'task_aftermath_failed',
          message: '任务终止后收尾失败：' + (runError && runError.message ? runError.message : String(runError)),
        });
      }
      await complete(task, { reason: reason });
      return;
    }
    if (runError) {
      await failTask(task, runError);
      return;
    }
    await complete(task, { reason: 'completed' });
  }

  // ---- the driver: prepare → run → settle ----
  async function drive(task) {
    let prep = null;
    try {
      try {
        prep = await deps.prepare(task.handle);
      } catch (error) {
        await failTask(task, error);
        return;
      }
      // Adopt the prepare outcome's pre-run-start predicate BEFORE any
      // classification or liveness guard — a cancelled prepare still
      // backfills a task_start when the Product asks for it.
      if (prep && typeof prep.preRunStart === 'function') task.preRunStart = prep.preRunStart;
      // A STRUCTURED failure classifies like a thrown one and BEFORE any
      // liveness guard: Product prepareTask reports { status: 'failed',
      // error } and the runner owns the semantics (F4 parity).
      if (prep && prep.status === 'failed') {
        await failTask(task, prep.error, prep.preRunStart);
        return;
      }
      // A ready prepare pins its (possibly rebound) epoch BEFORE the
      // liveness guards: an epoch change is a session boundary that wins
      // over a concurrent plain cancel (F4). This ready adoption is
      // authoritative — it subsumes any preparation-phase adoptEpoch()
      // call with the Product's final binding for this task.
      if (prep && prep.status === 'ready' && typeof prep.run === 'function') {
        task.epoch = prep.epoch !== undefined ? prep.epoch : task.submitEpoch;
        if (deps.sessionEpoch() !== task.epoch) {
          await terminatePreRun(task, 'session_changed');
          return;
        }
      }
      // Runner-side liveness guard (Product prepare self-checks too). An
      // explicit session-boundary cancel reason is honored here (F4).
      if (task.signal.aborted) {
        await terminatePreRun(task, task.cancelReason === 'session_changed' ? 'session_changed' : 'cancelled');
        return;
      }
      if (!prep || prep.status === 'silent') {
        await complete(task, { reason: 'rejected' });
        return;
      }
      if (prep.status === 'blocked') {
        emitFor(task, { type: 'error', code: prep.code || 'task_prepare_blocked', message: prep.message || '' });
        await complete(task, { reason: prep.reason || 'interrupted' });
        return;
      }
      if (prep.status !== 'ready' || typeof prep.run !== 'function') {
        emitFor(task, { type: 'error', code: 'task_prepare_invalid', message: 'prepare returned neither ready, blocked nor silent' });
        await complete(task, { reason: 'error' });
        return;
      }
      task.phase = 'running';
      let runError = null;
      try {
        await prep.run({ controller: task.controller, signal: task.signal, emit: taskBoundEmit(task) });
      } catch (error) {
        runError = error;
      }
      // The run body returned or threw — the real completion boundary.
      await finishRun(task, runError);
    } finally {
      // Safety net for runner-internal faults only: every normal path
      // completes explicitly above. A HUNG run body is NOT caught here —
      // its task honestly stays unfinished and quiesceAndRun reports it.
      if (!task.settled) await complete(task, { reason: 'error' });
    }
  }

  // ---- public surface ----
  function submit(input, opts) {
    if (active) return null;                 // one active task per runner
    if (pendingMutations > 0) return null;   // a storage-mutation window holds admission (F3)
    const created = createHandle(input, opts);
    active = created;
    drive(created.state);
    return created.handle;
  }

  function activeTask() {
    return active ? active.handle : null;
  }

  // Observe the product event pipeline (the same stream emit() feeds).
  // Bookkeeping for the CURRENT task only, and ONLY for events carrying
  // this task's identity (F2): a late/unstamped event of an ALREADY-ENDED
  // task — which may still be flushing through the pipeline while the next
  // task is preparing or even running — can neither settle nor pollute the
  // active task. task_end observation records the termination intent; the
  // publication and the completion boundary live in the driver (F1).
  function observeEvent(event) {
    if (!event || typeof event.type !== 'string') return;
    if (!active) return;
    const task = active.state;
    if (event.taskId !== task.id) return;
    if (event.type === 'task_start') task.started = true;
    else if (event.type === 'task_end') recordTerminalIntent(task, event.reason);
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
  // the whole window — SYNCHRONOUSLY, before the first await, and for as
  // long as ANY queued mutation is pending (F3) — cancels the active task
  // (preparation included) and waits for its real end (the `ended`
  // boundary, cleanup included) before the mutation runs. A timeout never
  // executes the action and never pretends the old task ended. The gate
  // is released even when the action throws.
  async function quiesceAndRun(action, options) {
    if (typeof action !== 'function') throw new Error('task runner: quiesceAndRun requires an action');
    const o = options || {};
    const timeoutMs = typeof o.timeoutMs === 'number' ? o.timeoutMs : 10000;
    pendingMutations++;
    const previous = mutationChain;
    let releaseChain;
    mutationChain = new Promise((resolve) => { releaseChain = resolve; });
    try {
      await previous;                        // storage actions stay strictly serial
      const current = active;
      if (current) {
        current.handle.cancel(o.cancelReason || 'storage_mutation');
        const stopped = await Promise.race([current.state.ended.then(() => true), delay(timeoutMs).then(() => false)]);
        if (!stopped) throw storageMutationBlockedError();
      }
      return await action();
    } finally {
      pendingMutations--;
      releaseChain();
    }
  }

  return { submit: submit, activeTask: activeTask, observeEvent: observeEvent, quiesceAndRun: quiesceAndRun };
}
