// Shared M2a test helper (repository split): the worker sources are
// RUNTIME assets — suites import them from src/runtime/worker-assets.js
// instead of scraping index.html, and build interpreter instances the way
// hosts do (explicit source, never a page DOM element). require(esm) is
// synchronous on this Node, so suites can use this at module scope.
const assets = require('../../src/runtime/worker-assets.js');

// A fresh interpreter instance wired exactly like a host builds one.
function freshRuntime(shellMod, opts) {
  return shellMod.createPythonRuntime(Object.assign({ pyWorkerSource: assets.PY_WORKER_SOURCE }, opts));
}

module.exports = { PY_WORKER_SOURCE: assets.PY_WORKER_SOURCE, GREP_WORKER_SOURCE: assets.GREP_WORKER_SOURCE, freshRuntime };
