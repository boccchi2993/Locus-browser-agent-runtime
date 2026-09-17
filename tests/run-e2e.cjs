// Minimal CDP runner for the runtime e2e page.
// The orchestrator owns Chrome; this module owns only the page connection.
const path = require('path');
const {
  connectToTarget,
  waitForPageTarget,
} = require('./helpers/chrome.cjs');

const DEFAULT_DEADLINE_MS = 280000;

async function runE2e(options = {}) {
  const chrome = options.chrome || {
    kind: 'chrome',
    executable: process.env.CHROME || null,
    port: Number(process.env.CDP_PORT || 0),
    pid: null,
    child: null,
  };
  const expectedUrl = options.expectedUrl
    || process.env.E2E_TARGET_URL
    || ('file:///' + path.join(__dirname, 'e2e.html').replace(/\\/g, '/'));
  const target = await waitForPageTarget(chrome, expectedUrl, {
    timeoutMs: options.targetTimeoutMs ?? 15000,
  });
  const cdp = await connectToTarget(target);
  const deadline = Date.now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);
  try {
    while (Date.now() < deadline) {
      const result = await cdp.send('Runtime.evaluate', {
        expression: "document.getElementById('out') ? document.getElementById('out').textContent : ''",
        returnByValue: true,
      });
      const text = (result?.result?.value) || '';
      if (/\nDONE$|E2E-FAIL/.test(text)) {
        console.log(text);
        return !text.includes('E2E-FAIL');
      }
      // This is a short polling yield after CDP is ready, not a readiness
      // contract; completion is always determined by the page condition.
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    console.log('TIMEOUT waiting for DONE');
    return false;
  } finally {
    cdp.close();
  }
}

if (require.main === module) {
  runE2e().then((ok) => { process.exitCode = ok ? 0 : 1; })
    .catch((error) => { console.error('RUNNER FAIL:', error && error.stack || error); process.exitCode = 1; });
}

module.exports = { runE2e };
