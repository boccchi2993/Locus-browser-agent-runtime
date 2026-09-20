// Python authority tests (F04a): the model-generated code inside the Pyodide
// worker must have NO unmediated network path and NO user-driven package
// downloads. Like the grep-worker suite, these tests drive the REAL worker
// source extracted from index.html — the shipped artifact, not a mock.
//
//  PA1  the production path never calls loadPackagesFromImports(user code)
//  PA2  the declared runtime package policy exists (harness-owned list)
//  PA3  lockdown is applied BEFORE any user code executes
//  PA4  fetch denied to user code
//  PA5  XMLHttpRequest denied
//  PA6  WebSocket denied
//  PA7  Worker (nested-worker escape) denied
//  PA8  importScripts denied
//  PA9  eval/Function/loadPyodide denials (dynamic-JS escape closed)
//  PA10 py.loadPackage / loadPackagesFromImports neutered after bootstrap
//  PA11 a fresh worker (reset/recovery path) reapplies the lockdown
//  PA12 a retried bootstrap (fatal worker recovery path) reapplies the lockdown
//  PA13 a worker whose required primitives cannot lock fails CLOSED
//  plus: compute keeps working after the lockdown; prompt/docs contract.
// Run: node tests/python-authority.test.cjs

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script type="text\/worker" id="py-worker-src">([\s\S]*?)<\/script>/);
if (!m) { console.error('worker source not found in index.html'); process.exit(1); }
const workerSrc = m[1];

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

const DENY_MESSAGE = 'Python network access is disabled in Locus; use the shell curl command for HTTP/HTTPS';
const LOADER_MESSAGE = 'Python package loading is controlled by the Locus runtime';

// Fake Pyodide instance: enough FS surface for the protocol, plus a
// self-checking runPythonAsync that refuses to run user code unless the
// network lockdown is already in place (PA3).
function makeFakePy(calls, ctx) {
  const files = new Map([['/', 'DIR'], ['/tmp', 'DIR']]);
  return {
    _files: files,
    async loadPackage(pkgs) { calls.push('loadPackage:' + String(pkgs)); },
    async runPythonAsync(code) {
      const g = vm.runInContext('globalThis', ctx);
      const denied = !!g.fetch && g.fetch.__locusNetworkDenied === true;
      calls.push('py:' + String(code).slice(0, 24));
      if (String(code).indexOf('os.chdir') === -1 && !denied) {
        throw new Error('USER CODE RAN BEFORE LOCKDOWN');
      }
    },
    runPython() {},
    FS: {
      mkdirTree() {}, writeFile() {}, readFile() { return new Uint8Array(); },
      readdir() { return []; }, stat() { return { mode: 0, size: 0 }; },
      unlink() {}, chmod() {}, isDir() { return false; },
    },
    setStdout() {}, setStderr() {},
  };
}

// One worker context with the worker-global primitives a real Chrome
// DedicatedWorkerGlobalScope exposes (the lockdown must find and deny them).
// `omit` drops named primitives — used to prove the lockdown fails closed
// when a REQUIRED primitive cannot be locked.
function makeWorkerContext(loadPyodideImpl, posted, calls, omit) {
  omit = omit || [];
  const sandbox = {
    self: { postMessage(msg) { if (msg.type === 'result') posted.push(msg); } },
    importScripts() { calls.push('importScripts'); },
    loadPyodide: loadPyodideImpl,
    atob, btoa, TextEncoder, TextDecoder,
  };
  if (omit.indexOf('fetch') === -1) sandbox.fetch = function () { calls.push('fetch:RAN'); };
  if (omit.indexOf('XMLHttpRequest') === -1) sandbox.XMLHttpRequest = function () { calls.push('xhr:RAN'); };
  if (omit.indexOf('WebSocket') === -1) sandbox.WebSocket = function () { calls.push('ws:RAN'); };
  if (omit.indexOf('Worker') === -1) sandbox.Worker = function () { calls.push('worker:RAN'); };
  // The worker schedules an uncaught self-destruct throw on lockdown
  // failure (real Chrome: worker.onerror rebuilds the worker). Capture it.
  sandbox.setTimeout = (fn) => { try { fn(); } catch (e) { calls.push('selfdestruct:' + (e && e.message || e)); } };
  sandbox.clearTimeout = () => {};
  const c = vm.createContext(sandbox);
  vm.runInContext(workerSrc, c);
  return c;
}

async function postRun(c, code, cwd) {
  const msg = { id: 7, cmd: 'run', code: code || 'x', cwd: cwd || '/tmp', mounts: [] };
  await vm.runInContext(`self.onmessage({ data: ${JSON.stringify(msg)} })`, c);
}

async function waitForResult(posted) {
  for (let i = 0; i < 400 && !posted[0]; i++) await new Promise((r) => setTimeout(r, 5));
  if (!posted[0]) throw new Error('worker posted no result');
  return posted[0];
}

// Guest-side probe: what does a use of the primitive do now?
function guestTry(c, expr) {
  return vm.runInContext(`(function () {
    try { ${expr}; return 'ALLOWED'; }
    catch (e) { return 'DENIED: ' + (e && e.message || e); }
  })()`, c);
}

async function run() {
  // ---------- PA1: no user-driven package auto-loading ----------
  check('PA1 no loadPackagesFromImports call on user code',
    !/loadPackagesFromImports\s*\(/.test(workerSrc)
    && workerSrc.indexOf('await py.loadPackagesFromImports') === -1,
    'production source must never scan user imports for package downloads');
  check('PA1b loadPackagesFromImports exists only as a DENIED loader name',
    workerSrc.indexOf("'loadPackagesFromImports']") !== -1
    && workerSrc.indexOf('loadPackagesFromImports(') === -1, '');

  // ---------- PA2: declared runtime package policy ----------
  const pol = workerSrc.match(/const PYTHON_RUNTIME_PACKAGES = \[([^\]]*)\]/);
  check('PA2 fixed package policy exists as an auditable literal',
    !!pol && pol[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).join(',') === 'pandas',
    pol && pol[1]);

  // ---------- PA3-PA8 + denials: one boot, then the locked surface ----------
  const calls = [];
  const posted = [];
  const c = makeWorkerContext(async () => makeFakePy(calls, c), posted, calls);
  await postRun(c, "print('hi')");
  const r = await waitForResult(posted);
  check('PA3 boot succeeds and runs user code', !r.error, r.error);

  const order = calls.join(' | ');
  check('PA3b declared packages loaded at bootstrap, before user code',
    order.indexOf('loadPackage:pandas') !== -1
    && order.indexOf('loadPackage:pandas') < order.indexOf('py:print'), order);
  check('PA3c lockdown applied before user code (fake py self-check passed)',
    order.indexOf('USER CODE RAN BEFORE LOCKDOWN') === -1, order);

  // ---------- PA4-PA8: the denied network primitives ----------
  check('PA4 fetch denied', guestTry(c, "fetch('http://127.0.0.1:9/probe')")
    === 'DENIED: ' + DENY_MESSAGE, guestTry(c, "fetch('http://127.0.0.1:9/probe')"));
  check('PA5 XMLHttpRequest denied', guestTry(c, 'new XMLHttpRequest()')
    === 'DENIED: ' + DENY_MESSAGE, guestTry(c, 'new XMLHttpRequest()'));
  check('PA6 WebSocket denied', guestTry(c, "new WebSocket('ws://127.0.0.1:9/probe')")
    === 'DENIED: ' + DENY_MESSAGE, guestTry(c, "new WebSocket('ws://127.0.0.1:9/probe')"));
  check('PA7 nested Worker denied', guestTry(c, "new Worker('blob:probe')")
    === 'DENIED: ' + DENY_MESSAGE, guestTry(c, "new Worker('blob:probe')"));
  check('PA8 importScripts denied', guestTry(c, "importScripts('http://127.0.0.1:9/probe.js')")
    === 'DENIED: ' + DENY_MESSAGE, guestTry(c, "importScripts('http://127.0.0.1:9/probe.js')"));
  check('PA8b absent primitives are skipped, not fabricated',
    guestTry(c, 'typeof SharedWorker') === 'ALLOWED', guestTry(c, 'typeof SharedWorker'));

  // ---------- PA9: dynamic-JS escape denials ----------
  check('PA9 eval denied (dynamic-JS escape closed)', guestTry(c, "eval('1+1')")
    === 'DENIED: ' + DENY_MESSAGE, guestTry(c, "eval('1+1')"));
  check('PA9b Function stays native (Pyodide glue needs the global; see F04a-R1)',
    guestTry(c, "Function('return 1')()") === 'ALLOWED', guestTry(c, "Function('return 1')()"));
  check('PA9c loadPyodide denied (bootstrap not re-enterable)', guestTry(c, 'loadPyodide({})')
    === 'DENIED: ' + DENY_MESSAGE, guestTry(c, 'loadPyodide({})'));
  check('PA9d a property read of a denied primitive denies too',
    guestTry(c, "fetch('http://127.0.0.1:9/probe').call")
    === 'DENIED: ' + DENY_MESSAGE, guestTry(c, "fetch('http://127.0.0.1:9/probe').call"));

  // ---------- PA10: the neutered package loaders (JS instance level; the
  // Python-side pyodide.loadPackage route is proven in the browser e2e) ----
  check('PA10 py.loadPackage denied after bootstrap',
    guestTry(c, "py.loadPackage('regex')").startsWith('DENIED: ' + LOADER_MESSAGE),
    guestTry(c, "py.loadPackage('regex')"));
  check('PA10b py.loadPackagesFromImports denied after bootstrap',
    guestTry(c, "py.loadPackagesFromImports('import regex')").startsWith('DENIED: ' + LOADER_MESSAGE),
    guestTry(c, "py.loadPackagesFromImports('import regex')"));
  posted.length = 0;
  await postRun(c, "print('still-alive')");
  res = await waitForResult(posted);
  check('PA10c compute keeps working after the lockdown',
    !res.error, res.error);

  // ---------- PA11: fresh worker (reset/recovery) reapplies the lockdown ----
  const calls2 = [];
  const posted2 = [];
  const c2 = makeWorkerContext(async () => makeFakePy(calls2, c2), posted2, calls2);
  await postRun(c2, 'x');
  await waitForResult(posted2);
  check('PA11 a fresh worker applies the same lockdown',
    guestTry(c2, "fetch('http://127.0.0.1:9/probe')") === 'DENIED: ' + DENY_MESSAGE
    && guestTry(c2, "importScripts('http://127.0.0.1:9/probe.js')").startsWith('DENIED:'), '');

  // ---------- PA12: retried bootstrap (fatal recovery) reapplies lockdown ---
  const calls3 = [];
  const posted3 = [];
  let attempts = 0;
  const c3 = makeWorkerContext(async () => {
    attempts++;
    if (attempts === 1) throw new Error('temporary CDN failure');
    return makeFakePy(calls3, c3);
  }, posted3, calls3);
  await postRun(c3, 'x');
  const r3a = await waitForResult(posted3);
  check('PA12 failed bootstrap reports honestly and is not cached',
    !!r3a.error && r3a.error.includes('temporary CDN failure'), r3a.error);
  posted3.length = 0;
  await postRun(c3, 'x');
  await waitForResult(posted3);
  check('PA12b retried bootstrap reapplies the lockdown',
    attempts === 2 && guestTry(c3, "fetch('http://127.0.0.1:9/probe')") === 'DENIED: ' + DENY_MESSAGE, '');

  // ---------- PA13: lockdown failure is fail-closed, never half-locked ------
  const calls4 = [];
  const posted4 = [];
  const c4 = makeWorkerContext(async () => makeFakePy(calls4, c4), posted4, calls4, ['fetch']);
  await postRun(c4, 'x');
  const r4 = await waitForResult(posted4);
  check('PA13 a worker whose required primitives cannot lock fails closed',
    !!r4.error && r4.error.includes('Python worker failed to apply the network lockdown'), r4.error);
  check('PA13b a lockdown-failed worker schedules self-destruct (shell rebuilds)',
    calls4.some((c) => String(c).indexOf('selfdestruct:Python worker failed to apply the network lockdown') === 0),
    JSON.stringify(calls4));

  // ---------- prompt/docs contract (model-facing authority wording) ---------
  const shellSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'shell.js'), 'utf8');
  const agentSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent.js'), 'utf8');
  check('PA14 system prompt tells the model Python has no network path (use curl)',
    shellSrc.includes('Python has no network access') && shellSrc.includes('use curl for network'),
    'shell prompt must document the boundary');
  check('PA14b the old "Python can fetch" policy wording is gone',
    !agentSrc.includes('including Python code calling fetch directly'),
    'agent.js trust-boundary text must match the technical boundary');
  check('PA15 PYTHON_TIMEOUT_MS unchanged by F04a',
    shellSrc.includes('const PYTHON_TIMEOUT_MS = 30000;'), 'cancellation semantics out of scope');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e && e.stack || e); process.exit(1); });
