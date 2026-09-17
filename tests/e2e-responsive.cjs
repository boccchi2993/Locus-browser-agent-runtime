// Responsive presentation e2e runner. Expects the built app served on the
// URL in E2E_APP_URL (tests/e2e.cjs arranges that).
//
// Launches one isolated headless Chrome tab and replays it across acceptance
// viewports via CDP Emulation.setDeviceMetricsOverride.
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
const SHOT_DIR = path.join(__dirname, '..', '.ui-review');
const VIEWPORTS = [
  { name: 'mobile-360x800', width: 360, height: 800, mobile: true },
  { name: 'mobile-390x844', width: 390, height: 844, mobile: true },
  { name: 'mobile-412x915', width: 412, height: 915, mobile: true },
  { name: 'tablet-768x1024', width: 768, height: 1024, mobile: false },
  { name: 'desktop-1440x900', width: 1440, height: 900, mobile: false },
];

async function main() {
  const pageScript = fs.readFileSync(path.join(__dirname, 'e2e-responsive-page.js'), 'utf8');
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  let chrome;
  let cdp;
  let failed = 0;
  try {
    chrome = await launchChrome('about:blank', {
      chromePath: process.env.CHROME,
      label: 'responsive Chrome',
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const initialTarget = await waitForPageTarget(chrome, 'about:blank', { timeoutMs: 15000 });
    cdp = await connectToTarget(initialTarget);
    await cdp.send('Page.enable');

    for (const vp of VIEWPORTS) {
      console.log('=== viewport ' + vp.name + ' ===');
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile,
      });
      await cdp.send('Page.navigate', { url: APP_URL });
      await waitForPageTarget(chrome, APP_URL, { timeoutMs: 15000 });
      await waitForRuntimeCondition(cdp, '!!(window.__locus && document.querySelector(".app-shell"))', {
        process: chrome,
        phase: 'responsive-app-boot:' + vp.name,
        description: 'Responsive app unavailable at ' + vp.name,
        timeoutMs: 15000,
      });

      const result = await cdp.send('Runtime.evaluate', {
        expression: pageScript,
        awaitPromise: true,
        returnByValue: true,
        timeout: 60000,
      });
      const report = result?.result?.value || ('NO REPORT: ' + JSON.stringify(result).slice(0, 500));
      console.log(report);
      if (report.includes('RESP-FAIL') || report.includes('NO REPORT')) failed++;

      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOT_DIR, vp.name + '.png'), Buffer.from(shot.data, 'base64'));

      if (vp.mobile) {
        await cdp.send('Runtime.evaluate', { expression: 'window.__locus.actions.openSidebarDrawer()' });
        await new Promise((resolve) => setTimeout(resolve, 350));
        const drawerShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(SHOT_DIR, vp.name + '-drawer.png'), Buffer.from(drawerShot.data, 'base64'));
        await cdp.send('Runtime.evaluate', { expression: 'window.__locus.actions.closeDrawers()' });
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  } catch (error) {
    console.error('E2E-RESPONSIVE RUNNER FAIL: ' + (error && error.stack || error));
    failed++;
  } finally {
    try { cdp?.close(); } catch (e) {}
    if (chrome) {
      const cleanup = await closeChrome(chrome);
      if (!cleanup.exited) console.error('responsive Chrome did not exit after bounded cleanup');
      if (!cleanup.profileRemoved) console.error('responsive Chrome profile cleanup failed: ' + cleanup.profileError);
    }
  }
  console.log('===');
  console.log(failed ? 'responsive e2e FAILED (' + failed + ')' : 'responsive e2e passed');
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
