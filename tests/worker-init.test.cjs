// Pyodide worker init recovery test (F14): a failed first load must NOT be
// cached forever — the next run retries. Extracts the REAL worker source
// from index.html and drives ensurePyodide with a stubbed loadPyodide.
// Run: node tests/worker-init.test.cjs

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script type="text\/worker" id="py-worker-src">([\s\S]*?)<\/script>/);
if (!m) { console.error('worker source not found in index.html'); process.exit(1); }

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

async function run() {
  let attempts = 0;
  const c = vm.createContext({
    self: {},
    importScripts() {},
    loadPyodide: async () => {
      attempts++;
      if (attempts === 1) throw new Error('temporary CDN failure');
      return { FS: { mkdirTree() {} } };
    },
  });
  vm.runInContext(m[1], c);

  // first attempt fails
  let e1 = null;
  try { await vm.runInContext('ensurePyodide()', c); } catch (e) { e1 = e; }
  check('W-I1 first load fails', e1 && e1.message === 'temporary CDN failure', e1 && e1.message);

  // second attempt must RETRY (not reuse the rejected promise)
  let py = null, e2 = null;
  try { py = await vm.runInContext('ensurePyodide()', c); } catch (e) { e2 = e; }
  check('W-I2 second attempt retries and succeeds', !e2 && !!py, e2 && e2.message);
  check('W-I3 loadPyodide actually attempted twice', attempts === 2, 'attempts=' + attempts);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
