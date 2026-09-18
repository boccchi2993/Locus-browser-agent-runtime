// Approval presentation e2e runner. Expects the built app served on the
// URL in E2E_APP_URL (tests/e2e.cjs arranges that), then drives the real
// ApprovalCard UI through CDP (tests/e2e-approval-page.js).
//
// Closure patch (F-A29/F-A30): after the main flow, replays a hostile
// long-content approval across the acceptance viewport matrix via
// CDP Emulation.setDeviceMetricsOverride (tests/e2e-approval-viewport-page.js)
// and probes NATIVE Tab order / Escape with real key events on the desktop
// viewport — synthetic KeyboardEvents cannot move native focus.
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
const VIEWPORTS = [
  { name: '360x800', width: 360, height: 800, mobile: true },
  { name: '390x844', width: 390, height: 844, mobile: true },
  { name: '412x915', width: 412, height: 915, mobile: true },
  { name: '768x1024', width: 768, height: 1024, mobile: false },
  { name: '1440x900', width: 1440, height: 900, mobile: false },
];

// Real-key probe at the last (desktop) viewport: the previous script left
// the page idle, so leave a long-content approval pending, then verify
// native Tab walks Deny → Allow once → Allow for this session → OUT of the
// card (no focus trap), and a real Escape denies.
async function tabProbe(cdp) {
  const out = [];
  const check = (name, cond, detail) =>
    out.push((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 200) : ''));
  const evalValue = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r && r.result && r.result.value;
  };
  const pressKey = async (key, code, vk) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
  };
  const activeInfo = () => evalValue(
    '(() => { const a = document.activeElement; return a ? (a.className + "::" + String(a.textContent || "").trim().slice(0, 30)) : "none"; })()');

  try {
    await evalValue(
      'window.__locus.approvals.requestTestPermission({ policyKey: "e2e:vp:tab", summary: "Tab order probe " + "k".repeat(1500) }); "requested"');
    await waitForRuntimeCondition(cdp, '!!document.querySelector(".approval-card")', {
      phase: 'tab-probe-card',
      description: 'Tab probe: long-content approval card did not appear',
      timeoutMs: 8000,
    });
    await pressKey('Tab', 'Tab', 9);
    const first = await activeInfo();
    check('T1 native Tab #1 lands on the scrollable body (keyboard-reachable overflow)',
      /approval-body/.test(first), first);
    await pressKey('Tab', 'Tab', 9);
    const second = await activeInfo();
    check('T2 native Tab #2 lands on Deny', /approval-btn/.test(second) && /Deny/.test(second), second);
    await pressKey('Tab', 'Tab', 9);
    const third = await activeInfo();
    check('T3 native Tab #3 lands on Allow once', /Allow once/.test(third), third);
    await pressKey('Tab', 'Tab', 9);
    const fourth = await activeInfo();
    check('T4 native Tab #4 lands on Allow for this session', /Allow for this session/.test(fourth), fourth);
    await pressKey('Tab', 'Tab', 9);
    const fifth = await activeInfo();
    check('T5 native Tab #5 leaves the card (no focus trap)',
      !/approval-btn/.test(fifth) && !/approval-card/.test(fifth), fifth);
    await pressKey('Escape', 'Escape', 27);
    const closed = await evalValue('!document.querySelector(".approval-card")');
    check('T6 real Escape still denies the approval', closed === true, String(closed));
  } catch (error) {
    out.push('FAIL tab probe threw | ' + (error && error.stack || error));
  }
  return out;
}

async function main() {
  const pageScript = fs.readFileSync(path.join(__dirname, 'e2e-approval-page.js'), 'utf8');
  const viewportScript = fs.readFileSync(path.join(__dirname, 'e2e-approval-viewport-page.js'), 'utf8');
  let chrome;
  let cdp;
  let failed = false;
  try {
    chrome = await launchChrome(APP_URL, {
      chromePath: process.env.CHROME,
      label: 'approval UI Chrome',
      extraArgs: ['--window-size=1440,900'],
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, APP_URL, { timeoutMs: 15000 });
    cdp = await connectToTarget(target);
    await waitForRuntimeCondition(cdp, '!!(window.__locus && window.__locus.approvals && document.querySelector(".app-shell"))', {
      process: chrome,
      phase: 'approval-app-boot',
      description: 'Approval e2e unavailable: window.__locus.approvals did not boot',
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
    if (report.includes('APPR-FAIL') || report.includes('NO REPORT')) failed = true;

    // ---------- closure: viewport matrix (fresh page per viewport) ----------
    await cdp.send('Page.enable');
    for (const vp of VIEWPORTS) {
      console.log('=== approval viewport ' + vp.name + ' ===');
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile,
      });
      await cdp.send('Page.navigate', { url: APP_URL });
      await waitForPageTarget(chrome, APP_URL, { timeoutMs: 15000 });
      await waitForRuntimeCondition(cdp, '!!(window.__locus && window.__locus.approvals && document.querySelector(".app-shell"))', {
        process: chrome,
        phase: 'approval-viewport-boot:' + vp.name,
        description: 'Approval viewport e2e unavailable at ' + vp.name,
        timeoutMs: 15000,
      });
      const vpResult = await cdp.send('Runtime.evaluate', {
        expression: viewportScript,
        awaitPromise: true,
        returnByValue: true,
        timeout: 110000,
      });
      const vpReport = vpResult?.result?.value || ('NO REPORT: ' + JSON.stringify(vpResult).slice(0, 500));
      console.log(vpReport);
      if (vpReport.includes('VP-FAIL') || vpReport.includes('NO REPORT')) failed = true;
    }

    // ---------- closure: native keyboard probe (desktop viewport) ----------
    console.log('=== approval native keyboard probe (1440x900) ===');
    for (const line of await tabProbe(cdp)) {
      console.log(line);
      if (line.startsWith('FAIL')) failed = true;
    }
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    console.error('E2E-APPROVAL RUNNER FAIL: ' + (error && error.stack || error));
    process.exitCode = 1;
  } finally {
    try { cdp?.close(); } catch (e) {}
    if (chrome) {
      const cleanup = await closeChrome(chrome);
      if (!cleanup.exited) console.error('approval UI Chrome did not exit after bounded cleanup');
      if (!cleanup.profileRemoved) console.error('approval UI Chrome profile cleanup failed: ' + cleanup.profileError);
    }
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
