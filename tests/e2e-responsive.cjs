// Responsive presentation e2e runner. Expects the BUILT app served on
// http://localhost:4173 (vite preview) — tests/e2e.cjs arranges that.
//
// Launches ONE headless Chrome tab and replays it across the acceptance
// viewports via CDP Emulation.setDeviceMetricsOverride, navigating fresh
// (?e2e=1) for each so the app boots at that exact size:
//
//   360x800 / 390x844 / 412x915   mobile   (<700px)
//   768x1024                      tablet   (700–1099px)
//   1440x900                      desktop  (>=1100px)
//
// At each viewport tests/e2e-responsive-page.js is injected; afterwards a
// screenshot of the filled page lands in .ui-review/ (gitignored, local QA
// only). Mobile viewports get a second screenshot with the sidebar drawer
// open.
//
// Usage: node tests/e2e-responsive.cjs
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = process.env.CHROME
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP_URL = 'http://localhost:4173/?e2e=1';
const DEBUG_PORT = 9337;
const DEADLINE = Date.now() + 180000;
const SHOT_DIR = path.join(__dirname, '..', '.ui-review');

const VIEWPORTS = [
  { name: 'mobile-360x800', width: 360, height: 800, mobile: true },
  { name: 'mobile-390x844', width: 390, height: 844, mobile: true },
  { name: 'mobile-412x915', width: 412, height: 915, mobile: true },
  { name: 'tablet-768x1024', width: 768, height: 1024, mobile: false },
  { name: 'desktop-1440x900', width: 1440, height: 900, mobile: false },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pageScript = fs.readFileSync(path.join(__dirname, 'e2e-responsive-page.js'), 'utf8');
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--user-data-dir=' + path.join(os.tmpdir(), 'locus-e2e-resp-' + Date.now()),
    '--remote-debugging-port=' + DEBUG_PORT,
    'about:blank',
  ], { stdio: 'ignore' });

  const cleanup = () => { try { chrome.kill(); } catch (e) {} };
  process.on('exit', cleanup);

  let failed = 0;
  try {
    let target = null;
    while (Date.now() < DEADLINE && !target) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch (e) {}
      if (!target) await sleep(400);
    }
    if (!target) throw new Error('chrome target not found');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
    const send = (method, params) => new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    await new Promise((r) => ws.addEventListener('open', r));
    await send('Page.enable');

    for (const vp of VIEWPORTS) {
      if (Date.now() > DEADLINE) throw new Error('deadline exceeded before ' + vp.name);
      console.log('=== viewport ' + vp.name + ' ===');
      await send('Emulation.setDeviceMetricsOverride', {
        width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile,
      });
      await send('Page.navigate', { url: APP_URL });

      // wait for the app + hooks at THIS viewport
      let ready = false;
      while (Date.now() < DEADLINE) {
        const res = await send('Runtime.evaluate', {
          expression: '!!(window.__locus && document.querySelector(".app-shell"))',
          returnByValue: true,
        });
        if (res.result && res.result.value) { ready = true; break; }
        await sleep(300);
      }
      if (!ready) throw new Error('app did not boot at ' + vp.name);

      const res = await send('Runtime.evaluate', {
        expression: pageScript,
        awaitPromise: true,
        returnByValue: true,
        timeout: 60000,
      });
      const text = (res.result && res.result.value) || ('NO REPORT: ' + JSON.stringify(res).slice(0, 500));
      console.log(text);
      if (text.includes('RESP-FAIL') || text.includes('NO REPORT')) failed++;

      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOT_DIR, vp.name + '.png'), Buffer.from(shot.data, 'base64'));

      if (vp.mobile) {
        await send('Runtime.evaluate', {
          expression: 'window.__locus.actions.openSidebarDrawer()',
        });
        await sleep(350);
        const dshot = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(SHOT_DIR, vp.name + '-drawer.png'), Buffer.from(dshot.data, 'base64'));
        await send('Runtime.evaluate', {
          expression: 'window.__locus.actions.closeDrawers()',
        });
        await sleep(150);
      }
    }
  } catch (e) {
    console.error('E2E-RESPONSIVE RUNNER FAIL: ' + (e && e.message || e));
    failed++;
  } finally {
    cleanup();
  }
  console.log('===');
  console.log(failed ? 'responsive e2e FAILED (' + failed + ')' : 'responsive e2e passed');
  process.exitCode = failed ? 1 : 0;
}

main();
