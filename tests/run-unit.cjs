// Runs every Node unit suite sequentially. No internet required.
// Usage: node tests/run-unit.cjs   (npm test)
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  'model.test.cjs',
  'model-adapters.test.cjs',
  'proxy.test.mjs',
  'fetch.test.mjs',
  'network.test.cjs',
  'workspace.test.cjs',
  'shell.test.cjs',
  'shell-compat.test.cjs',
  'shell-compat2.test.cjs',
  'agent.test.cjs',
  'presentation.test.cjs',
  'conversation-routing.test.mjs',
  'worker-init.test.cjs',
  'worker-output.test.cjs',
];

let failed = 0;
for (const s of SUITES) {
  const r = spawnSync(process.execPath, [path.join(__dirname, s)], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed++;
    console.error('SUITE FAIL: ' + s);
  }
}
console.log('---');
console.log(failed ? failed + ' suite(s) FAILED' : 'all ' + SUITES.length + ' suites passed');
process.exit(failed ? 1 : 0);
