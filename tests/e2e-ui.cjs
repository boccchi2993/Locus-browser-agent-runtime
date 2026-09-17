// Vue presentation e2e runner. Expects the built app served on the URL in
// E2E_APP_URL (tests/e2e.cjs arranges that), then drives the real UI through
// CDP.
const fs = require('fs');
const path = require('path');
const {
  closeChrome,
  connectToTarget,
  launchChrome,
  waitForCdp,
  waitForPageTarget,
  waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');

const APP_URL = process.env.E2E_APP_URL || 'http://127.0.0.1:4173/?e2e=1';

async function main() {
  const pageScript = fs.readFileSync(path.join(__dirname, 'e2e-ui-page.js'), 'utf8');
  let chrome;
  let cdp;
  try {
    chrome = await launchChrome(APP_URL, {
      chromePath: process.env.CHROME,
      label: 'presentation UI Chrome',
      extraArgs: ['--window-size=1440,900'],
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, APP_URL, { timeoutMs: 15000 });
    cdp = await connectToTarget(target);

    await waitForRuntimeCondition(cdp, '!!(window.__locus && document.querySelector(".app-shell"))', {
      process: chrome,
      phase: 'presentation-app-boot',
      description: 'Presentation app unavailable: window.__locus did not boot',
      timeoutMs: 15000,
    });
    const result = await cdp.send('Runtime.evaluate', {
      expression: pageScript,
      awaitPromise: true,
      returnByValue: true,
      timeout: 110000,
    });
    const report = result?.result?.value || ('NO REPORT: ' + JSON.stringify(result).slice(0, 500));
    console.log(report);
    process.exitCode = report.includes('E2E-UI-FAIL') || report.includes('NO REPORT') ? 1 : 0;
  } catch (error) {
    console.error('E2E-UI RUNNER FAIL: ' + (error && error.stack || error));
    process.exitCode = 1;
  } finally {
    try { cdp?.close(); } catch (e) {}
    if (chrome) {
      const cleanup = await closeChrome(chrome);
      if (!cleanup.exited) console.error('presentation UI Chrome did not exit after bounded cleanup');
      if (!cleanup.profileRemoved) console.error('presentation UI Chrome profile cleanup failed: ' + cleanup.profileError);
    }
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
