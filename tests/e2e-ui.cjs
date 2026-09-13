// Vue presentation e2e runner. Expects the BUILT app served on
// http://localhost:4173 (vite preview) — tests/e2e.cjs arranges that.
// Launches headless Chrome at ?e2e=1, waits for the app + test hooks,
// injects tests/e2e-ui-page.js and prints its report.
//
// Usage: node tests/e2e-ui.cjs
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP_URL = 'http://localhost:4173/?e2e=1';
const DEBUG_PORT = 9335;
const DEADLINE = Date.now() + 120000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pageScript = fs.readFileSync(path.join(__dirname, 'e2e-ui-page.js'), 'utf8');

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--user-data-dir=' + path.join(require('os').tmpdir(), 'locus-e2e-ui-' + Date.now()),
    '--remote-debugging-port=' + DEBUG_PORT,
    APP_URL,
  ], { stdio: 'ignore' });

  const cleanup = () => { try { chrome.kill(); } catch (e) {} };
  process.on('exit', cleanup);

  try {
    let target = null;
    while (Date.now() < DEADLINE) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
        target = list.find((t) => t.url.includes('e2e=1'));
        if (target) break;
      } catch (e) {}
      await sleep(400);
    }
    if (!target) throw new Error('app target not found (is vite preview running on :4173?)');

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

    // wait for the app + hooks
    let ready = false;
    while (Date.now() < DEADLINE) {
      const res = await send('Runtime.evaluate', {
        expression: '!!(window.__locus && document.querySelector(".app-shell"))',
        returnByValue: true,
      });
      if (res.result && res.result.value) { ready = true; break; }
      await sleep(400);
    }
    if (!ready) throw new Error('app did not boot (window.__locus missing)');

    const res = await send('Runtime.evaluate', {
      expression: pageScript,
      awaitPromise: true,
      returnByValue: true,
      timeout: 110000,
    });
    const text = (res.result && res.result.value) || ('NO REPORT: ' + JSON.stringify(res).slice(0, 500));
    console.log(text);
    process.exitCode = text.includes('E2E-UI-FAIL') || text.includes('NO REPORT') ? 1 : 0;
  } catch (e) {
    console.error('E2E-UI RUNNER FAIL: ' + (e && e.message || e));
    process.exitCode = 1;
  } finally {
    cleanup();
  }
}

main();
