// TEST-ONLY deterministic fake for the grep regex worker seam
// (GrepRegexRuntime._workerFactory). It runs the REAL worker source
// extracted from index.html inside a `vm` context, so unit tests exercise
// the shipped algorithm — not a copy of it — while remaining
// controllable: replies are delivered asynchronously, and tests can drop
// replies (timeout), crash the worker, or deliver stale replies after
// termination. Browser e2e always uses real Web Workers.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function grepWorkerSource() {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  const m = html.match(/<script type="text\/worker" id="grep-worker-src">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('grep-worker-src not found in index.html');
  return m[1];
}

let sourceCache = null;
function workerSource() {
  if (!sourceCache) sourceCache = grepWorkerSource();
  return sourceCache;
}

class FakeGrepWorker {
  constructor() {
    FakeGrepWorker.instances.push(this);
    this.terminated = false;
    this.crashed = false;
    this.terminateCount = 0;
    // Requests whose WORKER-SIDE dispatch is silently dropped (never
    // computed, never answered) — used to simulate a hanging regex scan.
    this.dropCmds = null;
    this.sent = []; // requests the shell posted, in order
    this.replies = []; // replies the fake worker produced
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    const self = {
      postMessage: (msg) => {
        this.replies.push(msg);
        setImmediate(() => {
          if (this.terminated || this.crashed) return;
          if (this.onmessage) this.onmessage({ data: msg });
        });
      },
    };
    vm.runInNewContext(workerSource(), { self: self });
    this._self = self;
  }

  postMessage(msg) {
    this.sent.push(msg);
    if (this.dropCmds && this.dropCmds.has(msg.cmd)) return;
    setImmediate(() => {
      if (this.terminated || this.crashed) return;
      if (this._self.onmessage) this._self.onmessage({ data: msg });
    });
  }

  terminate() {
    this.terminated = true;
    this.terminateCount++;
  }

  // Simulate a fatal worker error (real crash, load failure, …).
  crash() {
    this.crashed = true;
    if (this.onerror) this.onerror({ message: 'fake worker crash', preventDefault() {} });
  }

  // Deliver a reply through the terminated barrier — a stale message that
  // arrives after the session already settled must be ignored by the shell.
  lateDeliver(msg) {
    if (this.onmessage) this.onmessage({ data: msg });
  }
}
FakeGrepWorker.instances = [];

// Install the fake on the eval'd module's GrepRegexRuntime and reset the
// instance log. Returns FakeGrepWorker for per-test assertions.
function installGrepFakeWorker(M) {
  FakeGrepWorker.instances.length = 0;
  M.GrepRegexRuntime._workerFactory = () => new FakeGrepWorker();
  return FakeGrepWorker;
}

module.exports = { installGrepFakeWorker, FakeGrepWorker };
