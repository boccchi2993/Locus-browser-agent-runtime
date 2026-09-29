// Python interpreter lifecycle tests (M1b, repository split): the
// interpreter is an INSTANCE built by createPythonRuntime(), and its
// lifecycle is explicit (prepare / run / reset / dispose / snapshot).
//
//  LC1  prepare is pure configuration: no worker, no creator iframe, no
//       asset download; same key = no-op rebuild; key change = reset +
//       reconfigure; a null payload returns to the core-only runtime.
//  LC2  prepare is all-or-nothing: an invalid payload throws and leaves
//       the previously configured payload fully intact (never a
//       half-applied reset); a cancelled prepare applies nothing.
//  LC3  two instances share NOTHING mutable: pending map, queue, queued-run
//       set, plugin payload, disposed flag are per instance; reset(A) does
//       not touch B, dispose(A) does not touch B.
//  LC4  execution state: a run driven through a controlled worker fixture
//       resolves on ITS instance; reset during execution invalidates the
//       in-flight run (honest error, never committed into new state) and
//       drains queued runs; late worker messages after reset are dropped
//       and never resolve or mutate anything; the instance stays reusable.
//  LC5  dispose is idempotent, permanently refuses prepare/run/
//       configureExtensions, and keeps dropping late arrivals.
//  LC6  the shell executes python on the INJECTED instance (opts.
//       pythonRuntime), converges with prepare on the SAME object, and
//       fails loudly without one — no page-global anywhere.
//  LC7  snapshot() reports interpreter status, busy executions, extension
//       key and disposal state.
//
// Reset/contract notes these tests pin down: a reset/dispose kills the
// worker stack SYNCHRONOUSLY; the in-flight run's promise settles at its
// next await boundary — without a task signal it RESOLVES with `error` set
// (an honest failure report), with an aborted task signal it REJECTS as
// cancelled; a queued-but-unstarted run REJECTS with the boundary reason.
// The worker boundary is stubbed at the message level (same technique as
// shell.test.cjs); REAL browser python behavior is gated by the e2e python
// suites, which drive the SAME production instance through the app seam.
// Run: node tests/python-lifecycle.test.cjs

const fs = require('fs');
const path = require('path');

global.window = { location: { protocol: 'https:' }, addEventListener: () => {} };
global.document = { getElementById: () => null };

const src = ['telemetry.js', 'workspace.js', 'vfs.js', 'extensions.js', 'shell.js']
  .map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'))
  .join('\n;\n');
const M = eval(src + '\n;({ createPythonRuntime, runShellCommand, VirtualWorkspace, SHELL_COMMANDS });');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
const errText = (e) => String(e && e.message ? e.message : e);
process.on('unhandledRejection', (e) => { console.error('UNHANDLED:', e && e.stack || e); process.exit(3); });
const tick = () => new Promise((r) => setTimeout(r, 10));

// A payload matching the documented PluginPayload shape (extensions.js
// identity rules) with LEGACY synthetic files — enough for configure-time
// validation; no worker ever sees it in this suite.
function payload(key, pluginId) {
  return {
    key: key,
    modules: [{
      pluginId: pluginId || 'locus-test-plugin',
      imports: ['locus_test_plugin'],
      files: { '__init__.py': 'x = 1\n' },
    }],
  };
}

// Controlled worker fixture: the runtime believes a booted worker exists;
// the test decides when (and with what) each posted request resolves.
function attachControlledWorker(rt) {
  const log = [];
  rt._ensureWorker = async () => {};
  rt.worker = {
    postMessage(msg) { if (!rt.worker) { console.error(String(new Error().stack)); process.exit(3); } log.push(msg); },
  };
  return {
    log,
    resolve(msgId, result) {
      const p = rt._pending.get(msgId);
      if (!p) return false;
      clearTimeout(p.timer);
      rt._pending.delete(msgId);
      p.resolve(Object.assign({ stdout: '', stderr: '', error: null, files: [], deleted: [] }, result));
      return true;
    },
  };
}

async function run() {
  // ================= LC1. prepare is pure configuration =================
  {
    const domCalls = [];
    global.document = {
      getElementById: (id) => { domCalls.push('get:' + id); return null; },
      createElement: () => { throw new Error('prepare must not create DOM'); },
      body: { appendChild: () => { throw new Error('prepare must not attach DOM'); } },
    };
    const fetchCalls = [];
    const realFetch = global.fetch;
    global.fetch = (url) => { fetchCalls.push(String(url)); return Promise.reject(new Error('prepare must not fetch')); };
    try {
      const rt = M.createPythonRuntime();
      const first = await rt.prepare({ python: payload('env-a') });
      check('LC1 first prepare configures and reports the rebuild',
        first.rebuiltInterpreter === true && rt.extensionKey() === 'env-a', JSON.stringify(first));
      check('LC1b prepare never booted: status cold, no worker, no creator',
        rt.status === 'cold' && rt.worker === null && rt._creator === null && rt._boot === null,
        JSON.stringify(rt.snapshot()));
      check('LC1c prepare performed zero downloads', fetchCalls.length === 0, JSON.stringify(fetchCalls));
      // The only permitted DOM touch is the legacy #sb-python status write
      // (M2 replaces it with the status event); creating the creator iframe
      // or reading #py-worker-src is a boot — forbidden in prepare.
      check('LC1d prepare performed no boot-DOM work (no creator, no worker-src)',
        domCalls.every((c) => c === 'get:sb-python'), JSON.stringify(domCalls));

      const same = await rt.prepare({ python: payload('env-a') });
      check('LC1e same-key prepare is a no-op (no rebuild, config untouched)',
        same.rebuiltInterpreter === false && rt.extensionKey() === 'env-a', JSON.stringify(same));

      const changed = await rt.prepare({ python: payload('env-b') });
      check('LC1f key change rebuilds configuration',
        changed.rebuiltInterpreter === true && rt.extensionKey() === 'env-b', JSON.stringify(changed));

      const core = await rt.prepare({ python: null });
      check('LC1g null payload returns to the core-only runtime',
        core.rebuiltInterpreter === true && rt.extensionKey() === null && rt._extensions === null,
        JSON.stringify(core));
    } finally {
      global.fetch = realFetch;
      global.document = { getElementById: () => null };
    }
  }

  // ================= LC2. prepare is all-or-nothing =================
  {
    const rt = M.createPythonRuntime();
    await rt.prepare({ python: payload('env-good') });

    let threw = null;
    try {
      await rt.prepare({ python: { key: 'env-bad', modules: [{ pluginId: 'BAD ID WITH SPACES', imports: [] }] } });
    } catch (e) { threw = e; }
    check('LC2 invalid payload throws at configure time', !!threw, errText(threw));
    check('LC2b the previously configured payload survives intact',
      rt.snapshot().extensionKey === 'env-good'
        && rt._extensions.modules.length === 1
        && rt._extensions.modules[0].pluginId === 'locus-test-plugin',
      JSON.stringify(rt.snapshot()));

    // A cancelled prepare applies nothing (signal already aborted).
    const ac = new AbortController();
    ac.abort();
    let cancelled = null;
    try { await rt.prepare({ signal: ac.signal, python: payload('env-late') }); }
    catch (e) { cancelled = e; }
    check('LC2c a cancelled prepare is refused', !!cancelled, errText(cancelled));
    check('LC2d a cancelled apply never lands',
      rt.snapshot().extensionKey === 'env-good', JSON.stringify(rt.snapshot()));

    // Both refusal paths leave the instance REUSABLE.
    const after = await rt.prepare({ python: payload('env-next') });
    check('LC2e the instance stays reusable after refused prepares',
      after.rebuiltInterpreter === true && rt.extensionKey() === 'env-next', JSON.stringify(after));
  }

  // ============ LC3. two instances share nothing mutable ============
  {
    const a = M.createPythonRuntime();
    const b = M.createPythonRuntime();
    check('LC3 pending maps, queues, queued-run sets are distinct objects',
      a._pending !== b._pending && a._queue !== b._queue && a._queuedRuns !== b._queuedRuns,
      'state must be per instance');
    await a.prepare({ python: payload('env-a') });
    check('LC3b plugin configuration is per instance',
      a.extensionKey() === 'env-a' && b.extensionKey() === null && b._extensions === null,
      JSON.stringify({ a: a.extensionKey(), b: b.extensionKey() }));

    // Park one run on each instance, then reset A: B's run must stay
    // pending and resolvable, B's configuration untouched.
    const ctlA = attachControlledWorker(a);
    const ctlB = attachControlledWorker(b);
    const runA = a.run('A_CODE', null, { cwd: '/tmp' });
    const runB = b.run('B_CODE', null, { cwd: '/tmp' });
    await tick(); // both seats taken: the runs are IN FLIGHT on their instance
    check('LC3c both instances took their own request (ids are per-instance sequences)',
      ctlA.log.length === 1 && ctlB.log.length === 1,
      JSON.stringify({ a: ctlA.log.length, b: ctlB.log.length }));
    a.reset('lc3 reset A');
    const runAOut = await runA;
    check('LC3d A\u2019s in-flight run fails honestly with the reset reason (no throw, no commit)',
      runAOut && runAOut.error === 'lc3 reset A' && runAOut.written.length === 0,
      JSON.stringify(runAOut));
    check('LC3e B is untouched by reset(A): still pending',
      b._pending.size === 1 && b._queuedRuns.size === 0,
      JSON.stringify({ bPending: b._pending.size, bQueued: b._queuedRuns.size }));
    check('LC3f B\u2019s plugin payload is still null, A\u2019s still env-a',
      b.extensionKey() === null && a.extensionKey() === 'env-a',
      JSON.stringify({ a: a.extensionKey(), b: b.extensionKey() }));
    const resolvedB = ctlB.resolve(ctlB.log[0].id, { stdout: 'B-ok' });
    const runBOut = await runB;
    check('LC3g B\u2019s run still resolves normally after reset(A)',
      resolvedB === true && runBOut.stdout === 'B-ok', JSON.stringify(runBOut));

    // dispose(A) leaves B fully operational.
    a.dispose('lc3 dispose A');
    const runB2 = b.run('B_CODE_2', null, { cwd: '/tmp' });
    await tick();
    check('LC3h dispose(A) does not touch B: new run accepted on B',
      ctlB.log.length === 2 && b._pending.size === 1, JSON.stringify({ msgs: ctlB.log.length }));
    let disposedRunErr = null;
    try { await a.run('MORE', null, {}); } catch (e) { disposedRunErr = e; }
    check('LC3i A refuses runs after dispose while B keeps working',
      !!disposedRunErr && /disposed/.test(errText(disposedRunErr)), errText(disposedRunErr));
    ctlB.resolve(ctlB.log[1].id, { stdout: 'B2-ok' });
    check('LC3j B\u2019s second run resolves', (await runB2).stdout === 'B2-ok');
  }

  // ============ LC4. execution state, reset, late messages ============
  {
    const rt = M.createPythonRuntime();
    await rt.prepare({ python: payload('env-x') });
    let ctl = attachControlledWorker(rt);
    rt.status = 'ready';

    const run1 = rt.run('CODE1', null, { cwd: '/tmp' });
    await tick();
    const id1 = ctl.log[0].id;

    // A queued second run waits for the seat (serialization preserved).
    const run2 = rt.run('CODE2', null, { cwd: '/tmp' });
    check('LC4 second run is queued while the first holds the seat',
      ctl.log.length === 1 && rt._queuedRuns.size === 1,
      JSON.stringify({ msgs: ctl.log.length, queued: rt._queuedRuns.size }));
    check('LC4b a message for an unknown id resolves nothing',
      ctl.resolve(99999, {}) === false);

    // Reset DURING execution: the in-flight run settles with an honest
    // error report (its signal never aborted, so nothing was cancelled —
    // and nothing committed), the queued run is DRAINED with the boundary
    // reason, and the late worker reply for the old request can neither
    // resolve nor mutate anything.
    rt.reset('lc4 boundary');
    const out1 = await run1;
    const e2 = await run2.then(() => null, (e) => e);
    check('LC4c the in-flight run settles with the reset reason as its error',
      out1 && out1.error === 'lc4 boundary' && out1.written.length === 0 && out1.notPersisted.length === 0,
      JSON.stringify(out1));
    check('LC4d the queued run is drained with the reset reason (rejects)',
      !!e2 && /lc4 boundary/.test(errText(e2)), errText(e2));
    check('LC4e reset tears the interpreter down: no worker, nothing pending',
      rt.worker === null && rt.status === 'cold' && rt._pending.size === 0 && rt._queuedRuns.size === 0,
      JSON.stringify(rt.snapshot()));

    // The stale result for the OLD request id has nowhere to land.
    check('LC4f the stale result resolves nothing', ctl.resolve(id1, { stdout: 'STALE' }) === false);

    // The real late-message drop path: no creator iframe, so
    // _onWindowMessage must drop everything without state changes.
    let statusWrites = 0;
    const realSetStatus = rt._setStatus.bind(rt);
    rt._setStatus = (s) => { statusWrites++; return realSetStatus(s); };
    rt._onWindowMessage({ data: { type: 'result', id: id1, stdout: 'STALE' } });
    rt._onWindowMessage({ data: { type: 'status', status: 'ready' } });
    check('LC4g late window messages after reset mutate nothing',
      statusWrites === 0 && rt._pending.size === 0,
      JSON.stringify({ statusWrites, pending: rt._pending.size }));

    // The instance is reusable: a fresh run completes normally on the new
    // interpreter generation.
    ctl = attachControlledWorker(rt); // reassign: the old fixture’s log belongs to the previous worker generation
    const run3 = rt.run('CODE3', null, { cwd: '/tmp' });
    await tick();
    const id3 = ctl.log[0].id;
    ctl.resolve(id3, { stdout: 'fresh-ok' });
    const r3 = await run3;
    check('LC4h the instance is reusable after reset', r3.stdout === 'fresh-ok', JSON.stringify(r3));

    // Cancellation through the task signal: the run REJECTS as cancelled
    // (the signal's listener kills the worker; the post-await guard throws).
    const ac = new AbortController();
    const run4 = rt.run('CODE4', null, { cwd: '/tmp', signal: ac.signal });
    ac.abort();
    const e4 = await run4.then(() => null, (e) => e);
    check('LC4i cancellation through the task signal rejects the run', !!e4, errText(e4));
  }

  // ================= LC5. dispose is terminal and idempotent =================
  {
    const rt = M.createPythonRuntime();
    await rt.prepare({ python: payload('env-d') });
    const ctl = attachControlledWorker(rt);
    rt.status = 'ready';
    const run1 = rt.run('CODE1', null, { cwd: '/tmp' });
    const queued = rt.run('CODE2', null, { cwd: '/tmp' });
    await tick();
    const id1 = ctl.log[0].id;

    rt.dispose('lc5 teardown');
    const out1 = await run1;
    const e2 = await queued.then(() => null, (e) => e);
    check('LC5 dispose fails the in-flight run and drains the queued one',
      out1 && out1.error === 'python runtime disposed: lc5 teardown'
        && !!e2 && /lc5 teardown/.test(errText(e2)),
      JSON.stringify(out1) + ' | ' + errText(e2));
    check('LC5b the disposed snapshot reports the reason',
      rt.snapshot().disposed === 'python runtime disposed: lc5 teardown'
        && rt.status === 'cold' && rt.worker === null,
      JSON.stringify(rt.snapshot()));

    // Idempotent: a second dispose keeps the FIRST reason and does not throw.
    rt.dispose('a different reason');
    check('LC5c dispose is idempotent (first reason stands)',
      rt.snapshot().disposed === 'python runtime disposed: lc5 teardown',
      JSON.stringify(rt.snapshot().disposed));

    // Every entry refuses from here on.
    const refusals = {};
    try { await rt.prepare({ python: payload('env-after') }); } catch (e) { refusals.prepare = errText(e); }
    try { await rt.run('MORE', null, {}); } catch (e) { refusals.run = errText(e); }
    try { rt.configureExtensions(payload('env-after')); } catch (e) { refusals.configure = errText(e); }
    try { await M.createPythonRuntime()._ensureWorker.call(rt, null, null); } catch (e) { refusals.boot = errText(e); }
    check('LC5d prepare/run/configureExtensions/boot all refuse after dispose',
      /disposed/.test(refusals.prepare || '') && /disposed/.test(refusals.run || '')
        && /disposed/.test(refusals.configure || '') && /disposed/.test(refusals.boot || ''),
      JSON.stringify(refusals));
    check('LC5e the configuration never changed after dispose',
      rt.extensionKey() === 'env-d', rt.extensionKey());

    // Old messages do not revive the instance: a late worker result has no
    // pending entry to land in, and no status write can flip it back.
    check('LC5f the old pending id no longer resolves', ctl.resolve(id1, { stdout: 'GHOST' }) === false);
    let statusWrites = 0;
    const realSetStatus2 = rt._setStatus.bind(rt);
    rt._setStatus = (s) => { statusWrites++; return realSetStatus2(s); };
    rt._onWindowMessage({ data: { type: 'result', id: id1, stdout: 'GHOST' } });
    rt._onWindowMessage({ data: { type: 'status', status: 'ready' } });
    check('LC5g late messages after dispose revive nothing',
      statusWrites === 0 && rt.snapshot().interpreter === 'cold'
        && rt.snapshot().busyExecutions === 0,
      JSON.stringify(rt.snapshot()));

    // Dispose without a live worker (cold instance) is also safe.
    const cold = M.createPythonRuntime();
    cold.dispose('cold dispose');
    check('LC5h disposing a never-booted instance is safe and terminal',
      cold.snapshot().disposed === 'python runtime disposed: cold dispose'
        && cold.snapshot().interpreter === 'cold',
      JSON.stringify(cold.snapshot()));
  }

  // ============ LC6. shell executes on the injected instance ============
  {
    const shared = M.createPythonRuntime();
    const other = M.createPythonRuntime();
    const ctlShared = attachControlledWorker(shared);
    const ctlOther = attachControlledWorker(other);
    const vfs = new M.VirtualWorkspace({ listCommands: () => Object.keys(M.SHELL_COMMANDS) });

    const shellRun1 = M.runShellCommand("python -c 'print(1)'", vfs, { pythonRuntime: shared, cwd: '/tmp' });
    await tick();
    check('LC6 the shell routes python to the INJECTED instance only',
      ctlShared.log.length === 1 && ctlOther.log.length === 0,
      JSON.stringify({ shared: ctlShared.log.length, other: ctlOther.log.length }));
    ctlShared.resolve(ctlShared.log[0].id, { stdout: '1' });
    const res1 = await shellRun1;
    check('LC6b the injected instance\u2019s answer comes back through the shell',
      !res1.isError && res1.output.includes('1'), JSON.stringify(res1));

    const shellRun2 = M.runShellCommand("python -c 'print(2)'", vfs, { pythonRuntime: shared, cwd: '/tmp' });
    await tick();
    check('LC6c the second shell python call hits the same instance',
      ctlShared.log.length === 2 && ctlOther.log.length === 0,
      JSON.stringify({ shared: ctlShared.log.length, other: ctlOther.log.length }));
    ctlShared.resolve(ctlShared.log[1].id, { stdout: '2' });
    const res2 = await shellRun2;
    check('LC6d second answer resolves', !res2.isError && res2.output.includes('2'), JSON.stringify(res2));

    // Without an injected instance the shell fails loudly — no silent
    // fallback to any global (there is none).
    const noRt = await M.runShellCommand("python -c 'print(1)'", vfs, { cwd: '/tmp' });
    check('LC6e missing injection is an honest failure, never a fallback',
      !noRt.success && noRt.output.includes('no runtime instance injected'),
      JSON.stringify(noRt.output));
    const noRt2 = await M.runShellCommand('echo hi', vfs, {});
    check('LC6f non-python shell work never needs an instance',
      !noRt2.isError && noRt2.output === 'hi', JSON.stringify(noRt2.output));

    // prepare + shell execution converge on ONE instance (the product's
    // wiring contract, proven at the seam the store uses).
    const rt = M.createPythonRuntime();
    await rt.prepare({ python: payload('env-shared') });
    const ctl = attachControlledWorker(rt); // attach AFTER prepare: a rebuild kills any attached interpreter
    const vfs2 = new M.VirtualWorkspace({ listCommands: () => Object.keys(M.SHELL_COMMANDS) });
    const shellRun3 = M.runShellCommand("python <<'PY'\nprint('hi')\nPY", vfs2, { pythonRuntime: rt, cwd: '/tmp' });
    await tick();
    check('LC6g the shell python request reaches the SAME instance prepare configured',
      ctl.log.length === 1 && rt.extensionKey() === 'env-shared' && rt._pending.size === 1,
      JSON.stringify({ msgs: ctl.log.length, key: rt.extensionKey(), status: rt.status }));
    ctl.resolve(ctl.log[0].id, { stdout: 'hi' });
    const shellOut = await shellRun3;
    check('LC6h the prepared instance executes the shell command',
      !shellOut.isError && shellOut.output.includes('hi'), JSON.stringify(shellOut));
    rt.reset();
    check('LC6i the same object\u2019s reset is what the session boundary calls',
      rt.snapshot().interpreter === 'cold' && rt.worker === null, JSON.stringify(rt.snapshot()));
  }

  // ================= LC7. snapshot() =================
  {
    const rt = M.createPythonRuntime();
    check('LC7 cold snapshot', JSON.stringify(rt.snapshot())
      === JSON.stringify({ interpreter: 'cold', busyExecutions: 0, extensionKey: null, disposed: null }),
      JSON.stringify(rt.snapshot()));
    await rt.prepare({ python: payload('env-s') });
    const ctl = attachControlledWorker(rt);
    rt.status = 'ready';
    rt.status = 'ready';
    const r = rt.run('CODE', null, { cwd: '/tmp' });
    const q = rt.run('CODE2', null, { cwd: '/tmp' });
    await tick();
    check('LC7b busy snapshot counts in-flight + queued',
      rt.snapshot().busyExecutions === 2 && rt.snapshot().interpreter === 'ready'
        && rt.snapshot().extensionKey === 'env-s',
      JSON.stringify(rt.snapshot()));
    ctl.resolve(ctl.log[0].id, { stdout: 'ok' });
    await r;
    // A boundary landing AFTER the seat was taken but BEFORE the post still
    // invalidates the run (generation check): q rejects with the reason and
    // never reaches the (removed) worker.
    rt.reset();
    const qErr = await q.then(() => null, (e) => e);
    check('LC7c the boundary invalidated the not-yet-posted run',
      !!qErr && /python runtime reset/.test(errText(qErr)), errText(qErr));
    check('LC7d drained snapshot', rt.snapshot().busyExecutions === 0
      && rt.snapshot().interpreter === 'cold', JSON.stringify(rt.snapshot()));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
