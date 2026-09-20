// Runs every Node unit suite sequentially. No internet required.
// Usage: node tests/run-unit.cjs   (npm test)
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  'model.test.cjs',
  'model-adapters.test.cjs',
  'persistence.test.cjs',
  'persistence-audit.test.cjs',
  'provider-replay-persistence.test.cjs',
  'opfs-workspace.test.cjs',
  'proxy.test.mjs',
  'fetch.test.mjs',
  'network.test.cjs',
  'network-runtime.test.cjs',
  'runtime-visibility.test.cjs',
  'workspace.test.cjs',
  'vfs.test.cjs',
  'shell.test.cjs',
  'shell-compat.test.cjs',
  'shell-compat2.test.cjs',
  'shell-compat3.test.cjs',
  'agent.test.cjs',
  'approval.test.cjs',
  'agent-approval.test.cjs',
  'native-tools.test.cjs',
  'presentation.test.cjs',
  'store-defaults.test.cjs',
  'conversation-routing.test.mjs',
  'submit-presentation.test.mjs',
  'worker-init.test.cjs',
  'worker-output.test.cjs',
  'vfs-audit.test.cjs',
  'attachments.test.cjs',
  'capabilities.test.cjs',
  'image-probe.test.cjs',
  'model-adapters-image.test.cjs',
  'agent-image.test.cjs',
  'chrome-helper.test.cjs',
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
