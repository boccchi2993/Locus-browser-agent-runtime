// ============================================================
//  LOCUS RUNTIME — PUBLIC ENTRY (M2a, repository split)
//
//  createRuntime → RuntimeHost → RuntimeSession: the importable
//  boundary the contract drafts (docs/REPOSITORY-SPLIT-CONTRACTS.md
//  §3.1/§3.6/§3.8) prescribe. Importing this module starts no worker,
//  downloads no Python and touches no DOM; createRuntime() validates
//  the injected worker assets; a session constructs its interpreter
//  instance lazily in every behavioral sense (prepare is pure
//  configuration; the first python execution boots).
//
//  A host needs exactly: this module + the runtime core classic
//  scripts (telemetry/workspace/vfs/network/shell — registered through
//  the declared __LOCUS_RUNTIME_CORE__ table) + the worker assets.
//  No Harness, no Product page, no Vue, no persistence.
//
//  WHAT A SESSION OWNS: one interpreter instance (createPythonRuntime —
//  all interpreter mutable state stays inside it, M1b), the status
//  listener fan-out and the prepare serialization tail. WHAT A REQUEST
//  CARRIES: the task-frozen execution context (filesystem, signal,
//  mutation policy, authorization port). The session never stores task
//  state, chat identity, model config or Vue references.
// ============================================================

// ---------- core resolution (declared Runtime-internal seam) ----------
// src/shell.js publishes this frozen table at load (see the registry
// block at the end of that file). Resolved LAZILY, at createRuntime()
// time: importing this entry must succeed even before the core loads.
function runtimeCore() {
  const core = globalThis.__LOCUS_RUNTIME_CORE__;
  if (!core || typeof core.createPythonRuntime !== 'function'
      || typeof core.runShellCommand !== 'function'
      || typeof core.runPythonCode !== 'function'
      || typeof core.VirtualWorkspace !== 'function') {
    throw new Error(
      'Locus runtime core not loaded: include src/shell.js (and the runtime'
      + ' classic scripts it builds on: telemetry/workspace/vfs/network) before createRuntime()');
  }
  return core;
}

function requireWorkerSource(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('createRuntime: workerAssets.' + name + ' (a non-empty worker source string) is required');
  }
  return value;
}

function cancelled(what) {
  const e = new Error(what + ' cancelled');
  e.name = 'AbortError';
  e.cancelled = true;
  return e;
}

// ---------- the entry ----------
export function createRuntime(opts) {
  const o = opts || {};
  const workerAssets = {
    pyWorkerSource: requireWorkerSource(o.workerAssets && o.workerAssets.pyWorkerSource, 'pyWorkerSource'),
    grepWorkerSource: requireWorkerSource(o.workerAssets && o.workerAssets.grepWorkerSource, 'grepWorkerSource'),
  };
  const core = runtimeCore();
  const sessions = new Set();
  let hostDisposed = null;

  const host = {
    contractVersion: 1,

    // Declared, checked capabilities (contract §5) — never version-guessed.
    capabilities() {
      return Object.freeze({
        contractVersion: 1,
        executionKinds: Object.freeze(['shell', 'python']),
        bootstrap: Object.freeze({ shaPinned: true }),
        policyMechanisms: Object.freeze(['mutationPolicy', 'authorization']),
      });
    },

    createSession() {
      if (hostDisposed) throw new Error(hostDisposed);
      const session = createRuntimeSession(core, workerAssets, () => sessions.delete(session));
      sessions.add(session);
      return session;
    },

    // Terminal for the whole host: disposes every session (idempotent —
    // a second dispose keeps the first reason; sessions dispose the same
    // way inside).
    dispose(reason) {
      const why = hostDisposed || ('runtime host disposed' + (reason ? ': ' + reason : ''));
      hostDisposed = why;
      for (const s of Array.from(sessions)) s.dispose(why);
      sessions.clear();
    },
  };
  return host;
}

// ---------- RuntimeSession ----------
function createRuntimeSession(core, workerAssets, onReleased) {
  // The ONE interpreter instance for this session (M1b lifecycle inside).
  const py = core.createPythonRuntime({ pyWorkerSource: workerAssets.pyWorkerSource });

  // ---- status fan-out ----
  // One pump subscription over the instance's event stream for the
  // session's lifetime; session listeners are fanned out from it. The
  // INSTANCE contains observer exceptions per listener already; the
  // session-side fan-out is a plain synchronous loop (the pump callback
  // itself never throws — a throwing listener would break the instance's
  // containment loop otherwise).
  const listeners = new Set();
  let unsubInstance = null;
  function ensurePump() {
    if (unsubInstance) return;
    // Subscribe BEFORE adding the listener so the instance's immediate
    // on-subscribe snapshot finds an empty set; the initial read is then
    // delivered exactly once by onStatus itself.
    unsubInstance = py.onStatus(() => {
      for (const fn of Array.from(listeners)) {
        try { fn(py.snapshot()); } catch (e) { /* contained: observer failure */ }
      }
    });
  }

  // Prepare serialization: concurrent prepares apply in call order.
  let prepareTail = Promise.resolve();
  // Terminal session state: set by dispose(); execute/prepare refuse with
  // this reason afterwards (the interpreter instance refuses on its own
  // too — this is the session-level expression of the same boundary).
  let sessionDisposed = null;

  const session = {
    // ---- between-task configuration (contract §3.1 prepare) ----
    // Waits for every execution in flight AT CALL TIME to settle (a
    // barrier of settlement promises — no timers, no busy polling, no
    // retry), then re-validates before applying ANYTHING:
    //   disposed            → throws the disposal reason;
    //   reset during wait   → throws the boundary reason, nothing applied;
    //   signal aborted      → the cancellation-shaped refusal (M1b form).
    // Only then the instance's synchronous validate-then-swap prepare
    // runs. A configuration can never land late for a task that died
    // while its prepare was waiting.
    prepare(req) {
      if (py._disposed) return Promise.reject(new Error(py._disposed));
      const signal = req && req.signal;
      if (signal && signal.aborted) return Promise.reject(cancelled('python preparation'));
      const generationBefore = py._resetGeneration;
      const inflight = py._inflightSettlement();
      // Cancellation plane registered SYNCHRONOUSLY at call time — a cancel
      // landing while this prepare waits for the serialization tail OR the
      // in-flight barrier must refuse it, never surface after the wait.
      let onAbort = null;
      const abortSettled = signal
        ? new Promise((resolve) => {
          onAbort = resolve;
          signal.addEventListener('abort', onAbort, { once: true });
        })
        : null;
      const prev = prepareTail;
      let release;
      prepareTail = new Promise((r) => { release = r; });
      const race = (p) => Promise.race(abortSettled ? [p, abortSettled] : [p]);
      const stopped = () => { if (signal && onAbort) signal.removeEventListener('abort', onAbort); };
      return (async () => {
        try {
          await race(prev);
          if (signal && signal.aborted) throw cancelled('python preparation');
          if (inflight) {
            await race(inflight);
            if (signal && signal.aborted) throw cancelled('python preparation');
          }
          // Post-barrier validation — the no-late-effect gate.
          if (py._disposed) throw new Error(py._disposed);
          if (py._resetGeneration !== generationBefore) {
            throw new Error('python runtime reset while preparation waited for in-flight executions; configuration not applied');
          }
          if (signal && signal.aborted) throw cancelled('python preparation');
          return py.prepare(req);
        } finally {
          stopped();
          release();
        }
      })();
    },

    // ---- the execution port ----
    // `context` is the task-frozen binding: filesystem (REQUIRED — the
    // caller's task fork), signal, mutationPolicy (Product policy; absent
    // = the neutral generic runtime), authorization (the §3.5 port),
    // cwd. The result is the honest tool-shaped report plus a normalized
    // `ok` (compute AND commit success; partial failure is never a
    // success — the underlying report keeps every field).
    async execute(req) {
      if (sessionDisposed) throw new Error(sessionDisposed);
      const kind = req && req.kind;
      const ctx = (req && req.context) || {};
      const opts = {
        signal: ctx.signal,
        mutationPolicy: ctx.mutationPolicy,
        authorization: ctx.authorization,
        // Runtime-internal injections: the session's OWN interpreter and
        // grep worker asset — a request can never execute on a foreign
        // instance or fetch its worker source from anywhere else.
        pythonRuntime: py,
        grepWorkerSource: workerAssets.grepWorkerSource,
        cwd: ctx.cwd,
      };
      if (kind === 'shell') {
        // filesystem OPTIONAL: absent → the shell's own fallback (a fresh
        // internal machine — the accepted asVfs semantics, unchanged).
        const res = await core.runShellCommand(req.input, ctx.filesystem, opts);
        return Object.assign({ ok: !res.isError }, res);
      }
      if (kind === 'python') {
        const res = await core.runPythonCode(req.input, ctx.filesystem, opts);
        return Object.assign({ ok: !!res.success }, res);
      }
      throw new Error('runtime execute: unsupported kind: ' + String(kind));
    },

    // ---- state reads + status subscription (contract §3.8) ----
    // Canonical snapshot; onStatus delivers the CURRENT snapshot
    // synchronously on subscribe (no missed-edge window, no polling),
    // then every change. Observer exceptions are contained per listener;
    // unsubscribe stops everything for that listener.
    status() {
      return py.snapshot();
    },
    onStatus(fn) {
      if (typeof fn !== 'function') return () => {};
      ensurePump();
      listeners.add(fn);
      try { fn(py.snapshot()); } catch (e) { /* contained: initial read */ }
      return () => { listeners.delete(fn); };
    },

    // ---- boundaries (M1b semantics, verbatim) ----
    reset(reason) {
      py.reset(reason);
    },
    dispose(reason) {
      const why = 'runtime session disposed' + (reason ? ': ' + reason : '');
      sessionDisposed = why;
      py.dispose(why);
      if (unsubInstance) { unsubInstance(); unsubInstance = null; }
      listeners.clear();
      if (onReleased) onReleased();
    },

    // Runtime-internal accessor for test/e2e seams ONLY (documented
    // users: window.__locus, Node suites). The product execution chain
    // goes through execute/prepare/reset/dispose — never through this.
    pythonRuntime() {
      return py;
    },
  };
  return session;
}
